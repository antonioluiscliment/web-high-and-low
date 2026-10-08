/* Análisis de Highs and Lows — lógica de la vista principal
   Datos: en vivo desde las 6 Google Sheets del proyecto BARRONS (ver sheets-config.json),
   leídas vía el endpoint público de Google Visualization en formato CSV. Cada hoja se
   comparte como "cualquiera con el enlace" (heredado de la carpeta que las contiene en
   Drive), así que se pueden leer sin iniciar sesión.

   Cada fila de las hojas trae: Ticker, columnas de fecha (una por semana, con H/L o
   vacío) y, siempre al final, 7 columnas de estadísticas: V, U, B, N, P, PU, PB. Como el
   número de columnas de fecha crece cada semana, aquí no se cuentan por posición fija:
   se toman siempre las últimas 7 columnas de cada fila, y se descarta cualquier fila cuyas
   7 columnas finales no sean todas números válidos (protege frente a filas sueltas o
   metadatos que a veces añade la exportación CSV al final).

   Nombres de empresa: ticker-names.json es un fichero estático (ticker -> nombre
   abreviado, al estilo Barron's) construido a partir del histórico de resolución de
   nombres del proyecto BARRONS. No cubre el 100% de los tickers (los más antiguos, de
   antes de que se guardara este dato, pueden faltar) — para esos se muestra "Nombre no
   disponible".
*/

const STAT_COLS = ["V", "U", "B", "N", "P", "PU", "PB"];

const COL_INFO = {
  "#": "Número de orden dentro de los resultados mostrados (con los filtros actuales).",
  "Ticker": "Símbolo bursátil de la empresa. Mantén pulsado para ver su nombre.",
  "V":  "Veces que ha aparecido en total desde que se sigue.",
  "U":  "Racha actual: semanas seguidas apareciendo, contando hacia atrás desde la última fecha.",
  "B":  "Semanas seguidas SIN aparecer, contando hacia atrás desde la última fecha.",
  "N":  "Número total de semanas registradas en esta hoja.",
  "P":  "Porcentaje de semanas en que ha aparecido en total (V ÷ N).",
  "PU": "Porcentaje que representa la racha actual sobre el total de semanas (U ÷ N).",
  "PB": "Porcentaje de semanas seguidas sin aparecer sobre el total (B ÷ N).",
};

// Filtros: rango [mínimo, máximo] de enteros para V, U y B. Por defecto cada campo
// arranca con el rango completo de valores presentes en la hoja seleccionada (sin
// restricción); N, P, PU y PB no son filtrables (siguen viéndose en la tabla).
const FILTERS = [
  { key: "V", minId: "minV", maxId: "maxV" },
  { key: "U", minId: "minU", maxId: "maxU" },
  { key: "B", minId: "minB", maxId: "maxB" },
];

let DATA = null;
let TICKER_NAMES = {};
let currentSheet = null;
let bounds = {};      // { field: {min, max} } for the current sheet
let defaults = {};    // default (least restrictive) slider value per field
let currentView = "highs-lows";
let REC_FILES = [];   // [{name, id}] — informes "Agente..." de la carpeta PDF de BARRONS
let GRAFICOS_FILES = []; // [{name, id}] — capturas de TradingView de la carpeta GRAFICOS de BARRONS

function $(id) { return document.getElementById(id); }

function num(v) {
  return (v === null || v === undefined || v === "" || Number.isNaN(v)) ? null : Number(v);
}

// --- CSV parsing mínimo (RFC4180: comillas dobles, comas y saltos de línea en campos) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // se ignora; el salto real lo marca \n
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ""));
}

function isFiniteNumberStr(s) {
  return s !== "" && s !== null && s !== undefined && Number.isFinite(Number(s));
}

// Convierte las filas crudas de una hoja (cabecera + datos) en objetos
// {Ticker, V, U, B, N, P, PU, PB}, tomando las estadísticas por las últimas 7 columnas
// (robusto frente a que cambie el número de columnas de fecha, o a alguna fila con algún
// campo en blanco de más). Descarta cualquier fila cuyas 7 últimas columnas no sean todas
// numéricas — así se filtran automáticamente filas sueltas ajenas a los datos.
function rowsToRecords(csvRows) {
  const dataRows = csvRows.slice(1); // primera fila = cabecera
  return dataRows
    .filter(r => r.length >= 8 && r[0])
    .map(r => {
      const stats = r.slice(-7);
      return { Ticker: r[0], stats };
    })
    .filter(({ stats }) => stats.every(isFiniteNumberStr))
    .map(({ Ticker, stats }) => {
      const rec = { Ticker };
      STAT_COLS.forEach((key, i) => { rec[key] = stats[i]; });
      return rec;
    });
}

