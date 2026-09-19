/* Análisis de Highs and Lows — lógica de la vista principal
   Datos: en vivo desde las 6 Google Sheets del proyecto BARRONS (ver sheets-config.json),
   leídas vía el endpoint público de Google Visualization en formato CSV. Cada hoja se
   comparte como "cualquiera con el enlace" (heredado de la carpeta que las contiene en
   Drive), así que se pueden leer sin iniciar sesión.

   Cada fila de las hojas trae: Ticker, columnas de fecha (una por semana, con H/L o
   vacío) y, siempre al final, 7 columnas de estadísticas: V, U, B, N, P, PU, PB. Como el
   número de columnas de fecha crece cada semana, aquí no se cuentan por posición fija:
   se toman siempre las últimas 7 columnas de cada fila.
*/

const STAT_COLS = ["V", "U", "B", "N", "P", "PU", "PB"];

const FILTERS = [
  { key: "P",  inputId: "minP",  valId: "minPVal",  type: "min", decimals: 0, suffix: "%" },
  { key: "PU", inputId: "minPU", valId: "minPUVal", type: "min", decimals: 0, suffix: "%" },
  { key: "PB", inputId: "minPB", valId: "minPBVal", type: "min", decimals: 0, suffix: "%" },
];

let DATA = null;
let currentSheet = null;
let bounds = {};      // { field: {min, max} } for the current sheet
let defaults = {};    // default (least restrictive) slider value per field

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

