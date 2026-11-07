/* Previsión de Highs para la próxima semana (NASDAQ High, NYSE High o NYSE American High)
 *
 * El usuario elige la hoja en un desplegable. Se aplica el mismo modelo y los mismos
 * coeficientes a las tres: se ajustó con NASDAQ y se validó sin reajustar sobre NYSE
 * (AUC 0,81) y NYSE American (AUC 0,79) el 2026-11-02, una vez reconstruidas esas hojas.
 *
 * Vista independiente que se añade a la web sin modificar app.js: reutiliza sus funciones
 * globales (parseCsv, rowsToRecords, csvUrlFor, bindPressHint, tickerHintText, fmt,
 * sharePdfFile, showToast, switchView) y el mismo mecanismo de menú (data-view="prevision"
 * -> <section id="view-prevision">).
 *
 * Modelo: regresión logística ajustada por máxima verosimilitud (MLE) con los datos de la
 * hoja "BARRONS - NASDAQ High" (semanas objetivo 2026/09/14 .. 2026/11/02, 2.659
 * observaciones; solo empresas que ya tenían algún High antes de la semana a predecir).
 * Variables, todas calculables a partir de las columnas V, U y B de la hoja:
 *   sem1 = High la última semana          (U >= 1)
 *   sem2 = High hace dos semanas          (U >= 2, o bien U = 0 y B = 1)
 *   V    = nº total de Highs registrados
 *   U    = racha actual de semanas con High
 *   B    = racha actual de semanas sin High
 * p(High próxima semana) = 1 / (1 + e^-(b + w1·sem1 + w2·sem2 + wV·V + wU·U + wB·B))
 * Validación rodante (predecir cada semana 10/05..11/02 entrenando solo con las anteriores):
 * AUC medio 0,786.
 *
 * Los coeficientes se leen de prevision-coef.json (desplegado junto a index.html), que se
 * reajusta CADA SEMANA (desde el 2026-11-07) con todas las semanas acumuladas, dando más peso a
 * las recientes (vida media de 2 semanas), para que cada acierto o fallo entre enseguida en el
 * modelo. Si ese fichero no se puede leer, se usan los valores por defecto de abajo.
 *
 * Total previsto: se muestra con un rango orientativo, porque el número de Highs depende mucho
 * del tono del mercado, que el modelo no ve.
 *   - Valores ya registrados: suma de probabilidades × [rango_registrados.bajo, .alto]
 *     (cociente real/previsto de la validación rodante, sin el mejor ni el peor caso).
 *   - Incorporaciones nuevas: valor central = las de la última semana; rango = mínimo y máximo
 *     de las últimas 4 semanas (primera aparición de cada fila de la hoja).
 */

let COEF = { b: -1.2693, sem1: 1.6621, sem2: 0.2436, V: -0.0337, U: -0.058, B: -0.1756 };
let COEF_FECHA = "2026-11-07";
let PREV_RANGE = { bajo: 0.94, alto: 1.57 };