function csvUrlFor(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
}

async function loadData() {
  const config = await fetch("sheets-config.json").then(r => r.json());
  const sheetNames = Object.keys(config.sheets);
  const sheets = {};
  // Pre-declara las claves en el orden del config para que Object.keys(sheets)
  // respete ese orden pase lo que pase con el orden en que resuelven los fetch.
  sheetNames.forEach(name => { sheets[name] = []; });
  await Promise.all(sheetNames.map(async (name) => {
    const sheetId = config.sheets[name];
    const text = await fetch(csvUrlFor(sheetId)).then(r => {
      if (!r.ok) throw new Error(`No se pudo leer la hoja "${name}" (HTTP ${r.status})`);
      return r.text();
    });
    sheets[name] = rowsToRecords(parseCsv(text));
  }));
  return { generated_at: config.generated_at || null, sheets };
}

async function loadTickerNames() {
  try {
    return await fetch("ticker-names.json").then(r => (r.ok ? r.json() : {}));
  } catch (e) {
    return {};
  }
}

// --- Vista "Recomendaciones": informes "Agente..." de la carpeta PDF de BARRONS en Drive ---
// recommendations-config.json es un manifiesto (igual que sheets-config.json): lista los
// ficheros "Agente..." de esa carpeta como {name, id}, porque una app estática sin backend
// no puede listar el contenido de una carpeta de Drive en vivo. Hay que añadir una entrada
// cada vez que se genere un informe nuevo. La carpeta PDF está compartida como "cualquiera
// con el enlace, lector", así que estos ids se pueden incrustar sin iniciar sesión.
async function loadRecommendations() {
  try {
    const config = await fetch("recommendations-config.json").then(r => (r.ok ? r.json() : null));
    return (config && Array.isArray(config.files)) ? config.files : [];
  } catch (e) {
    return [];
  }
}

function prettyReportName(name) {
  return String(name || "").replace(/_/g, " ");
}

// Nombre abreviado para el desplegable de informes: "Agente_Highs_Nasdaq_Ronda1_2026-09-21"
// -> "Highs Nasdaq R1 09-21". Si el nombre no sigue ese patrón (informes antiguos o con otro
// formato), se cae de vuelta al nombre completo de prettyReportName(). Esta función solo se usa
// para el texto del desplegable; la descarga y el "compartir" siguen usando prettyReportName()
// para el nombre del fichero.
function abbreviateReportName(name) {
  const m = String(name || "").match(/Agente[_\s]+Highs[_\s]+Nasdaq[_\s]+Ronda(\d+)[_\s]+(\d{4})-(\d{2})-(\d{2})/i);
  if (m) {
    const [, ronda, , mm, dd] = m;
    return `Highs Nasdaq R${ronda} ${mm}-${dd}`;
  }
  return prettyReportName(name);
}

