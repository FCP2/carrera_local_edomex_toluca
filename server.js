require("dotenv").config();
const express = require("express");
const path = require("path");
const pool = require("./db");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CUPO_MAX = Number(process.env.CUPO_MAX || 1000);
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
  if (!Number.isFinite(edad) || edad < 18) return res.status(400).json({ ok:false, msg:"Solo mayores de edad (18+)." });
  if (!isEmail(email)) return res.status(400).json({ ok:false, msg:"Email inválido." });
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

  // talla (solo si aún hay stock; si no selecciona, queda null)
  const talla_playera = (String(b.talla_playera || "").trim().toUpperCase() || null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // cupo
    const cupo = await client.query("SELECT COUNT(*)::int AS total FROM registros_8m_5k");
    if (cupo.rows[0].total >= CUPO_MAX) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok:false, msg:"Cupo lleno. Registro cerrado." });
    }


    // Playera: descontar inventario solo si eligió talla
    if (talla_playera) {
      const check = await client.query(
        `SELECT stock_disponible FROM playeras_stock WHERE talla = $1 FOR UPDATE`,
        [talla_playera]
      );

      if (!check.rows.length || Number(check.rows[0].stock_disponible) <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok:false, msg:"La talla seleccionada ya se agotó." });
      }

      await client.query(
        `UPDATE playeras_stock
         SET stock_disponible = stock_disponible - 1
         WHERE talla = $1`,
        [talla_playera]
      );
    }

    // folio / corredora
    const seq = await client.query("SELECT nextval('seq_folio_8m_2026') AS n");
    const folio = `${FOLIO_PREFIX}${String(seq.rows[0].n).padStart(4, "0")}`;

    const seqRunner = await client.query("SELECT nextval('seq_num_corredora_8m_2026') AS n");
    const numero_corredora = Number(seqRunner.rows[0].n);

    const q = `
      INSERT INTO registros_8m_5k (
        folio, numero_corredora,
        nombre_completo, fecha_nacimiento, edad,
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
        $6,$7,$8,$9,$10,
        $11,$12,
        $13,$14,
        $15,$16,
        $17,$18,$19,$20,$21,$22,
        $23,$24,
        $25,$26,
        $27,$28
      )
      RETURNING folio, numero_corredora, created_at
    `;

    const params = [
      folio, numero_corredora,                              // $1..$2
      nombre_completo, fecha_nacimiento, edad,              // $3..$5
      b.curp ? String(b.curp).trim() : null,                // $6
      id_municipio,                                         // $7  (puede ser null si es foránea)
      es_foranea,                                           // $8
      estado,                                               // $9  (null si no es foránea)
      ciudad,                                               // $10 (null si no es foránea)
      telefono,                                             // $11
      email.toLowerCase(),                                  // $12
      contacto_emergencia_nombre,                           // $13
      contacto_emergencia_tel,                              // $14
      b.tipo_sangre ? String(b.tipo_sangre).trim().toUpperCase() : null, // $15
      talla_playera,                                        // $16
      !!b.enf_cronica,                                      // $17
      !!b.prob_cardiacos,                                   // $18
      !!b.prob_respiratorios,                               // $19
      !!b.tratamiento_actual,                               // $20
      !!b.alergias_meds,                                    // $21
      (salud_detalle || null),                              // $22
      !!b.participo_antes,                                  // $23
      !!b.constancia_digital,                               // $24
      acepta_responsiva,                                    // $25
      acepta_privacidad,                                    // $26
      (ip || null),                                         // $27
      genero                                                // $28
    ];

    const ins = await client.query(q, params);
    await client.query("COMMIT");

    res.json({
      ok: true,
      folio: ins.rows[0].folio,
      numero_corredora: ins.rows[0].numero_corredora,
      created_at: ins.rows[0].created_at
    });

  } catch (err) {
    await client.query("ROLLBACK");
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

    const page = pdfDoc.getPages()[0];

    // 👇 Ajusta posiciones (x,y) según tu PDF real
    page.drawText(`Folio: ${row.folio}`, {
      x: 50, y: 120, size: 11, font, color: rgb(0,0,0)
    });
    page.drawText(`No. Corredora: ${row.numero_corredora}`, {
      x: 50, y: 105, size: 11, font, color: rgb(0,0,0)
    });
    page.drawText(`Nombre: ${row.nombre_completo}`, {
      x: 50, y: 90, size: 11, font, color: rgb(0,0,0)
    });

    page.drawText(`Talla de Playera: ${row.talla_playera}`, {
      x: 50, y: 75, size: 11, font, color: rgb(0,0,0)
    });

    const out = await pdfDoc.save();

    // (opcional) marcar descargada
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