async function loadPrevisionCoef() {
  try {
    const r = await fetch("prevision-coef.json", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const c = j && j.coef;
    const keys = ["b", "sem1", "sem2", "V", "U", "B"];
    if (c && keys.every(k => Number.isFinite(Number(c[k])))) {
      COEF = Object.fromEntries(keys.map(k => [k, Number(c[k])]));
      if (j.fecha_ajuste) COEF_FECHA = String(j.fecha_ajuste);
    }
    const rg = j && j.rango_registrados;
    if (rg && Number.isFinite(Number(rg.bajo)) && Number.isFinite(Number(rg.alto)) && Number(rg.bajo) <= Number(rg.alto)) {
      PREV_RANGE = { bajo: Number(rg.bajo), alto: Number(rg.alto) };
    }
  } catch (e) { /* se mantienen los coeficientes por defecto */ }
}
const PREV_DEFAULT_SHEET = "NASDAQ High";
const PREV_TOP = 40;

let PREV_STATE = null; // { sheet, rows, top, expectedRegistered, newLastWeek, nextWeekLabel, lastWeekLabel }
let PREV_CONFIG = null;   // sheets-config.json
const PREV_CACHE = {};    // hoja -> estado ya calculado (no se vuelve a leer al cambiar de hoja)

// "NASDAQ High" -> "NASDAQ"; "NYSE American High" -> "NYSE American"
function prevMarketLabel(sheetName) { return String(sheetName || "").replace(/\s*High\s*$/i, "").trim(); }

function prevProbability(V, U, B) {
  const sem1 = U >= 1 ? 1 : 0;
  const sem2 = (U >= 2 || (U === 0 && B === 1)) ? 1 : 0;
  const z = COEF.b + COEF.sem1 * sem1 + COEF.sem2 * sem2 + COEF.V * V + COEF.U * U + COEF.B * B;
  return 1 / (1 + Math.exp(-z));
}

// records: [{Ticker, V, U, B, ...}] (valores como texto o número)
function computePrevision(records) {
  const rows = records
    .map(r => ({ Ticker: r.Ticker, V: Number(r.V), U: Number(r.U), B: Number(r.B) }))
    .filter(r => r.Ticker && Number.isFinite(r.V) && Number.isFinite(r.U) && Number.isFinite(r.B) && r.V >= 1)
    .map(r => ({ ...r, p: prevProbability(r.V, r.U, r.B) }))
    .sort((a, b) => b.p - a.p || b.V - a.V || a.Ticker.localeCompare(b.Ticker));
  const expectedRegistered = rows.reduce((s, r) => s + r.p, 0);
  // Altas nuevas de la última semana: primera aparición justo en la última fecha (V = 1, U = 1).
  const newLastWeek = rows.filter(r => r.V === 1 && r.U === 1).length;
  return { rows, top: rows.slice(0, PREV_TOP), expectedRegistered, newLastWeek };
}

// Igual que rowsToRecords() de app.js (estadísticas = últimas 7 columnas), pero quitando antes
// las celdas vacías del final de cada fila: algunas filas de la hoja tienen columnas en blanco
// de más a la derecha, y así no se pierden.
function prevRecords(csvRows) {
  const isNum = v => v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v));
  return csvRows.slice(1).map(r => {
    const row = r.map(c => String(c).trim());
    while (row.length && row[row.length - 1] === "") row.pop();
    if (row.length < 8 || !row[0]) return null;
    const st = row.slice(-7);
    if (!st.every(isNum)) return null;
    return { Ticker: row[0], V: st[0], U: st[1], B: st[2] };
  }).filter(Boolean);
}

// Incorporaciones nuevas por semana: nº de filas cuya primera marca está en esa columna de fecha.
// Devuelve las de las últimas `n` semanas (la primera columna no cuenta: ahí todo es "nuevo").
function prevNewEntriesHistory(csvRows, n = 4) {
  const header = (csvRows[0] || []).map(h => String(h).trim());
  const di = header.map((h, i) => /^\d{4}\/\d{2}\/\d{2}$/.test(h) ? i : -1).filter(i => i >= 0);
  if (di.length < 2) return [];
  const counts = di.map(() => 0);
  csvRows.slice(1).forEach(r => {
    if (!r || !String(r[0] || "").trim()) return;
    const k = di.findIndex(i => String(r[i] || "").trim() !== "");
    if (k >= 0) counts[k]++;
  });
  return counts.slice(1).slice(-n);
}

// La cabecera trae las fechas como "AAAA/MM/DD"; se toma la última y se suman 7 días.
function prevWeekLabels(headerRow) {
  const dates = (headerRow || []).filter(h => /^\d{4}\/\d{2}\/\d{2}$/.test(String(h).trim()));
  if (dates.length === 0) return { last: null, next: null };
  const [y, m, d] = dates[dates.length - 1].trim().split("/").map(Number);
  const last = new Date(Date.UTC(y, m - 1, d));
  const next = new Date(last.getTime() + 7 * 86400000);
  const f = dt => `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`;
  return { last: f(last), next: f(next) };
}

function prevPct(p) { return (p * 100).toFixed(1).replace(".", ",") + " %"; }
function prevInt(x) { return Math.round(x).toLocaleString("es-ES"); }

function prevTotalRange(s) {
  const hist = (s.newHistory && s.newHistory.length) ? s.newHistory : [s.newLastWeek];
  const nMin = Math.min(...hist), nMax = Math.max(...hist);
  return {
    total: s.expectedRegistered + s.newLastWeek,
    low: s.expectedRegistered * PREV_RANGE.bajo + nMin,
    high: s.expectedRegistered * PREV_RANGE.alto + nMax,
    nMin, nMax,
  };
}