function driveEmbedUrl(id) { return `https://drive.google.com/file/d/${id}/preview`; }
function driveDownloadUrl(id) { return `https://drive.google.com/uc?export=download&id=${id}`; }
function driveImageUrl(id) { return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`; }

function showReport(id) {
  if (!id) return;
  $("recFrame").src = driveEmbedUrl(id);
  $("recDownload").href = driveDownloadUrl(id);
  $("recPanel").hidden = false;
}

// --- Top 25 + datos fundamentales de la ronda seleccionada -----------------------------
// Cada entrada de recommendations-config.json puede traer un "dataFile" opcional: el nombre
// de un fichero JSON con el detalle de esa ronda, desplegado junto a index.html/app.js en el
// propio repositorio de GitHub (ausente o null en informes antiguos, para los que todavía no
// se ha preparado ese fichero — en ese caso las dos tablas de abajo se ocultan sin más). Se
// lee con una ruta relativa (fetch(dataFile)), igual que sheets-config.json o
// recommendations-config.json — IMPORTANTE: no se lee de Drive vía driveDownloadUrl(), porque
// el endpoint de descarga de Drive no admite fetch() entre dominios (CORS) y la lectura falla
// en silencio (detectado el 8/oct/2026 tras probarlo en la web real: ni la tabla de candidatas
// ni la de datos fundamentales llegaban a mostrarse). Por eso dataFile tiene que ser un
// fichero que Antonio arrastre a su repo de GitHub junto con el resto, no solo subido a Drive.
// Formato esperado del fichero apuntado por dataFile:
//   {
//     "generated_at": "YYYY-MM-DD",
//     "top25": [
//       {
//         "rank": 1, "ticker": "AAA", "puntuacion": 3.2, "valoracion": "Compra fuerte",
//         "situacion": "Incorporación reciente",
//         "spRating": "n/s", "institutionalInvestors": "n/s", "institutionalStake": "n/s",
//         "dividendYears": "n/s", "dividendYield": "n/s", "per": "n/s", "pbRatio": "n/s",
//         "price": "n/s", "high52w": "n/s", "low52w": "n/s"
//       },
//       ... hasta 25 entradas
//     ]
//   }
// Los 9 campos de datos fundamentales (todos salvo el rating de S&P, que viene de la web de
// S&P) se buscan en Yahoo Finance; cuando no se encuentra un dato se deja el texto "n/s"
// (no disponible por ahora) en vez de dejarlo en blanco o inventar un valor.
async function loadTop25Data(dataFile) {
  if (!dataFile) return null;
  try {
    const resp = await fetch(dataFile);
    if (!resp.ok) return null;
    const json = await resp.json();
    return (json && Array.isArray(json.top25)) ? json.top25 : null;
  } catch (e) {
    return null;
  }
}

function renderTop25Tables(entries) {
  const top25Panel = $("recTop25Panel");
  const fundPanel = $("recFundamentalesPanel");
  const top25Body = $("recTop25Body");
  const fundBody = $("recFundamentalesBody");
  if (!top25Panel || !fundPanel || !top25Body || !fundBody) return;

  if (!entries || entries.length === 0) {
    top25Panel.hidden = true;
    fundPanel.hidden = true;
    top25Body.innerHTML = "";
    fundBody.innerHTML = "";
    return;
  }

  top25Body.innerHTML = "";
  fundBody.innerHTML = "";
  entries.slice(0, 25).forEach(e => {
    const ticker = e.ticker ?? "";

    const tr1 = document.createElement("tr");
    tr1.innerHTML = `
      <td class="col-num">${e.rank ?? ""}</td>
      <td class="col-ticker" data-ticker="${ticker}">${ticker || "—"}</td>
      <td>${fmt(e.puntuacion, 2)}</td>
      <td>${e.valoracion ?? "—"}</td>
      <td>${e.situacion ?? "—"}</td>
    `;
    bindPressHint(tr1.querySelector(".col-ticker"), () => tickerHintText(ticker));
    top25Body.appendChild(tr1);

    const tr2 = document.createElement("tr");
    tr2.innerHTML = `
      <td class="col-ticker" data-ticker="${ticker}">${ticker || "—"}</td>
      <td>${e.spRating ?? "n/s"}</td>
      <td>${e.institutionalInvestors ?? "n/s"}</td>
      <td>${e.institutionalStake ?? "n/s"}</td>
      <td>${e.dividendYears ?? "n/s"}</td>
      <td>${e.dividendYield ?? "n/s"}</td>
      <td>${e.per ?? "n/s"}</td>
      <td>${e.pbRatio ?? "n/s"}</td>
      <td>${e.price ?? "n/s"}</td>
      <td>${e.high52w ?? "n/s"}</td>
      <td>${e.low52w ?? "n/s"}</td>
    `;
    bindPressHint(tr2.querySelector(".col-ticker"), () => tickerHintText(ticker));
    fundBody.appendChild(tr2);
  });

  top25Panel.hidden = false;
  fundPanel.hidden = false;
}

// Cuando la ronda seleccionada ya tiene datos preparados (Top 25 + fundamentales), el PDF
// embebido deja de aportar nada que esas dos tablas no muestren ya, así que se oculta el
// visor (el iframe) para no duplicar la información — pero se deja el resto del panel
// (botones "Descargar PDF" y "Compartir") siempre visible, porque el PDF en sí sigue
// teniendo contenido que las tablas no recogen (el cuaderno, el comentario de evolución,
// etc.). Para rondas sin datos preparados (dataFile ausente, o el fetch falla) el iframe
// sigue siendo la única forma de ver el informe, así que se muestra como antes.
function setPdfFrameVisible(visible) {
  const wrap = $("recFrameWrap");
  if (wrap) wrap.hidden = !visible;
}

async function updateTop25ForSelected(id) {
  const selected = REC_FILES.find(f => f.id === id);
  const entries = await loadTop25Data(selected && selected.dataFile);
  renderTop25Tables(entries);
  setPdfFrameVisible(!entries || entries.length === 0);
}

// --- Vista "Gráficos de TradingView recomendados": capturas de la carpeta GRAFICOS de
// BARRONS en Drive ---
// graficos-config.json es un manifiesto con el mismo patrón que recommendations-config.json
// y sheets-config.json: lista las imágenes de esa carpeta como {name, id}, porque una app
// estática sin backend no puede listar el contenido de una carpeta de Drive en vivo. Hay que
// añadir una entrada cada vez que se guarde una captura nueva. La carpeta GRAFICOS está
// compartida como "cualquiera con el enlace, lector", así que estos ids se pueden incrustar
// sin iniciar sesión.
async function loadGraficos() {
  try {
    const config = await fetch("graficos-config.json").then(r => (r.ok ? r.json() : null));
    return (config && Array.isArray(config.files)) ? config.files : [];
  } catch (e) {
    return [];
  }
}

function showGrafico(id) {
  if (!id) return;
  $("graficoImg").src = driveImageUrl(id);
  $("graficoDownload").href = driveDownloadUrl(id);
  $("graficoPanel").hidden = false;
}

function setupRecommendationsView(files, applyFromParams) {
  REC_FILES = files || [];
  const sel = $("recSelect");
  const empty = $("recEmpty");
  const panel = $("recPanel");
  sel.innerHTML = "";

  if (REC_FILES.length === 0) {
    empty.hidden = false;
    panel.hidden = true;
    sel.hidden = true;
    return;
  }
  empty.hidden = true;
  sel.hidden = false;

  REC_FILES.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = abbreviateReportName(f.name);
    sel.appendChild(opt);
  });

  // Por defecto se selecciona el último informe (la ronda más reciente), no el primero.
  let selectedId = REC_FILES[REC_FILES.length - 1].id;
  if (applyFromParams) {
    const p = new URLSearchParams(location.search);
    const raw = p.get("report");
    if (raw && REC_FILES.some(f => f.id === raw)) selectedId = raw;
  }
  sel.value = selectedId;
  showReport(selectedId);
  updateTop25ForSelected(selectedId);
}

function setupGraficosView(files, applyFromParams) {
  GRAFICOS_FILES = files || [];
  const sel = $("graficoSelect");
  const empty = $("graficoEmpty");
  const panel = $("graficoPanel");
  sel.innerHTML = "";

  if (GRAFICOS_FILES.length === 0) {
    empty.hidden = false;
    panel.hidden = true;
    sel.hidden = true;
    return;
  }
  empty.hidden = true;
  sel.hidden = false;

  GRAFICOS_FILES.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = prettyReportName(f.name);
    sel.appendChild(opt);
  });

  let selectedId = GRAFICOS_FILES[0].id;
  if (applyFromParams) {
    const p = new URLSearchParams(location.search);
    const raw = p.get("grafico");
    if (raw && GRAFICOS_FILES.some(f => f.id === raw)) selectedId = raw;
  }
  sel.value = selectedId;
  showGrafico(selectedId);
}

function computeBounds(rows, field) {
  const vals = rows.map(r => num(r[field])).filter(v => v !== null);
  if (vals.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// Cada campo (V,U,B,N) tiene dos casillas de entero: mínimo y máximo. Por defecto (sin
// tocar) cubren todo el rango real de la hoja — equivale a "sin filtro" para ese campo.
function setupFiltersForSheet(sheetName, applyFromParams) {
  const rows = DATA.sheets[sheetName] || [];
  bounds = {};
  defaults = {};

  FILTERS.forEach(f => {
    const b = computeBounds(rows, f.key);
    bounds[f.key] = b;
    defaults[f.key] = b; // rango completo = sin restricción
    const minInput = $(f.minId);
    const maxInput = $(f.maxId);
    minInput.min = b.min; minInput.max = b.max; minInput.step = 1;
    maxInput.min = b.min; maxInput.max = b.max; maxInput.step = 1;

    let minVal = b.min;
    let maxVal = b.max;
    if (applyFromParams) {
      const p = new URLSearchParams(location.search);
      const rawMin = p.get(`min${f.key}`);
      const rawMax = p.get(`max${f.key}`);
      if (rawMin !== null && !Number.isNaN(Number(rawMin))) {
        minVal = Math.min(Math.max(Number(rawMin), b.min), b.max);
      }
      if (rawMax !== null && !Number.isNaN(Number(rawMax))) {
        maxVal = Math.min(Math.max(Number(rawMax), b.min), b.max);
      }
    }
    minInput.value = minVal;
    maxInput.value = maxVal;
  });
}

function currentFilterValues() {
  const out = {};
  FILTERS.forEach(f => {
    out[f.key] = { min: Number($(f.minId).value), max: Number($(f.maxId).value) };
  });
  return out;
}

function rowPasses(row, filterVals) {
  for (const f of FILTERS) {
    const { min, max } = filterVals[f.key];
    const d = defaults[f.key];
    const isDefault = d && min === d.min && max === d.max;
    if (isDefault) continue; // sin restricción activa en este campo
    const v = num(row[f.key]);
    if (v === null) return false; // dato ausente no puede cumplir un rango activo
    if (v < min || v > max) return false;
  }
  return true;
}

function fmt(val, decimals) {
  if (val === null || val === undefined || val === "") return "—";
  const n = Number(val);
  if (Number.isNaN(n)) return "—";
  return decimals !== undefined ? n.toFixed(decimals) : String(n);
}

// --- Pista al mantener pulsado (ticker → nombre, cabecera → explicación) --------------
function showHint(text) {
  const bar = $("hintBar");
  bar.textContent = text;
  bar.classList.add("show");
}
function hideHint() {
  $("hintBar").classList.remove("show");
}
function bindPressHint(el, textFn) {
  const start = (e) => { showHint(textFn()); };
  const end = () => hideHint();
  el.addEventListener("pointerdown", start);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointerleave", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

function tickerHintText(ticker) {
  const name = TICKER_NAMES[ticker];
  return name ? `${ticker} — ${name}` : `${ticker} — nombre no disponible`;
}

function renderTable() {
  const rows = DATA.sheets[currentSheet] || [];
  const filterVals = currentFilterValues();
  const filtered = rows.filter(r => rowPasses(r, filterVals));

  const tbody = $("resultsBody");
  tbody.innerHTML = "";

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No hay filas que cumplan los filtros seleccionados.</td></tr>';
  } else {
    const frag = document.createDocumentFragment();
    filtered.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="col-num">${i + 1}</td>
        <td class="col-ticker" data-ticker="${r.Ticker}">${r.Ticker ?? "—"}</td>
        <td>${fmt(r.V, 0)}</td>
        <td>${fmt(r.U, 0)}</td>
        <td>${fmt(r.B, 0)}</td>
        <td>${fmt(r.N, 0)}</td>
        <td>${fmt(r.P, 0)}</td>
        <td>${fmt(r.PU, 0)}</td>
        <td>${fmt(r.PB, 0)}</td>
      `;
      const tickerCell = tr.querySelector(".col-ticker");
      bindPressHint(tickerCell, () => tickerHintText(r.Ticker));
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  const total = rows.length;
  const pct = total > 0 ? ((filtered.length / total) * 100).toFixed(1) : "0.0";
  $("resultCount").textContent = `${filtered.length} de ${total} filas (${pct}%)`;
  return filtered;
}

