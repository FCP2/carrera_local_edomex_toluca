require("dotenv").config();
const express = require("express");
const path = require("path");
const pool = require("./db");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CUPO_MAX = Number(process.env.CUPO_MAX || 1500);
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || "8M-2026-";


function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function cleanPhone(s) {
  return String(s || "").replace(/[^\d+]/g, "").trim();
}
function anySaludTrue(b) {
  return !!(b.enf_cronica || b.prob_cardiacos || b.prob_respiratorios || b.tratamiento_actual || b.alergias_meds);
}

async function verifyTurnstile(token, ip) {
  const form = new URLSearchParams();
  form.append("secret", process.env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  return r.json();
}

app.get("/api/status", async (req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM registros_8m_5k");
  const total = rows[0]?.total ?? 0;
  res.json({
    ok: true,
    cupo_max: CUPO_MAX,
    registrados: total,
    disponibles: Math.max(0, CUPO_MAX - total),
    cerrado: total >= CUPO_MAX,
  });
});

// AGREGAR ESTE ENDPOINT (antes de app.post("/api/registros"))
app.get("/api/municipios", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id_municipio, nombre FROM municipios_edomex ORDER BY nombre"
    );
    res.json({ ok: true, municipios: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: "Error cargando municipios" });
  }
});

app.post("/api/registros", async (req, res) => {
  const b = req.body || {};

  const nombre_completo = String(b.nombre_completo || "").trim();
  const fecha_nacimiento = String(b.fecha_nacimiento || "").trim();
  const edad = Number(b.edad);

  const email = String(b.email || "").trim();
  const emailNorm = email.toLowerCase(); // ✅ normalizado una vez

  const telefono = cleanPhone(b.telefono);

  const contacto_emergencia_nombre = String(b.contacto_emergencia_nombre || "").trim();
  const contacto_emergencia_tel = cleanPhone(b.contacto_emergencia_tel);

  const acepta_responsiva = !!b.acepta_responsiva;
  const acepta_privacidad = !!b.acepta_privacidad;

  const genero = String(b.genero || "").trim();

  const es_foranea = !!b.es_foranea;

  let id_municipio = null;
  let estado = null;
  let ciudad = null;

  if (es_foranea) {
    estado = String(b.estado || "").trim();
    ciudad = String(b.ciudad || "").trim();

    if (!estado || estado.length < 2) {
      return res.status(400).json({ ok:false, msg:"Captura tu Estado." });
    }
    if (!ciudad || ciudad.length < 2) {
      return res.status(400).json({ ok:false, msg:"Captura tu Ciudad/Alcaldía/Municipio." });
    }
  } else {
    id_municipio = Number(b.id_municipio);
    if (!Number.isFinite(id_municipio) || id_municipio < 1) {
      return res.status(400).json({ ok:false, msg:"Selecciona municipio válido." });
    }
  }

  if (!nombre_completo || nombre_completo.length < 5) return res.status(400).json({ ok:false, msg:"Nombre inválido." });
  if (!fecha_nacimiento) return res.status(400).json({ ok:false, msg:"Fecha nacimiento requerida." });
  if (!Number.isFinite(edad) || edad < 1 || edad > 100) {
    return res.status(400).json({ ok:false, msg:"Edad inválida." });
  }

  const es_menor = !!b.es_menor || edad < 18;

  const tutor_nombre = String(b.tutor_nombre || "").trim();
  const tutor_telefono = cleanPhone(b.tutor_telefono);

  if (edad < 18) {
    if (!tutor_nombre || tutor_nombre.length < 5) {
      return res.status(400).json({ ok:false, msg:"Captura el nombre del padre/madre/tutor." });
    }
    if (!tutor_telefono || tutor_telefono.length < 10) {
      return res.status(400).json({ ok:false, msg:"Captura un teléfono válido del tutor." });
    }
  }

  if (!isEmail(emailNorm)) return res.status(400).json({ ok:false, msg:"Email inválido." });
  if (!telefono || telefono.length < 10) return res.status(400).json({ ok:false, msg:"Teléfono inválido." });
  if (!contacto_emergencia_nombre || !contacto_emergencia_tel || contacto_emergencia_tel.length < 10)
    return res.status(400).json({ ok:false, msg:"Contacto de emergencia incompleto." });
  if (!acepta_responsiva || !acepta_privacidad) return res.status(400).json({ ok:false, msg:"Debes aceptar responsiva y privacidad." });

  if (!genero) {
    return res.status(400).json({ ok:false, msg:"Selecciona género." });
  }

  const salud_detalle = String(b.salud_detalle || "").trim();
  if (anySaludTrue(b) && salud_detalle.length < 5)
    return res.status(400).json({ ok:false, msg:"Describe tu condición médica (obligatorio si marcaste alguna)." });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .toString().split(",")[0].trim();

  if (!b.turnstile_token) {
    return res.status(400).json({ ok:false, msg:"Completa el captcha." });
  }

  const captcha = await verifyTurnstile(b.turnstile_token, ip);
  if (!captcha?.success) {
    return res.status(403).json({ ok:false, msg:"Captcha inválido. Intenta de nuevo." });
  }

  const talla_playera = (String(b.talla_playera || "").trim().toUpperCase() || null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ✅ 1) pre-check duplicado ANTES de nextval (evita brinco en pruebas)
    const dupEmail = await client.query(
      `SELECT 1 FROM registros_8m_5k WHERE lower(email) = $1 LIMIT 1`,
      [emailNorm]
    );
    if (dupEmail.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok:false, msg:"Este correo ya está registrado." });
    }

    // cupo
    const cupo = await client.query("SELECT COUNT(*)::int AS total FROM registros_8m_5k");
    if (cupo.rows[0].total >= CUPO_MAX) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok:false, msg:"Cupo lleno. Registro cerrado." });
    }

    // ✅ 2) SOLO si todo está OK, ahora sí pedir secuencias
    const seq = await client.query("SELECT nextval('seq_folio_8m_2026') AS n");
    const folio = `${FOLIO_PREFIX}${String(seq.rows[0].n).padStart(4, "0")}`;

    const seqRunner = await client.query("SELECT nextval('seq_num_corredora_8m_2026') AS n");
    const numero_corredora = Number(seqRunner.rows[0].n);

    const q = `
      INSERT INTO registros_8m_5k (
        folio, numero_corredora,
        nombre_completo, fecha_nacimiento, edad,
        es_menor, tutor_nombre, tutor_telefono,
        curp, id_municipio, es_foranea, estado, ciudad,
        telefono, email,
        contacto_emergencia_nombre, contacto_emergencia_tel,
        tipo_sangre, talla_playera,
        enf_cronica, prob_cardiacos, prob_respiratorios, tratamiento_actual, alergias_meds, salud_detalle,
        participo_antes, constancia_digital,
        acepta_responsiva, acepta_privacidad,
        ip_registro, genero
      ) VALUES (
        $1,$2,
        $3,$4,$5,
        $6,$7,$8,
        $9,$10,$11,$12,$13,
        $14,$15,
        $16,$17,
        $18,$19,
        $20,$21,$22,$23,$24,$25,
        $26,$27,
        $28,$29,
        $30,$31
      )
      RETURNING folio, numero_corredora, created_at
    `;

    const params = [
      folio, numero_corredora,
      nombre_completo, fecha_nacimiento, edad,
      es_menor,
      tutor_nombre || null,
      tutor_telefono || null,
      b.curp ? String(b.curp).trim() : null,
      id_municipio,
      es_foranea,
      estado,
      ciudad,
      telefono,
      emailNorm,
      contacto_emergencia_nombre,
      contacto_emergencia_tel,
      b.tipo_sangre ? String(b.tipo_sangre).trim().toUpperCase() : null,
      talla_playera,
      !!b.enf_cronica,
      !!b.prob_cardiacos,
      !!b.prob_respiratorios,
      !!b.tratamiento_actual,
      !!b.alergias_meds,
      (salud_detalle || null),
      !!b.participo_antes,
      !!b.constancia_digital,
      acepta_responsiva,
      acepta_privacidad,
      (ip || null),
      genero
    ];

    const ins = await client.query(q, params);
    await client.query("COMMIT");

      const numero = ins.rows[0].numero_corredora;

      let aviso_extra = null;

      if (numero > 1000) {
        aviso_extra = "Aviso: Los kits oficiales del evento fueron asignados a las primeras 1000 corredoras registradas. Tu registro sigue siendo válido y podrás participar en la carrera.";
      }

      res.json({
        ok: true,
        folio: ins.rows[0].folio,
        numero_corredora: numero,
        created_at: ins.rows[0].created_at,
        aviso_extra
      });
      
  } catch (err) {
    await client.query("ROLLBACK");

    // (se mantiene tu manejo por constraint para el caso de concurrencia real)
    if (String(err?.code) === "23505") {
      const c = err?.constraint || "";
      if (c === "uq_registros8m_email") return res.status(409).json({ ok:false, msg:"Este correo ya está registrado." });
      return res.status(409).json({ ok:false, msg:"Registro duplicado (dato único ya existe)." });
    }

    console.error(err);
    res.status(500).json({ ok:false, msg:"Error interno." });
  } finally {
    client.release();
  }
});

