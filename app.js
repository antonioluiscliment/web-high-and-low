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
// Hoja central del proyecto "Agente Highs Nasdaq - Recomendaciones": 6 pestañas fijas que
// se rotan cada semana (Ronda_Actual/Anterior/Antepenultima + Top25_Actual/Anterior/
// Antepenultima), leídas en vivo por su "gid" fijo — no hace falta ningún manifiesto tipo
// recommendations-config.json porque los nombres/gids de pestaña nunca cambian.
const REC_SHEET_ID = "1bXT3cR3FgXGhSPGFdKoxSx8tqE9GJ-nkmvL3aSaguy4";
const REC_ROUNDS = [
  { key: "actual", label: "Ronda actual", rondaGid: 0, top25Gid: 1291149179 },
  { key: "anterior", label: "Ronda anterior", rondaGid: 195747993, top25Gid: 382371312 },
  { key: "antepenultima", label: "Ronda antepenúltima", rondaGid: 1688582377, top25Gid: 1948082671 },
];
const REC_TOP25_COLS = [
  "rank", "ticker", "puntuacion", "valoracion", "situacion",
  "spRating", "institutionalInvestors", "institutionalStake",
  "dividendYears", "dividendYield", "per", "pbRatio",
  "price", "high52w", "low52w",
];
let REC_DATA = {}; // caché en memoria: { [roundKey]: { top25: [...], roster: [...] } }
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

function prettyReportName(name) {
  return String(name || "").replace(/_/g, " ");
}

