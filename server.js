require("dotenv").config();
const express = require("express");
const path = require("path");
const pool = require("./db");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CUPO_MAX = Number(process.env.CUPO_MAX || 500);
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

  const es_servidora_publica   = !!b.es_servidora_publica;
  const num_empleado_no_aplica = !!b.num_empleado_no_aplica;
  const num_empleado           = String(b.num_empleado || "").trim() || null;

  const dependencia = String(b.dependencia || "").trim();
  const area        = String(b.area || "").trim();

  if (es_servidora_publica) {
    if (!num_empleado || num_empleado.length < 3) {
      return res.status(400).json({ ok:false, msg:"Para premiación, captura el número de empleado." });
    }
    if (num_empleado_no_aplica) {
      return res.status(400).json({ ok:false, msg:"No aplica no puede estar marcado si eres servidora pública." });
    }
    if (!dependencia || dependencia.length < 3) {
      return res.status(400).json({ ok:false, msg:"Para premiación, captura la Dependencia/Secretaría." });
    }
    if (!area || area.length < 2) {
      return res.status(400).json({ ok:false, msg:"Para premiación, captura el Área." });
    }
  } else {
    // Recreativa: debe marcar "No aplica" o capturar num_empleado (opcional)
    if (!num_empleado_no_aplica && !num_empleado) {
      return res.status(400).json({ ok:false, msg:"Marca 'No aplica' si correrás recreativamente." });
    }
  }

  // NUEVA VALIDACIÓN: id_municipio
  const id_municipio = Number(b.id_municipio);
  if (!Number.isFinite(id_municipio) || id_municipio < 1) 
    return res.status(400).json({ ok: false, msg: "Selecciona municipio válido." });

  // Validaciones existentes
  if (!nombre_completo || nombre_completo.length < 5) return res.status(400).json({ ok:false, msg:"Nombre inválido." });
  if (!fecha_nacimiento) return res.status(400).json({ ok:false, msg:"Fecha nacimiento requerida." });
  if (!Number.isFinite(edad) || edad < 18) return res.status(400).json({ ok:false, msg:"Solo mayores de edad (18+)." });
  if (!isEmail(email)) return res.status(400).json({ ok:false, msg:"Email inválido." });
  if (!telefono || telefono.length < 10) return res.status(400).json({ ok:false, msg:"Teléfono inválido." });
  if (!contacto_emergencia_nombre || !contacto_emergencia_tel || contacto_emergencia_tel.length < 10)
    return res.status(400).json({ ok:false, msg:"Contacto de emergencia incompleto." });
  if (!acepta_responsiva || !acepta_privacidad) return res.status(400).json({ ok:false, msg:"Debes aceptar responsiva y privacidad." });

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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cupo = await client.query("SELECT COUNT(*)::int AS total FROM registros_8m_5k");
    if (cupo.rows[0].total >= CUPO_MAX) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok:false, msg:"Cupo lleno. Registro cerrado." });
    }

    // VERIFICAR municipio existe
    const munCheck = await client.query(
      "SELECT id_municipio FROM municipios_edomex WHERE id_municipio = $1", 
      [id_municipio]
    );
    if (munCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, msg: "Municipio inválido." });
    }

    const seq = await client.query("SELECT nextval('seq_folio_8m_2026') AS n");
    const folio = `${FOLIO_PREFIX}${String(seq.rows[0].n).padStart(4, "0")}`;

    const seqRunner = await client.query("SELECT nextval('seq_num_corredora_8m_2026') AS n");
    const numero_corredora = Number(seqRunner.rows[0].n);

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .toString().split(",")[0].trim();

    const q = `
      INSERT INTO registros_8m_5k (
        folio, numero_corredora,
        nombre_completo, fecha_nacimiento, edad,
        curp, id_municipio, telefono, email,
        contacto_emergencia_nombre, contacto_emergencia_tel,
        tipo_sangre,
        enf_cronica, prob_cardiacos, prob_respiratorios, tratamiento_actual, alergias_meds, salud_detalle,
        talla_playera, participo_antes, constancia_digital,
        es_servidora_publica, num_empleado, dependencia, area, num_empleado_no_aplica,
        acepta_responsiva, acepta_privacidad,
        ip_registro
        ) VALUES (
          $1,$2,
          $3,$4,$5,
          $6,$7,$8,$9,
          $10,$11,
          $12,
          $13,$14,$15,$16,$17,$18,
          $19,$20,$21,
          $22,$23,$24,$25,$26,
          $27,$28,
          $29
        )
      RETURNING folio, numero_corredora, created_at
    `;

    const params = [
      // $1..$2
      folio, numero_corredora,

      // $3..$5
      nombre_completo, fecha_nacimiento, edad,

      // $6..$9
      b.curp ? String(b.curp).trim() : null,
      id_municipio,
      telefono,
      email.toLowerCase(),

      // $10..$11
      contacto_emergencia_nombre,
      contacto_emergencia_tel,

      // $12
      b.tipo_sangre ? String(b.tipo_sangre).trim().toUpperCase() : null,

      // $13..$18 (salud)
      !!b.enf_cronica,
      !!b.prob_cardiacos,
      !!b.prob_respiratorios,
      !!b.tratamiento_actual,
      !!b.alergias_meds,
      (salud_detalle || null),

      // $19..$21
      null, // talla_playera (ya no se usa)
      !!b.participo_antes,
      !!b.constancia_digital,

      // $22..$26 (premiación)
      es_servidora_publica,
      num_empleado,
      (es_servidora_publica ? dependencia : null),
      (es_servidora_publica ? area : null),
      num_empleado_no_aplica,

      // $27..$29
      acepta_responsiva,
      acepta_privacidad,
      (ip || null),
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

      if (c === "uq_registros8m_email") {
        return res.status(409).json({ ok:false, msg:"Este correo ya está registrado." });
      }
      if (c === "uq_registros8m_num_empleado") {
        return res.status(409).json({ ok:false, msg:"Este número de empleado ya está registrado." });
      }
      if (c === "registros_8m_5k_folio_key") {
        return res.status(409).json({ ok:false, msg:"Conflicto de folio (secuencia desfasada). Reinicia contadores o sincroniza secuencias." });
      }
      if (c === "registros_8m_5k_numero_corredora_key") {
        return res.status(409).json({ ok:false, msg:"Conflicto de número de corredora (secuencia desfasada). Reinicia contadores o sincroniza secuencias." });
      }

      return res.status(409).json({ ok:false, msg:"Registro duplicado (dato único ya existe)." });
    }
    
    console.error(err);
    res.status(500).json({ ok:false, msg:"Error interno." });
  } finally {
    client.release();
  }
  
});


app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 1000;

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);
});