function prevSummaryText(s) {
  const r = prevTotalRange(s);
  return {
    main: `Total de Highs previstos en ${prevMarketLabel(s.sheet)}${s.nextWeekLabel ? " para la semana del " + s.nextWeekLabel : ""}: ≈ ${prevInt(r.total)} (rango orientativo ${prevInt(r.low)} – ${prevInt(r.high)})`,
    detail: `${prevInt(s.expectedRegistered)} entre los ${s.rows.length} valores ya registrados en la hoja (suma de sus probabilidades; ` +
      `rango ${prevInt(s.expectedRegistered * PREV_RANGE.bajo)} – ${prevInt(s.expectedRegistered * PREV_RANGE.alto)}) ` +
      `+ ≈ ${s.newLastWeek} incorporaciones nuevas, que el modelo no puede anticipar y se estiman iguales a las de la última semana` +
      `${s.lastWeekLabel ? " (" + s.lastWeekLabel + ")" : ""} (rango ${r.nMin} – ${r.nMax}, mínimo y máximo de las últimas ${(s.newHistory || []).length || 1} semanas). ` +
      `El total depende mucho del tono del mercado, que el modelo no ve: el rango es orientativo. ` +
      `Valores sin SPAC's, igual que la hoja. Modelo ajustado el ${COEF_FECHA}.`,
  };
}