function updateUrl() {
  const p = new URLSearchParams();
  p.set("view", currentView);
  if (currentView === "recomendaciones") {
    const sel = $("recSelect");
    if (sel && sel.value) p.set("report", sel.value);
  } else if (currentView === "graficos") {
    const sel = $("graficoSelect");
    if (sel && sel.value) p.set("grafico", sel.value);
  } else {
    p.set("sheet", currentSheet);
    FILTERS.forEach(f => {
      const minVal = Number($(f.minId).value);
      const maxVal = Number($(f.maxId).value);
      const d = defaults[f.key];
      if (!d || minVal !== d.min) p.set(`min${f.key}`, minVal);
      if (!d || maxVal !== d.max) p.set(`max${f.key}`, maxVal);
    });
  }
  const newUrl = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", newUrl);
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

// Construye el PDF de la vista "Highs and Lows" (tabla filtrada actual) con jsPDF +
// jspdf-autotable, pero sin descargarlo: devuelve el documento jsPDF ya construido y el
// nombre de fichero sugerido, para que downloadPdf() y shareHighsLowsPdf() puedan
// reutilizar exactamente la misma construcción.
function buildHighsLowsPdfDoc() {
  const filtered = renderTable();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

  doc.setFontSize(14);
  doc.text("Análisis de Highs and Lows", 40, 36);
  doc.setFontSize(10);
  const total = (DATA.sheets[currentSheet] || []).length;
  const pct = total > 0 ? ((filtered.length / total) * 100).toFixed(1) : "0.0";
  doc.text(
    `Hoja: ${currentSheet}  ·  ${filtered.length} de ${total} filas (${pct}%)  ·  ${new Date().toLocaleDateString("es-ES")}`,
    40, 54
  );

  const head = [["#", "Ticker", "V", "U", "B", "N", "P", "PU", "PB"]];
  const body = filtered.map((r, i) => [
    i + 1, r.Ticker ?? "", fmt(r.V, 0), fmt(r.U, 0), fmt(r.B, 0), fmt(r.N, 0), fmt(r.P, 0), fmt(r.PU, 0), fmt(r.PB, 0)
  ]);

  doc.autoTable({
    head, body, startY: 66,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [15, 31, 56] },
    margin: { left: 40, right: 40 },
  });

  const filename = `highs-lows-${currentSheet.replace(/\s+/g, "_")}.pdf`;
  return { doc, filename };
}