// Convierte las filas crudas de una hoja (cabecera + datos) en objetos
// {Ticker, V, U, B, N, P, PU, PB}, tomando las estadísticas por las últimas 7 columnas
// (robusto frente a que cambie el número de columnas de fecha, o a alguna fila con algún
// campo en blanco de más).
function rowsToRecords(csvRows) {
  const dataRows = csvRows.slice(1); // primera fila = cabecera
  return dataRows
    .filter(r => r.length >= 8 && r[0])
    .map(r => {
      const stats = r.slice(-7);
      const rec = { Ticker: r[0] };
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

function computeBounds(rows, field, decimals) {
  const vals = rows.map(r => num(r[field])).filter(v => v !== null);
  if (vals.length === 0) return { min: 0, max: 0 };
  const factor = Math.pow(10, decimals);
  const lo = Math.floor(Math.min(...vals) * factor) / factor;
  const hi = Math.ceil(Math.max(...vals) * factor) / factor;
  return { min: lo, max: hi === lo ? lo + 1 : hi };
}

function setupFiltersForSheet(sheetName, applyFromParams) {
  const rows = DATA.sheets[sheetName] || [];
  bounds = {};
  defaults = {};

  FILTERS.forEach(f => {
    const b = computeBounds(rows, f.key, f.decimals);
    bounds[f.key] = b;
    const input = $(f.inputId);
    const step = f.decimals > 0 ? Math.pow(10, -f.decimals) : 1;
    input.min = b.min;
    input.max = b.max;
    input.step = step;
    const defaultVal = f.type === "min" ? b.min : b.max;
    defaults[f.key] = defaultVal;

    let val = defaultVal;
    if (applyFromParams) {
      const p = new URLSearchParams(location.search);
      const raw = p.get(paramKeyFor(f.key));
      if (raw !== null && !Number.isNaN(Number(raw))) {
        val = Math.min(Math.max(Number(raw), b.min), b.max);
      }
    }
    input.value = val;
    updateFilterLabel(f);
  });
}

function paramKeyFor(fieldKey) {
  return { "P": "minP", "PU": "minPU", "PB": "minPB" }[fieldKey];
}

function updateFilterLabel(f) {
  const input = $(f.inputId);
  const val = Number(input.value);
  $(f.valId).textContent = (f.decimals > 0 ? val.toFixed(f.decimals) : Math.round(val)) + f.suffix;
}

function currentFilterValues() {
  const out = {};
  FILTERS.forEach(f => { out[f.key] = Number($(f.inputId).value); });
  return out;
}

function rowPasses(row, filterVals) {
  for (const f of FILTERS) {
    const threshold = filterVals[f.key];
    const isDefault = threshold === defaults[f.key];
    if (isDefault) continue; // sin restricción activa en este campo
    const v = num(row[f.key]);
    if (v === null) return false; // dato ausente no puede cumplir un umbral activo
    if (f.type === "min" && v < threshold) return false;
    if (f.type === "max" && v > threshold) return false;
  }
  return true;
}

function fmt(val, decimals) {
  if (val === null || val === undefined || val === "") return "—";
  const n = Number(val);
  if (Number.isNaN(n)) return "—";
  return decimals !== undefined ? n.toFixed(decimals) : String(n);
}

function renderTable() {
  const rows = DATA.sheets[currentSheet] || [];
  const filterVals = currentFilterValues();
  const filtered = rows.filter(r => rowPasses(r, filterVals));

  const tbody = $("resultsBody");
  tbody.innerHTML = "";

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No hay filas que cumplan los filtros seleccionados.</td></tr>';
  } else {
    const frag = document.createDocumentFragment();
    filtered.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.Ticker ?? "—"}</td>
        <td>${fmt(r.V, 0)}</td>
        <td>${fmt(r.U, 0)}</td>
        <td>${fmt(r.B, 0)}</td>
        <td>${fmt(r.N, 0)}</td>
        <td>${fmt(r.P, 0)}</td>
        <td>${fmt(r.PU, 0)}</td>
        <td>${fmt(r.PB, 0)}</td>
      `;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  $("resultCount").textContent = `${filtered.length} de ${rows.length} filas`;
  return filtered;
}

function updateUrl() {
  const p = new URLSearchParams();
  p.set("sheet", currentSheet);
  FILTERS.forEach(f => {
    const val = Number($(f.inputId).value);
    if (val !== defaults[f.key]) p.set(paramKeyFor(f.key), val);
  });
  const newUrl = `${location.pathname}?${p.toString()}`;
  history.replaceState(null, "", newUrl);
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function downloadPdf() {
  const filtered = renderTable();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

  doc.setFontSize(14);
  doc.text("Análisis de Highs and Lows", 40, 36);
  doc.setFontSize(10);
  doc.text(`Hoja: ${currentSheet}  ·  ${filtered.length} filas  ·  ${new Date().toLocaleDateString("es-ES")}`, 40, 54);

  const head = [["Ticker", "V", "U", "B", "N", "P", "PU", "PB"]];
  const body = filtered.map(r => [
    r.Ticker ?? "", fmt(r.V, 0), fmt(r.U, 0), fmt(r.B, 0), fmt(r.N, 0), fmt(r.P, 0), fmt(r.PU, 0), fmt(r.PB, 0)
  ]);

  doc.autoTable({
    head, body, startY: 66,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [15, 31, 56] },
    margin: { left: 40, right: 40 },
  });

  doc.save(`highs-lows-${currentSheet.replace(/\s+/g, "_")}.pdf`);
}

async function shareView() {
  updateUrl();
  const url = location.href;
  const shareData = {
    title: "Análisis de Highs and Lows",
    text: `Highs and Lows — ${currentSheet}`,
    url,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; } catch (e) { /* usuario canceló, seguimos con fallback */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Enlace copiado al portapapeles");
  } catch (e) {
    showToast(url);
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
}

function init() {
  setupMenu();

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
    $(f.inputId).addEventListener("input", () => {
      updateFilterLabel(f);
      renderTable();
      updateUrl();
    });
  });

  $("resetFilters").addEventListener("click", () => {
    setupFiltersForSheet(currentSheet, false);
    renderTable();
    updateUrl();
  });

  $("downloadPdf").addEventListener("click", downloadPdf);
  $("shareView").addEventListener("click", shareView);
}

loadData()
  .then(json => { DATA = json; init(); })
  .catch(err => {
    document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif;color:#b00">
      No se pudieron cargar los datos (sheets-config.json o alguna Google Sheet). ${err}</p>`;
  });