function renderPrevision() {
  const body = $("prevBody");
  const s = PREV_STATE;
  body.innerHTML = "";
  if (!s || s.top.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">No hay datos disponibles para calcular la previsión.</td></tr>';
    $("prevSummaryPanel").hidden = true;
    return;
  }
  $("prevTitle").textContent = `Previsión de Highs para la próxima semana — ${prevMarketLabel(s.sheet)}`;
  $("prevSubtitle").textContent = s.nextWeekLabel
    ? `Los ${s.top.length} valores con mayor probabilidad de marcar un nuevo máximo de 52 semanas la semana del ${s.nextWeekLabel} (datos hasta el ${s.lastWeekLabel}).`
    : `Los ${s.top.length} valores con mayor probabilidad de marcar un nuevo máximo de 52 semanas la próxima semana.`;
  const frag = document.createDocumentFragment();
  s.top.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td class="col-ticker" data-ticker="${r.Ticker}">${r.Ticker}</td>
      <td><strong>${prevPct(r.p)}</strong></td>
      <td>${fmt(r.V, 0)}</td>
      <td>${fmt(r.U, 0)}</td>
      <td>${fmt(r.B, 0)}</td>`;
    bindPressHint(tr.querySelector(".col-ticker"), () => tickerHintText(r.Ticker));
    frag.appendChild(tr);
  });
  body.appendChild(frag);
  const txt = prevSummaryText(s);
  $("prevTotal").textContent = txt.main;
  $("prevTotalDetail").textContent = txt.detail;
  $("prevSummaryPanel").hidden = false;
}

const PREV_COL_INFO = {
  "#": "Puesto en el ranking de probabilidad.",
  "Ticker": "Símbolo bursátil de la empresa. Mantén pulsado para ver su nombre.",
  "Prob": "Probabilidad estimada por el modelo de que marque un High la próxima semana.",
  "V": "Veces que ha aparecido en total desde que se sigue.",
  "U": "Racha actual: semanas seguidas apareciendo.",
  "B": "Semanas seguidas SIN aparecer.",
};

function buildPrevisionPdfDoc() {
  const s = PREV_STATE;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text(`Previsión de Highs — ${prevMarketLabel(s.sheet)}${s.nextWeekLabel ? " — semana del " + s.nextWeekLabel : ""}`, 40, 40);
  doc.setFontSize(9);
  doc.text(`Datos hasta el ${s.lastWeekLabel || "—"} · Generado el ${new Date().toLocaleDateString("es-ES")} · Regresión logística (V, U, B y últimas 2 semanas)`, 40, 56);
  doc.autoTable({
    head: [["#", "Ticker", "Prob. High", "V", "U", "B"]],
    body: s.top.map((r, i) => [i + 1, r.Ticker, prevPct(r.p), r.V, r.U, r.B]),
    startY: 68,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [15, 31, 56] },
    margin: { left: 40, right: 40 },
  });
  const txt = prevSummaryText(s);
  let y = doc.lastAutoTable.finalY + 22;
  doc.setFontSize(11);
  doc.text(txt.main, 40, y);
  doc.setFontSize(8);
  doc.text(doc.splitTextToSize(txt.detail, 515), 40, y + 14);
  const filename = `prevision-highs-${prevMarketLabel(s.sheet).toLowerCase().replace(/\s+/g, "-")}${s.nextWeekLabel ? "-" + s.nextWeekLabel.split("/").reverse().join("-") : ""}.pdf`;
  return { doc, filename };
}

async function sharePrevisionPdf() {
  if (!PREV_STATE) return;
  const { doc, filename } = buildPrevisionPdfDoc();
  const file = new File([doc.output("blob")], filename, { type: "application/pdf" });
  await sharePdfFile(file, {
    title: "Previsión de Highs",
    text: `Previsión de Highs ${prevMarketLabel(PREV_STATE.sheet)}${PREV_STATE.nextWeekLabel ? " — semana del " + PREV_STATE.nextWeekLabel : ""}`,
    fallbackDownload: () => doc.save(filename),
  });
}

async function loadPrevision(sheetName) {
  try {
    await loadPrevisionCoef();
    if (!PREV_CONFIG) PREV_CONFIG = await fetch("sheets-config.json").then(r => r.json());
    const names = Object.keys(PREV_CONFIG.sheets);
    const name = names.includes(sheetName) ? sheetName : (names.includes(PREV_DEFAULT_SHEET) ? PREV_DEFAULT_SHEET : names[0]);
    if (!name) throw new Error("sheets-config.json no contiene ninguna hoja");
    if (!PREV_CACHE[name]) {
      $("prevSubtitle").textContent = "Calculando previsión…";
      const text = await fetch(csvUrlFor(PREV_CONFIG.sheets[name])).then(r => {
        if (!r.ok) throw new Error(`No se pudo leer la hoja "${name}" (HTTP ${r.status})`);
        return r.text();
      });
      const csvRows = parseCsv(text);
      const labels = prevWeekLabels(csvRows[0]);
      PREV_CACHE[name] = { sheet: name, ...computePrevision(prevRecords(csvRows)), newHistory: prevNewEntriesHistory(csvRows),
        nextWeekLabel: labels.next, lastWeekLabel: labels.last };
    }
    PREV_STATE = PREV_CACHE[name];
  } catch (e) {
    PREV_STATE = null;
    $("prevSubtitle").textContent = `No se pudo calcular la previsión: ${e.message || e}`;
  }
  renderPrevision();
}

// Rellena el selector de hoja con las hojas de sheets-config.json (NASDAQ por defecto) y
// recalcula la previsión al cambiar de hoja. La hoja elegida se refleja en la URL (?prevSheet=).
async function setupPrevisionSheetSelect() {
  const sel = $("prevSheetSelect");
  try {
    if (!PREV_CONFIG) PREV_CONFIG = await fetch("sheets-config.json").then(r => r.json());
  } catch (e) { PREV_CONFIG = null; }
  const names = PREV_CONFIG ? Object.keys(PREV_CONFIG.sheets) : [];
  sel.innerHTML = "";
  names.forEach(n => {
    const opt = document.createElement("option");
    opt.value = n; opt.textContent = prevMarketLabel(n);
    sel.appendChild(opt);
  });
  const fromUrl = new URLSearchParams(location.search).get("prevSheet");
  const initial = names.includes(fromUrl) ? fromUrl : (names.includes(PREV_DEFAULT_SHEET) ? PREV_DEFAULT_SHEET : names[0]);
  if (initial) sel.value = initial;
  sel.addEventListener("change", () => {
    try {
      const p = new URLSearchParams(location.search);
      p.set("view", "prevision"); p.set("prevSheet", sel.value);
      history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    } catch (e) { /* sin cambios en la URL */ }
    loadPrevision(sel.value);
  });
  return initial;
}

function setupPrevisionView() {
  document.querySelectorAll("#prevTable thead th[data-col]").forEach(th => {
    const key = th.getAttribute("data-col");
    if (PREV_COL_INFO[key]) bindPressHint(th, () => `${th.textContent} — ${PREV_COL_INFO[key]}`);
  });
  $("prevDownload").addEventListener("click", () => {
    if (!PREV_STATE) return;
    const { doc, filename } = buildPrevisionPdfDoc();
    doc.save(filename);
  });
  $("prevShare").addEventListener("click", sharePrevisionPdf);
  setupPrevisionSheetSelect().then(initial => loadPrevision(initial));

  // app.js solo reconoce ?view=recomendaciones/graficos al arrancar; si el enlace pide esta
  // vista, se activa en cuanto app.js termina su propia inicialización (DATA cargado).
  if (new URLSearchParams(location.search).get("view") === "prevision") {
    const t = setInterval(() => {
      if (typeof DATA !== "undefined" && DATA) { clearInterval(t); switchView("prevision"); }
    }, 150);
    setTimeout(() => clearInterval(t), 30000);
  }
}

if (typeof document !== "undefined" && document.getElementById("view-prevision")) {
  setupPrevisionView();
}

if (typeof module !== "undefined") module.exports = { prevNewEntriesHistory, prevTotalRange, prevSummaryText, prevMarketLabel, prevRecords, computePrevision, prevProbability, prevWeekLabels };
