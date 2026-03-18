const frm = document.getElementById("frm");
const alertBox = document.getElementById("alertBox");
const okBox = document.getElementById("okBox");
const lblFolio = document.getElementById("lblFolio");
const statusEl = document.getElementById("status");
const lblNumeroCorredora =document.getElementById("lblNumeroCorredora");


const saludChecks = Array.from(document.querySelectorAll(".salud"));
const boxDetalle = document.getElementById("boxDetalle");

//foraneo
const chkForanea = document.getElementById("chkForanea");
const selMun = document.getElementById("municipioSelect");

const boxE = document.getElementById("boxForaneaEstado");
const boxC = document.getElementById("boxForaneaCiudad");
const inpEstado = document.getElementById("inpEstado");
const inpCiudad = document.getElementById("inpCiudad");

function syncForaneaUI(){
  const foranea = !!chkForanea.checked;

  if (foranea) {
    // municipio ya no aplica
    selMun.required = false;
    selMun.value = "";
    selMun.disabled = true;

    // mostrar campos foráneos
    boxE.classList.remove("d-none");
    boxC.classList.remove("d-none");
    inpEstado.disabled = false;
    inpCiudad.disabled = false;
    inpEstado.required = true;
    inpCiudad.required = true;
  } else {
    // municipio obligatorio
    selMun.disabled = false;
    selMun.required = true;

    // ocultar foráneos
    inpEstado.required = false;
    inpCiudad.required = false;
    inpEstado.value = "";
    inpCiudad.value = "";
    inpEstado.disabled = true;
    inpCiudad.disabled = true;
    boxE.classList.add("d-none");
    boxC.classList.add("d-none");
  }
}

chkForanea?.addEventListener("change", syncForaneaUI);
syncForaneaUI();

//foraneo fin

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

    const bannerCerrado = document.getElementById("bannerCerrado");
    const bannerUltimos = document.getElementById("bannerUltimos");

    if (j.cerrado) {
      bannerCerrado?.classList.remove("d-none");
      bannerUltimos?.classList.add("d-none");

      frm.querySelectorAll("input,select,textarea,button").forEach(el => {
        el.disabled = true;
      });
    } else {
      bannerCerrado?.classList.add("d-none");

      // ejemplo: mostrar "últimos lugares" cuando queden 50 o menos
      if (j.disponibles <= 50) {
        bannerUltimos?.classList.remove("d-none");
        bannerUltimos.innerHTML = `<strong>Últimos lugares disponibles:</strong> quedan ${j.disponibles}.`;
      } else {
        bannerUltimos?.classList.add("d-none");
      }
    }
  } catch (e) {
    console.error(e);
  }
}
function formToPayload(form) {
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());

  const bools = [
    "enf_cronica","prob_cardiacos","prob_respiratorios","tratamiento_actual","alergias_meds",
    "participo_antes","constancia_digital","acepta_responsiva","acepta_privacidad"
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

    // UI éxito
    lblFolio.textContent = data.folio;
    lblNumeroCorredora.textContent = data.numero_corredora;
    okBox.classList.remove("d-none");
    if (data.aviso_extra) {
      showAlert("warning", data.aviso_extra);
    }

    // PDF carta (mejor después de éxito)
    const url = `/api/carta?folio=${encodeURIComponent(data.folio)}`;

    const btn = document.getElementById("btnCarta");
    if (btn) btn.href = url;

    // Intentar abrir (en móvil puede bloquearse; el botón siempre queda)
    window.open(url, "_blank");

    frm.reset();
    saludOn();
    await loadStatus();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });

  } catch (err) {
    console.error(err);
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
//cargar tipo de playeras:


// Llamar al cargar DOM
document.addEventListener('DOMContentLoaded', loadMunicipios);
document.addEventListener("DOMContentLoaded", function () {

  const fp = flatpickr("#fechaNacimiento", {
    dateFormat: "d/m/Y",
    altInput: false,
    allowInput: true,
    maxDate: "today",
    locale: {
      firstDayOfWeek: 1
    },

    onChange: function(selectedDates) {
      if (selectedDates.length > 0) {

        const edad = calcularEdad(selectedDates[0]);
        document.querySelector('[name="edad"]').value = edad;

        const chkMenor = document.getElementById("chkMenor");

        if (edad < 18) {
          // activar modo menor automáticamente
          if (chkMenor) chkMenor.checked = true;

          showAlert("warning", "Participación de menores requiere registro de padre/madre/tutor.");
        } else {
          if (chkMenor) chkMenor.checked = false;
          hideAlert();
        }

        // refresca UI del bloque tutor
        if (typeof syncMenorUI === "function") {
          syncMenorUI();
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

//switch menores de edad cargar:
const chkMenor = document.getElementById("chkMenor");
const boxTutorNombre = document.getElementById("boxTutorNombre");
const boxTutorTel = document.getElementById("boxTutorTel");
const boxTutorNota = document.getElementById("boxTutorNota");
const inpTutorNombre = document.getElementById("tutor_nombre");
const inpTutorTel = document.getElementById("tutor_telefono");

function syncMenorUI(){
  const isMenor = !!chkMenor?.checked;

  [boxTutorNombre, boxTutorTel, boxTutorNota].forEach(el => el?.classList.toggle("d-none", !isMenor));

  if (inpTutorNombre && inpTutorTel) {
    inpTutorNombre.disabled = !isMenor;
    inpTutorTel.disabled = !isMenor;

    inpTutorNombre.required = isMenor;
    inpTutorTel.required = isMenor;

    if (!isMenor) {
      inpTutorNombre.value = "";
      inpTutorTel.value = "";
    }
  }
}

chkMenor?.addEventListener("change", syncMenorUI);
syncMenorUI();

document.addEventListener("DOMContentLoaded", async () => {
  await loadMunicipios();
  await loadStatus();
  saludOn();
  syncForaneaUI();
  syncMenorUI();
});