//ver disponibilidad d eplayeras endpoint
app.get("/api/playeras", async (req, res) => {
  const r = await pool.query(`
    SELECT talla, stock_disponible
    FROM playeras_stock
    WHERE stock_disponible > 0
    ORDER BY 
      CASE talla
        WHEN 'CH' THEN 1
        WHEN 'M' THEN 2
        WHEN 'G' THEN 3
      END;
  `);

  res.json({ ok:true, tallas:r.rows });
});
//pdf carta

const fs = require("fs");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

function drawBadge(page, { x, y, w, h, text, font, size = 12 }) {
  page.drawRectangle({
    x, y, width: w, height: h,
    color: rgb(0.91, 0.24, 0.53),       // rosa
    borderColor: rgb(0.75, 0.12, 0.39), // borde rosa fuerte
    borderWidth: 1,
    borderRadius: 10                   // si falla, quítalo (ver nota)
  });

  page.drawText(text, {
    x: x + 14,
    y: y + (h - size) / 2 - 1,
    size,
    font,
    color: rgb(1, 1, 1)
  });
}

app.get("/api/carta", async (req, res) => {
  try {
    const folio = String(req.query.folio || "").trim();
    if (!folio) return res.status(400).send("Folio requerido");

    const r = await pool.query(
      `SELECT folio, numero_corredora, nombre_completo, talla_playera, created_at
       FROM registros_8m_5k
       WHERE folio = $1`,
      [folio]
    );
    if (!r.rows.length) return res.status(404).send("Registro no encontrado");

    const row = r.rows[0];

    const pdfPath = path.join(__dirname, "assets", "carta_compromiso.pdf");
    const existingPdfBytes = fs.readFileSync(pdfPath);

    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    if (pages.length < 2) {
      return res.status(500).send("El PDF base no tiene 2 páginas.");
    }

    const page2 = pages[1]; // ✅ SOLO hoja 2

    // Formato fecha/hora CDMX
    const fecha = new Date(row.created_at).toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });

    // ✅ Layout vertical (ajusta y si quieres más arriba/abajo)
    const x = 60;
    let y = 420;     // << mueve este para subir/bajar el bloque
    const w = 480;
    const h = 34;
    const gap = 10;

    // Título arriba (opcional)
    page2.drawText("DATOS DE REGISTRO", {
      x,
      y: y + 60,
      size: 14,
      font,
      color: rgb(0.55, 0.05, 0.25)
    });

    drawBadge(page2, { x, y, w, h, text: `FOLIO: ${row.folio}`, font, size: 14 });
    y -= (h + gap);

    drawBadge(page2, { x, y, w, h, text: `NO. DE REGISTRO: ${row.numero_corredora}`, font, size: 14 });
    y -= (h + gap);

    // Nombre puede ser largo: si es muy largo, baja size
    const nombre = String(row.nombre_completo || "").trim();
    const nombreSize = nombre.length > 35 ? 10 : 12;
    drawBadge(page2, { x, y, w, h, text: `NOMBRE: ${nombre}`, font, size: nombreSize });
    y -= (h + gap);

    drawBadge(page2, { x, y, w, h, text: `TALLA (estadística): ${row.talla_playera || "N/A"}`, font, size: 12 });
    y -= (h + gap);


    const out = await pdfDoc.save();

    // opcional: marcar descargada
    await pool.query(
      `UPDATE registros_8m_5k
       SET carta_descargada = true, carta_descargada_at = now()
       WHERE folio = $1`,
      [folio]
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Carta_${row.folio}.pdf"`);
    res.send(Buffer.from(out));
  } catch (e) {
    console.error(e);
    res.status(500).send("Error generando PDF");
  }
});

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 1000;

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);
});