function downloadPdf() {
  const { doc, filename } = buildHighsLowsPdfDoc();
  doc.save(filename);
}

// Comparte un PDF ya construido como fichero (no como enlace), usando la Web Share API de
// nivel 2 (navigator.share con `files`) cuando el navegador la soporta — así el PDF llega
// directamente a la app elegida (WhatsApp, Mail, etc.), tal como se comparte cualquier
// otro archivo desde el móvil. Si el navegador no soporta compartir ficheros (p. ej. la
// mayoría de navegadores de escritorio), o el usuario cancela el share nativo por un error
// (no por decisión propia), se recurre a descargar el PDF y se avisa con un toast — nunca
// se comparte un enlace a la página en su lugar.
async function sharePdfFile(file, { title, text, fallbackDownload }) {
  const canShareFiles = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
  if (canShareFiles) {
    try {
      await navigator.share({ files: [file], title, text });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // el usuario canceló el share — no forzamos descarga
      // cualquier otro error: seguimos con el fallback de descarga
    }
  }
  fallbackDownload();
  showToast("Tu navegador no permite compartir el PDF directamente: se ha descargado para que lo compartas tú.");
}

async function shareHighsLowsPdf() {
  const { doc, filename } = buildHighsLowsPdfDoc();
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  await sharePdfFile(file, {
    title: "Análisis de Highs and Lows",
    text: `Highs and Lows — ${currentSheet}`,
    fallbackDownload: () => doc.save(filename),
  });
}

