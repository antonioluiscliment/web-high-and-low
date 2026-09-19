# Análisis de Highs and Lows

Aplicación web estática (sin backend ni build) que visualiza en vivo los
datos de las 6 Google Sheets del proyecto BARRONS, con filtros y
exportación a PDF.

## Contenido del repositorio

| Fichero | Qué es |
|---|---|
| `index.html` | Estructura de la página (menú hamburguesa + vista "Highs and Lows"). |
| `styles.css` | Estilos. |
| `app.js` | Lógica: carga de datos desde Google Sheets, filtros, tabla, PDF y compartir. |
| `sheets-config.json` | Los 6 identificadores de Google Sheets actuales, uno por hoja. |
| `ticker-names.json` | Nombre abreviado (estilo Barron's) de cada ticker, para el aviso al mantener pulsado. No cubre el 100% de los tickers históricos. |
| `recommendations-config.json` | Lista de los informes "Agente..." (ver vista "Recomendaciones"), como `{name, id}` — id del fichero PDF en Drive. |

No hay paso de compilación: es HTML/CSS/JS plano, así que Vercel lo sirve
directamente como sitio estático (no hace falta ningún `vercel.json`).

## Primera opción del menú: "Highs and Lows"

- Selector de hoja (las 6 hojas: NYSE American Lows/High, NASDAQ Lows/High,
  NYSE Lows/High).
- Filtros: mínimos enteros de V, U, B, N, y mínimos de P, PU, PB (%). Los
  rangos de cada deslizador (mínimo y máximo posibles) se calculan
  automáticamente a partir de los valores reales presentes en la hoja
  seleccionada — al cambiar de hoja, los rangos se recalculan.
- Si una fila no tiene dato para un campo filtrado y el filtro está activo
  (movido desde su posición por defecto), esa fila se excluye del
  resultado, ya que no se puede verificar que cumpla el umbral.
- Tabla con una fila numerada por valor (columna `#`), columnas: Ticker, V,
  U, B, N, P, PU, PB.
- Mantener pulsado un ticker muestra el nombre de la empresa (desde
  `ticker-names.json`); mantener pulsada una cabecera de columna muestra
  una breve explicación de qué mide esa columna. Ambos usan una barra fija
  bajo la cabecera (`#hintBar`) y funcionan con ratón, dedo o lápiz.
- Debajo de la tabla se indica cuántas filas cumplen los filtros sobre el
  total de la hoja, con el porcentaje que representan.
- Botón **Descargar PDF**: genera un PDF (apaisado) con la tabla tal y
  como se está viendo (hoja + filtros aplicados, incluida la columna `#`
  y el porcentaje de filas mostradas).
- Botón **Compartir**: usa el share nativo del móvil/navegador si está
  disponible; si no, copia al portapapeles un enlace que reproduce
  exactamente la misma hoja y los mismos filtros (van codificados en la
  URL como parámetros `?sheet=...&minV=...&minU=...&minB=...&minN=...&minP=...&minPU=...&minPB=...`).

## Segunda opción del menú: "Recomendaciones"

- Selector con los informes del agente de previsión de Nasdaq High (ver
  [[agente-highs-nasdaq]] en las notas del proyecto): todos los ficheros de
  la subcarpeta **PDF** de BARRONS en Drive cuyo nombre empieza por
  "Agente" (los PDFs semanales de Barron's, que no empiezan por "Agente",
  quedan fuera de esta lista).
- El informe elegido se incrusta tal cual en la página, con el visor nativo
  de Google Drive (`https://drive.google.com/file/d/<ID>/preview` en un
  `<iframe>`), que ya trae sus propios botones de imprimir y descargar.
  Además hay dos enlaces propios como respaldo: **Abrir en pestaña nueva**
  y **Descargar PDF** (descarga directa, `.../uc?export=download&id=<ID>`).
- Si `recommendations-config.json` está vacío (no hay ningún informe
  "Agente..." todavía), se muestra un aviso en vez del selector.
- Igual que en "Highs and Lows", la vista activa y el informe elegido
  quedan codificados en la URL (`?view=recomendaciones&report=<ID>`), así
  que un enlace copiado reabre exactamente el mismo informe.

## De dónde vienen los datos

- Cada una de las 6 hojas de cálculo vive en la carpeta "Google Sheets"
  dentro de BARRONS en Google Drive, y se recrea semanalmente (se archiva
  la anterior y se crea una nueva con los datos actualizados).
- Esa carpeta está compartida como "Cualquiera con el enlace, lector", y
  ese permiso lo hereda automáticamente cualquier hoja nueva que se cree
  dentro — no hace falta compartir cada hoja a mano cada semana.
- La carpeta **PDF** de BARRONS (de donde salen los informes "Agente...")
  también está compartida como "Cualquiera con el enlace, lector" —
  incluye tanto los informes del agente como los PDFs semanales de
  Barron's que Antonio sube ahí, aunque la vista "Recomendaciones" solo
  lista los que empiezan por "Agente".
- `app.js` lee cada hoja en el navegador del visitante, directamente y sin
  iniciar sesión, a través del endpoint público de Google Visualization
  (`https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv`), que
  devuelve el contenido en CSV.
- De cada fila solo se usan el Ticker (primera columna) y las 7 últimas
  columnas, que son siempre V, U, B, N, P, PU, PB — las columnas de fecha
  intermedias (una por semana, con H/L) no se usan en esta vista. Se
  descarta cualquier fila cuyas 7 últimas columnas no sean todas números
  válidos, para ser robustos frente a filas o metadatos sueltos que a
  veces añade la exportación CSV al final.

## Actualizar los datos cada semana

Como los datos se leen en vivo de Google Sheets, no hay que regenerar ni
subir ningún fichero de datos. Lo único que cambia cada semana son los
identificadores de las 6 hojas (se recrean con un id nuevo): hay que
editar `sheets-config.json` con los 6 ids actuales y subir ese único
fichero al repositorio de GitHub — Vercel redespliega automáticamente.
No hace falta tocar `index.html`, `app.js` ni `styles.css`.

`ticker-names.json` no se actualiza cada semana: solo cubre los tickers
resueltos hasta la fecha en que se generó (no es 100% completo). Si se
quiere ampliar su cobertura más adelante, es un proceso aparte.

Cada vez que se genere un informe nuevo del agente ("Agente...pdf" en la
carpeta PDF de BARRONS), hay que añadir una entrada a
`recommendations-config.json` (`{"name": "...", "id": "<id del PDF en
Drive>"}`) y subir ese fichero al repositorio — igual que con
`sheets-config.json`, es el único cambio necesario para que aparezca en la
vista "Recomendaciones".

## Desplegar en Vercel

1. Sube el contenido de esta carpeta a un repositorio de GitHub.
2. En Vercel: **Add New… → Project → Import** el repositorio.
3. Framework Preset: **Other** (o "Static"). No hace falta build command
   ni output directory: Vercel detecta y sirve los ficheros estáticos
   directamente.
4. Deploy. Cada vez que hagas push a la rama principal, Vercel
   redespliega automáticamente.

## Añadir nuevas opciones al menú hamburguesa

El menú (`<ul class="menu-list">` en `index.html`) está preparado para
crecer: cada opción es un `<li><a class="menu-item" data-view="...">`.
Para añadir una vista nueva:

1. Añade un nuevo `<section id="view-NOMBRE" class="view" hidden>` en
   `index.html` con su contenido (el atributo `hidden` es importante: así
   arranca oculta).
2. Añade el `<li><a class="menu-item" data-view="NOMBRE">...</a></li>`
   correspondiente en el menú.

No hace falta tocar la lógica de cambio de vista: `switchView()` en
`app.js` ya busca cualquier `.view`/`.menu-item` con ese `data-view` y
alterna la visibilidad y el estado activo automáticamente (y lo refleja en
la URL con `?view=NOMBRE`).
