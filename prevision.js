/* Previsión de Highs para la próxima semana (NASDAQ High)
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
 * reajusta el día 1 de cada mes con todas las semanas acumuladas. Si ese fichero no se puede
 * leer, se usan los valores por defecto de abajo (ajuste del 2026-11-01).
 */

let COEF = { b: -2.0012, sem1: 1.9458, sem2: 0.1475, V: 0.1641, U: -0.3691, B: -0.1695 };
let COEF_FECHA = "2026-11-01";

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
  } catch (e) { /* se mantienen los coeficientes por defecto */ }
}
const PREV_SHEET = "NASDAQ High";
const PREV_TOP = 40;

let PREV_STATE = null; // { rows, top, expectedRegistered, newLastWeek, nextWeekLabel, lastWeekLabel }

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

function prevSummaryText(s) {
  const total = s.expectedRegistered + s.newLastWeek;
  return {
    main: `Total de Highs previstos en el Nasdaq${s.nextWeekLabel ? " para la semana del " + s.nextWeekLabel : ""}: ≈ ${prevInt(total)}`,
    detail: `${prevInt(s.expectedRegistered)} entre los ${s.rows.length} valores ya registrados en la hoja (suma de sus probabilidades) ` +
      `+ ≈ ${s.newLastWeek} incorporaciones nuevas, que el modelo no puede anticipar y se estiman iguales a las de la última semana` +
      `${s.lastWeekLabel ? " (" + s.lastWeekLabel + ")" : ""}. ` +
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
  doc.text(`Previsión de Highs — NASDAQ${s.nextWeekLabel ? " — semana del " + s.nextWeekLabel : ""}`, 40, 40);
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
  const filename = `prevision-highs-nasdaq${s.nextWeekLabel ? "-" + s.nextWeekLabel.split("/").reverse().join("-") : ""}.pdf`;
  return { doc, filename };
}

async function sharePrevisionPdf() {
  if (!PREV_STATE) return;
  const { doc, filename } = buildPrevisionPdfDoc();
  const file = new File([doc.output("blob")], filename, { type: "application/pdf" });
  await sharePdfFile(file, {
    title: "Previsión de Highs",
    text: `Previsión de Highs NASDAQ${PREV_STATE.nextWeekLabel ? " — semana del " + PREV_STATE.nextWeekLabel : ""}`,
    fallbackDownload: () => doc.save(filename),
  });
}

async function loadPrevision() {
  try {
    await loadPrevisionCoef();
    const config = await fetch("sheets-config.json").then(r => r.json());
    const name = config.sheets[PREV_SHEET] ? PREV_SHEET : Object.keys(config.sheets).find(n => /nasdaq/i.test(n));
    if (!name) throw new Error("No se encuentra la hoja NASDAQ High en sheets-config.json");
    const text = await fetch(csvUrlFor(config.sheets[name])).then(r => {
      if (!r.ok) throw new Error(`No se pudo leer la hoja "${name}" (HTTP ${r.status})`);
      return r.text();
    });
    const csvRows = parseCsv(text);
    const labels = prevWeekLabels(csvRows[0]);
    PREV_STATE = { ...computePrevision(prevRecords(csvRows)), nextWeekLabel: labels.next, lastWeekLabel: labels.last };
  } catch (e) {
    PREV_STATE = null;
    $("prevSubtitle").textContent = `No se pudo calcular la previsión: ${e.message || e}`;
  }
  renderPrevision();
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
  loadPrevision();

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

if (typeof module !== "undefined") module.exports = { prevRecords, computePrevision, prevProbability, prevWeekLabels };