async function shareRecommendationPdf() {
  const selected = REC_FILES.find(f => f.id === $("recSelect").value);
  if (!selected) return;
  const filename = `${prettyReportName(selected.name)}.pdf`;
  const fallbackDownload = () => { window.location.href = driveDownloadUrl(selected.id); };
  try {
    const resp = await fetch(driveDownloadUrl(selected.id));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const file = new File([blob], filename, { type: "application/pdf" });
    await sharePdfFile(file, {
      title: "Análisis de Highs and Lows",
      text: `Recomendaciones — ${prettyReportName(selected.name)}`,
      fallbackDownload,
    });
  } catch (e) {
    // Fetch bloqueado (CORS, red) o fallo al leer el PDF: igual que arriba, preferimos
    // descargar el PDF real antes que compartir un simple enlace.
    fallbackDownload();
    showToast("Tu navegador no permite compartir el PDF directamente: se ha descargado para que lo compartas tú.");
  }
}

// Comparte la imagen (captura de TradingView) seleccionada, no un enlace — mismo patrón que
// shareRecommendationPdf(): se descarga el fichero real de Drive, se envuelve en un File y se
// comparte vía sharePdfFile() (el nombre viene de cuando solo se usaba para PDFs, pero funciona
// igual para cualquier tipo de fichero).
async function shareGraficoImage() {
  const selected = GRAFICOS_FILES.find(f => f.id === $("graficoSelect").value);
  if (!selected) return;
  const filename = `${prettyReportName(selected.name)}.jpg`;
  const fallbackDownload = () => { window.location.href = driveDownloadUrl(selected.id); };
  try {
    const resp = await fetch(driveDownloadUrl(selected.id));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const file = new File([blob], filename, { type: "image/jpeg" });
    await sharePdfFile(file, {
      title: "Análisis de Highs and Lows",
      text: `Gráfico de TradingView — ${prettyReportName(selected.name)}`,
      fallbackDownload,
    });
  } catch (e) {
    // Fetch bloqueado (CORS, red) o fallo al leer la imagen: igual que con los PDF, preferimos
    // descargar el fichero real antes que compartir un simple enlace.
    fallbackDownload();
    showToast("Tu navegador no permite compartir la imagen directamente: se ha descargado para que la compartas tú.");
  }
}

