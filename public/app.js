const frm = document.getElementById("frm");
const alertBox = document.getElementById("alertBox");
const okBox = document.getElementById("okBox");
const lblFolio = document.getElementById("lblFolio");
const statusEl = document.getElementById("status");
const lblNumeroCorredora =document.getElementById("lblNumeroCorredora");


const saludChecks = Array.from(document.querySelectorAll(".salud"));
const boxDetalle = document.getElementById("boxDetalle");

function showAlert(type, msg) {
  alertBox.className = `alert alert-${type}`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function hideAlert() { alertBox.classList.add("d-none"); }

function saludOn() {
  const any = saludChecks.some(c => c.checked);
  boxDetalle.classList.toggle("d-none", !any);
}
saludChecks.forEach(c => c.addEventListener("change", saludOn));

async function loadStatus() {
  try {
    const r = await fetch("/api/status");
    const j = await r.json();
    if (!j.ok) return;
    statusEl.innerHTML = `
      <span class="badge text-bg-${j.cerrado ? "danger" : "success"}">
        ${j.cerrado ? "Registro cerrado" : "Registro abierto"}
      </span>
      <span class="ms-2 text-muted">
        Registradas: ${j.registrados} / ${j.cupo_max} (Disponibles: ${j.disponibles})
      </span>
    `;
    if (j.cerrado) {
      frm.querySelectorAll("input,select,textarea,button").forEach(el => el.disabled = true);
    }
  } catch {}
}

function formToPayload(form) {
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());

  const bools = [
    "enf_cronica","prob_cardiacos","prob_respiratorios","tratamiento_actual","alergias_meds",
    "participo_antes","constancia_digital","acepta_responsiva","acepta_privacidad","es_servidora_publica","num_empleado_no_aplica"
  ];
  bools.forEach(k => payload[k] = fd.get(k) === "on");
  payload.edad = Number(payload.edad);
  if (payload.fecha_nacimiento) {
    const [d,m,y] = payload.fecha_nacimiento.split("/");
    payload.fecha_nacimiento = `${y}-${m}-${d}`;
  }
  return payload;
}

frm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert();
  okBox.classList.add("d-none");

  const payload = formToPayload(frm);
    payload.turnstile_token =
      (document.querySelector('[name="cf-turnstile-response"]')?.value || "").trim();

  console.log("token len:", payload.turnstile_token.length);

  try {
    const resp = await fetch("/api/registros", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showAlert("warning", data.msg || "No se pudo registrar.");
      return;
    }

    lblFolio.textContent = data.folio;
    lblNumeroCorredora.textContent = data.numero_corredora;
    okBox.classList.remove("d-none");
    frm.reset();
    saludOn();
    await loadStatus();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  } catch {
    showAlert("danger", "Error de conexión.");
  }
});

// Al cargar página
async function loadMunicipios() {
  try {
    const resp = await fetch('/api/municipios');
    const data = await resp.json();
    
    const select = document.getElementById('municipioSelect');
    data.municipios.forEach(mun => {
      const option = document.createElement('option');
      option.value = mun.id_municipio;
      option.textContent = mun.nombre;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Error cargando municipios:', err);
  }
}

const swServidora = document.getElementById("es_servidora_publica");
const swNoAplica = document.getElementById("num_empleado_no_aplica");
const inpEmpleado = document.getElementById("num_empleado");
const inpDependencia = document.getElementById("dependencia");
const inpArea = document.getElementById("area");

function syncEmpleadoUI(){
  const esServ = !!swServidora?.checked;

  if (esServ) {
    swNoAplica.checked = false;

    inpEmpleado.disabled = false;
    inpEmpleado.required = true;

    inpDependencia.disabled = false;
    inpDependencia.required = true;

    inpArea.disabled = false;
    inpArea.required = true;

  } else {
    inpEmpleado.required = false;
    inpDependencia.required = false;
    inpArea.required = false;

    const noAplica = !!swNoAplica?.checked;

    inpEmpleado.disabled = noAplica;
    inpDependencia.disabled = noAplica;
    inpArea.disabled = noAplica;

    if (noAplica) {
      inpEmpleado.value = "";
      inpDependencia.value = "";
      inpArea.value = "";
    }
  }
}

swServidora?.addEventListener("change", syncEmpleadoUI);
swNoAplica?.addEventListener("change", syncEmpleadoUI);
syncEmpleadoUI();

// Llamar al cargar DOM
document.addEventListener('DOMContentLoaded', loadMunicipios);
document.addEventListener("DOMContentLoaded", function () {

  const fp = flatpickr("#fechaNacimiento", {
    dateFormat: "d/m/Y",      // lo que ve el usuario
    altInput: false,
    allowInput: true,
    maxDate: "today",         // no fechas futuras
    locale: {
      firstDayOfWeek: 1
    },
    onChange: function(selectedDates, dateStr) {
      if (selectedDates.length > 0) {
        const edad = calcularEdad(selectedDates[0]);
        document.querySelector('[name="edad"]').value = edad;

        if (edad < 18) {
          showAlert("warning", "Solo mayores de edad (18+).");
        } else {
          hideAlert();
        }
      }
    }
  });

});

//calcular fecha:
function calcularEdad(fecha) {
  const hoy = new Date();
  let edad = hoy.getFullYear() - fecha.getFullYear();
  const m = hoy.getMonth() - fecha.getMonth();

  if (m < 0 || (m === 0 && hoy.getDate() < fecha.getDate())) {
    edad--;
  }

  return edad;
}

loadStatus();
saludOn();
