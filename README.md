# web-high-and-low
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

No hay paso de compilación: es HTML/CSS/JS plano, así que Vercel lo sirve
directamente como sitio estático (no hace falta ningún `vercel.json`).

## Primera opción del menú: "Highs and Lows"

- Selector de hoja (las 6 hojas: NYSE American Lows/High, NASDAQ Lows/High,
  NYSE Lows/High).
- Filtros: P mínimo, PU mínimo, PB mínimo. Los rangos de cada deslizador
  (mínimo y máximo posibles) se calculan automáticamente a partir de los
  valores reales presentes en la hoja seleccionada — al cambiar de hoja,
  los rangos se recalculan.
- Si una fila no tiene dato para un campo filtrado y el filtro está activo
  (movido desde su posición por defecto), esa fila se excluye del
  resultado, ya que no se puede verificar que cumpla el umbral.
- Tabla con una fila por valor, columnas: Ticker, V, U, B, N, P, PU, PB.
- Botón **Descargar PDF**: genera un PDF (apaisado) con la tabla tal y
  como se está viendo (hoja + filtros aplicados).
- Botón **Compartir**: usa el share nativo del móvil/navegador si está
  disponible; si no, copia al portapapeles un enlace que reproduce
  exactamente la misma hoja y los mismos filtros (van codificados en la
  URL como parámetros `?sheet=...&minP=...&minPU=...&minPB=...`).

## De dónde vienen los datos

- Cada una de las 6 hojas de cálculo vive en la carpeta "Google Sheets"
  dentro de BARRONS en Google Drive, y se recrea semanalmente (se archiva
  la anterior y se crea una nueva con los datos actualizados).
- Esa carpeta está compartida como "Cualquiera con el enlace, lector", y
  ese permiso lo hereda automáticamente cualquier hoja nueva que se cree
  dentro — no hace falta compartir cada hoja a mano cada semana.
- `app.js` lee cada hoja en el navegador del visitante, directamente y sin
  iniciar sesión, a través del endpoint público de Google Visualization
  (`https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv`), que
  devuelve el contenido en CSV.
- De cada fila solo se usan el Ticker (primera columna) y las 7 últimas
  columnas, que son siempre V, U, B, N, P, PU, PB — las columnas de fecha
  intermedias (una por semana, con H/L) no se usan en esta vista.

## Actualizar los datos cada semana

Como los datos se leen en vivo de Google Sheets, no hay que regenerar ni
subir ningún fichero de datos. Lo único que cambia cada semana son los
identificadores de las 6 hojas (se recrean con un id nuevo): hay que
editar `sheets-config.json` con los 6 ids actuales y subir ese único
fichero al repositorio de GitHub — Vercel redespliega automáticamente.
No hace falta tocar `index.html`, `app.js` ni `styles.css`.

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

1. Añade un nuevo `<section id="view-NOMBRE" class="view">` en
   `index.html` con su contenido.
2. Añade el `<li>` correspondiente en el menú.
3. En `app.js`, añade la lógica para mostrar/ocultar la sección activa
   según la opción de menú seleccionada (de momento solo hay una vista,
   así que esa lógica de cambio de vista aún no existe — con una sola
   opción no hacía falta).