function setupMenu() {
  const menu = $("sideMenu");
  const overlay = $("menuOverlay");
  const open = () => { menu.classList.add("open"); overlay.classList.add("open"); };
  const close = () => { menu.classList.remove("open"); overlay.classList.remove("open"); };
  $("menuToggle").addEventListener("click", open);
  $("menuClose").addEventListener("click", close);
  overlay.addEventListener("click", close);

  document.querySelectorAll(".menu-item").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(a.getAttribute("data-view"));
      close();
    });
  });
}

// Cambia la sección visible ("Highs and Lows" / "Recomendaciones") y resalta la opción
// correspondiente en el menú. Ambas vistas se inicializan siempre en init(), estén o no
// activas, para que el cambio de vista sea instantáneo (sin recargar datos).
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach(sec => {
    sec.hidden = sec.id !== `view-${view}`;
  });
  document.querySelectorAll(".menu-item").forEach(a => {
    a.classList.toggle("active", a.getAttribute("data-view") === view);
  });
  updateUrl();
}

function setupHeaderHints() {
  document.querySelectorAll("#resultsTable thead th[data-col]").forEach(th => {
    const key = th.getAttribute("data-col");
    const text = COL_INFO[key];
    if (!text) return;
    bindPressHint(th, () => `${key} — ${text}`);
  });
}

function init(recFiles, graficosFiles) {
  setupMenu();
  setupHeaderHints();

  const params = new URLSearchParams(location.search);
  const sheetNames = Object.keys(DATA.sheets);
  currentSheet = params.get("sheet") && sheetNames.includes(params.get("sheet"))
    ? params.get("sheet")
    : sheetNames[0];

  const sel = $("sheetSelect");
  sheetNames.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${name} (${DATA.sheets[name].length})`;
    sel.appendChild(opt);
  });
  sel.value = currentSheet;

  setupFiltersForSheet(currentSheet, true);
  renderTable();

  sel.addEventListener("change", () => {
    currentSheet = sel.value;
    setupFiltersForSheet(currentSheet, false);
    renderTable();
    updateUrl();
  });

  FILTERS.forEach(f => {
    [$(f.minId), $(f.maxId)].forEach(input => {
      input.addEventListener("input", () => {
        renderTable();
        updateUrl();
      });
    });
  });

  $("resetFilters").addEventListener("click", () => {
    setupFiltersForSheet(currentSheet, false);
    renderTable();
    updateUrl();
  });

  $("downloadPdf").addEventListener("click", downloadPdf);
  $("shareView").addEventListener("click", shareHighsLowsPdf);

  setupRecommendationsView(recFiles, true);
  $("recSelect").addEventListener("change", () => {
    showReport($("recSelect").value);
    updateTop25ForSelected($("recSelect").value);
    updateUrl();
  });
  $("recShare").addEventListener("click", shareRecommendationPdf);

  setupGraficosView(graficosFiles, true);
  $("graficoSelect").addEventListener("change", () => {
    showGrafico($("graficoSelect").value);
    updateUrl();
  });
  $("graficoShare").addEventListener("click", shareGraficoImage);

  const requestedViewParam = params.get("view");
  const requestedView = (requestedViewParam === "recomendaciones" || requestedViewParam === "graficos")
    ? requestedViewParam
    : "highs-lows";
  switchView(requestedView);
}

Promise.all([loadData(), loadTickerNames(), loadRecommendations(), loadGraficos()])
  .then(([json, names, recFiles, graficosFiles]) => { DATA = json; TICKER_NAMES = names; init(recFiles, graficosFiles); })
  .catch(err => {
    document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif;color:#b00">
      No se pudieron cargar los datos (sheets-config.json o alguna Google Sheet). ${err}</p>`;
  });