function driveDownloadUrl(id) { return `https://drive.google.com/uc?export=download&id=${id}`; }
function driveImageUrl(id) { return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`; }

// --- Vista "Recomendaciones": datos en vivo desde la hoja REC_SHEET_ID --------------------
// Misma técnica que loadData(): lectura pública vía el endpoint de Google Visualization en
// CSV, sin necesidad de iniciar sesión ni de ningún manifiesto (los 6 "gid" de pestaña están
// fijados arriba en REC_ROUNDS, porque no cambian nunca — solo cambia el contenido de cada
// pestaña, una vez a la semana).
function gvizCsvUrl(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

// Convierte una celda de texto ya formateada ("3,3864", "7.37%", "n/s", "Fuerte Compra"...)
// a número cuando tiene pinta de serlo. Admite coma o punto como separador decimal: el
// formato exacto que devuelve el export CSV de Google para una hoja en español no se puede
// comprobar desde este entorno (red restringida), así que se admiten ambos a propósito en
// vez de asumir uno solo. Devuelve null si no es un número (texto, vacío o "n/s").
function parseRecNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (str === "" || str.toLowerCase() === "n/s") return null;
  let norm = str.replace(/[^0-9,.\-]/g, "");
  if (norm.includes(",") && !norm.includes(".")) norm = norm.replace(",", ".");
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

// Para las tablas de Recomendaciones: casi todas las celdas son texto ya listo para mostrar
// tal cual (valoración, situación, "n/s", porcentajes...), así que por defecto se muestran
// sin tocar. Solo cuando se pide un número de decimales (la puntuación) se reformatea vía
// parseRecNumber(), para no depender del separador decimal con que haya exportado Google
// ese valor.
function recFmt(raw, decimals) {
  if (raw === null || raw === undefined) return "n/s";
  const str = String(raw).trim();
  if (str === "") return "n/s";
  if (decimals === undefined) return str;
  const n = parseRecNumber(str);
  return n === null ? str : n.toFixed(decimals);
}

async function fetchRecSheet(gid) {
  const text = await fetch(gvizCsvUrl(REC_SHEET_ID, gid)).then(r => {
    if (!r.ok) throw new Error(`No se pudo leer la hoja de recomendaciones (HTTP ${r.status})`);
    return r.text();
  });
  return parseCsv(text).slice(1); // se descarta la cabecera
}

// Carga a la vez las dos pestañas de una ronda (Top25_* y Ronda_*). Top25_* trae las 15
// columnas fijas de REC_TOP25_COLS, siempre en ese orden (lo garantiza el proceso semanal
// que rellena la hoja). Ronda_* es más simple: solo ticker + situación, para el listado
// completo de candidatas de esa ronda (no lleva puntuación ni valoración).
async function loadRecRound(round) {
  const [top25Rows, rosterRows] = await Promise.all([
    fetchRecSheet(round.top25Gid),
    fetchRecSheet(round.rondaGid),
  ]);
  const top25 = top25Rows
    .filter(r => r.length >= REC_TOP25_COLS.length && r[1])
    .map(r => {
      const entry = {};
      REC_TOP25_COLS.forEach((key, i) => { entry[key] = r[i]; });
      return entry;
    });
  const roster = rosterRows
    .filter(r => r.length >= 2 && r[0])
    .map(r => ({ ticker: r[0], situacion: r[1] }));
  return { top25, roster };
}

// Caché en memoria por ronda (REC_DATA): cada pestaña solo se lee una vez por carga de
// página aunque el usuario cambie de ronda varias veces en el desplegable.
async function ensureRecRound(roundKey) {
  if (REC_DATA[roundKey]) return REC_DATA[roundKey];
  const round = REC_ROUNDS.find(r => r.key === roundKey);
  if (!round) return { top25: [], roster: [] };
  const data = await loadRecRound(round);
  REC_DATA[roundKey] = data;
  return data;
}

function renderTop25Tables(data) {
  const top25Panel = $("recTop25Panel");
  const fundPanel = $("recFundamentalesPanel");
  const top25Body = $("recTop25Body");
  const fundBody = $("recFundamentalesBody");
  if (!top25Panel || !fundPanel || !top25Body || !fundBody) return;

  const entries = (data && data.top25) || [];
  top25Body.innerHTML = "";
  fundBody.innerHTML = "";

  if (entries.length === 0) {
    top25Panel.hidden = true;
    fundPanel.hidden = true;
    return;
  }

  entries.slice(0, 25).forEach(e => {
    const ticker = e.ticker || "";

    const tr1 = document.createElement("tr");
    tr1.innerHTML = `
      <td class="col-num">${recFmt(e.rank)}</td>
      <td class="col-ticker" data-ticker="${ticker}">${ticker || "—"}</td>
      <td>${recFmt(e.puntuacion, 2)}</td>
      <td>${recFmt(e.valoracion)}</td>
      <td>${recFmt(e.situacion)}</td>
    `;
    bindPressHint(tr1.querySelector(".col-ticker"), () => tickerHintText(ticker));
    top25Body.appendChild(tr1);

    const tr2 = document.createElement("tr");
    tr2.innerHTML = `
      <td class="col-ticker" data-ticker="${ticker}">${ticker || "—"}</td>
      <td>${recFmt(e.spRating)}</td>
      <td>${recFmt(e.institutionalInvestors)}</td>
      <td>${recFmt(e.institutionalStake)}</td>
      <td>${recFmt(e.dividendYears)}</td>
      <td>${recFmt(e.dividendYield)}</td>
      <td>${recFmt(e.per)}</td>
      <td>${recFmt(e.pbRatio)}</td>
      <td>${recFmt(e.price)}</td>
      <td>${recFmt(e.high52w)}</td>
      <td>${recFmt(e.low52w)}</td>
    `;
    bindPressHint(tr2.querySelector(".col-ticker"), () => tickerHintText(ticker));
    fundBody.appendChild(tr2);
  });

  top25Panel.hidden = false;
  fundPanel.hidden = false;
}

// Tabla opcional con el listado completo de la ronda (ticker + situación, sin puntuación:
// la hoja Ronda_* no la lleva). Solo se rellena si index.html incluye los elementos
// recRosterPanel/recRosterBody — si no existen (todavía no añadidos a index.html), esta
// función no hace nada, así que no hace falta tocar el HTML para que el resto funcione.
function renderRoster(data) {
  const panel = $("recRosterPanel");
  const body = $("recRosterBody");
  if (!panel || !body) return;

  const rows = (data && data.roster) || [];
  body.innerHTML = "";
  if (rows.length === 0) {
    panel.hidden = true;
    return;
  }
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td class="col-ticker" data-ticker="${r.ticker}">${r.ticker || "—"}</td>
      <td>${recFmt(r.situacion)}</td>
    `;
    bindPressHint(tr.querySelector(".col-ticker"), () => tickerHintText(r.ticker));
    body.appendChild(tr);
  });
  panel.hidden = false;
}

async function loadAndRenderRecRound(roundKey) {
  const empty = $("recEmpty");
  const panel = $("recPanel");
  try {
    const data = await ensureRecRound(roundKey);
    if (empty) empty.hidden = true;
    if (panel) panel.hidden = false;
    renderTop25Tables(data);
    renderRoster(data);
  } catch (e) {
    renderTop25Tables(null);
    renderRoster(null);
    if (panel) panel.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.textContent = "No se han podido cargar los datos de recomendaciones.";
    }
  }
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

function setupRecommendationsView(applyFromParams) {
  const sel = $("recSelect");
  // El visor de PDF embebido ya no se usa (los datos se leen en vivo de la hoja): se oculta
  // de forma permanente, sin tocar el HTML.
  const frameWrap = $("recFrameWrap");
  if (frameWrap) frameWrap.hidden = true;
  if (!sel) return;

  sel.innerHTML = "";
  REC_ROUNDS.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r.key;
    opt.textContent = r.label;
    sel.appendChild(opt);
  });

  let selectedKey = REC_ROUNDS[0].key; // "actual" por defecto
  if (applyFromParams) {
    const p = new URLSearchParams(location.search);
    const raw = p.get("round");
    if (raw && REC_ROUNDS.some(r => r.key === raw)) selectedKey = raw;
  }
  sel.value = selectedKey;
  loadAndRenderRecRound(selectedKey);
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
    if (sel && sel.value) p.set("round", sel.value);
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

// Construye el PDF de la vista "Recomendaciones" (Top 25 + datos fundamentales de la ronda
// seleccionada) con jsPDF + jspdf-autotable — mismo patrón que buildHighsLowsPdfDoc(), pero
// con dos páginas (candidatas y fundamentales) porque no caben cómodamente en una sola tabla.
function buildRecPdfDoc(roundKey) {
  const round = REC_ROUNDS.find(r => r.key === roundKey) || REC_ROUNDS[0];
  const data = REC_DATA[roundKey] || { top25: [] };
  const entries = data.top25 || [];
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const fecha = new Date().toLocaleDateString("es-ES");

  doc.setFontSize(14);
  doc.text("Agente Highs Nasdaq — Recomendaciones (Top 25)", 40, 36);
  doc.setFontSize(10);
  doc.text(`${round.label}  ·  ${fecha}`, 40, 54);
  doc.autoTable({
    head: [["#", "Ticker", "Puntuación", "Valoración", "Situación"]],
    body: entries.map(e => [
      recFmt(e.rank), e.ticker || "", recFmt(e.puntuacion, 2), recFmt(e.valoracion), recFmt(e.situacion),
    ]),
    startY: 66,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [15, 31, 56] },
    margin: { left: 40, right: 40 },
  });

  doc.addPage("a4", "landscape");
  doc.setFontSize(14);
  doc.text("Agente Highs Nasdaq — Datos fundamentales (Top 25)", 40, 36);
  doc.setFontSize(10);
  doc.text(`${round.label}  ·  ${fecha}`, 40, 54);
  doc.autoTable({
    head: [["Ticker", "S&P", "Inv. inst.", "% inst.", "Años div.", "Yield div.", "PER", "P/B", "Precio", "Máx 52s", "Mín 52s"]],
    body: entries.map(e => [
      e.ticker || "", recFmt(e.spRating), recFmt(e.institutionalInvestors), recFmt(e.institutionalStake),
      recFmt(e.dividendYears), recFmt(e.dividendYield), recFmt(e.per), recFmt(e.pbRatio),
      recFmt(e.price), recFmt(e.high52w), recFmt(e.low52w),
    ]),
    startY: 66,
    styles: { fontSize: 7, cellPadding: 3 },
    headStyles: { fillColor: [15, 31, 56] },
    margin: { left: 40, right: 40 },
  });

  const filename = `recomendaciones-${roundKey}.pdf`;
  return { doc, filename };
}

function downloadRecPdf() {
  const roundKey = $("recSelect").value;
  const { doc, filename } = buildRecPdfDoc(roundKey);
  doc.save(filename);
}

async function shareRecommendation() {
  const roundKey = $("recSelect").value;
  const round = REC_ROUNDS.find(r => r.key === roundKey) || REC_ROUNDS[0];
  const { doc, filename } = buildRecPdfDoc(roundKey);
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  await sharePdfFile(file, {
    title: "Agente Highs Nasdaq — Recomendaciones",
    text: `Recomendaciones — ${round.label}`,
    fallbackDownload: () => doc.save(filename),
  });
}

// Comparte la imagen (captura de TradingView) seleccionada, no un enlace — mismo patrón que
// shareRecommendation(): se descarga el fichero real de Drive, se envuelve en un File y se
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

function init(graficosFiles) {
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

  setupRecommendationsView(true);
  $("recSelect").addEventListener("change", () => {
    loadAndRenderRecRound($("recSelect").value);
    updateUrl();
  });
  const recDownloadBtn = $("recDownload");
  if (recDownloadBtn) {
    recDownloadBtn.addEventListener("click", (e) => { e.preventDefault(); downloadRecPdf(); });
  }
  $("recShare").addEventListener("click", shareRecommendation);

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

Promise.all([loadData(), loadTickerNames(), loadGraficos()])
  .then(([json, names, graficosFiles]) => { DATA = json; TICKER_NAMES = names; init(graficosFiles); })
  .catch(err => {
    document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif;color:#b00">
      No se pudieron cargar los datos (sheets-config.json o alguna Google Sheet). ${err}</p>`;
  });
