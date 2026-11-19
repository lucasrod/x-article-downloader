# AGENTS

## Objetivo

Mantener una pipeline X-first:

- extraer Article publico desde `status/...`
- normalizar a un schema estable
- renderizar `md`, `json`, `jsonl` o `bundle`
- enriquecer con signals sin acoplar scraping y renderers
- exponer lo mismo por MCP

## Reglas del repo

- La verdad base es el documento normalizado, no el Markdown.
- Extraer desde la URL publica del `status`, no desde `x.com/i/article/...`.
- Mantener el parseo de X en `src/core/extract.js`.
- Mantener renderers independientes en `src/core/*`.
- Mantener providers separados en `src/providers/*` (incluye `x-bookmarks.js`, que lee los bookmarks via CDP).
- La web vive en `src/web/`: `server.js` (API + cola), `library.js` (indice y busqueda), `sync.js` (sincronizacion de bookmarks).
- La biblioteca virtual vive en `src/library/` con arquitectura hexagonal:
  - `domain/`: Item, Carpeta, Lista de lectura y sus reglas. Puro: sin imports de Node, HTTP, SQLite ni filesystem.
  - `application/`: casos de uso (`library-service.js`) y puertos (`ports.js`).
  - `adapters/`: SQLite (`sqlite-repository.js`), articulos de X (`x-article-source.js`), lectura de carpetas (`fs-folder-scanner.js`), almacen por huella (`fs-file-store.js`) y texto de PDFs (`pdftotext-extractor.js`).
  - La direccion de dependencias es adaptadores → aplicacion → dominio. `src/web/catalog-routes.js` es el adaptador HTTP.
- Un Item es unico; carpetas y listas de lectura solo lo referencian por id. Nunca duplicar un item para ubicarlo en dos lugares.
- Una obra anillada o encuadernada en varios tomos es un solo item: los tomos son una lista dentro de su copia fisica (`physical.volumes`), cada uno con ubicacion opcional.
- En un item con fuente, lo capturado (titulo, autores) lo dicta la fuente; lo curado (etiquetas, copia fisica, notas, carpetas, listas) es del usuario y sincronizar no lo pisa.
- La identidad de un archivo es su SHA-256, no su ruta. Mover o renombrar un PDF conserva su item; editarlo en el lugar agrega una version al mismo item. La decision vive en `domain/folder-sync.js` (funcion pura).
- Una carpeta de origen tiene politica `archive` (copia en `./library/store/<aa>/<sha256>.pdf`) o `reference` (solo indice). Sus subcarpetas se reflejan como carpetas de biblioteca solo en la primera sincronizacion.
- Los PDFs sincronizados son items sin fuente: titulo, tipo y autores los corrige el usuario. Un item eliminado deja su archivo marcado como descartado y no vuelve a importarse.
- La tapa de un item es curada (`item.cover`): una imagen guardada por huella en `./library/covers/<sha256>.<ext>` (`adapters/fs-cover-store.js`), con su origen (URL o "pagina 1 del PDF"). Se sube por `PUT /api/items/<id>/cover`; sincronizar no la pisa y al unir items el que queda conserva la suya o toma la del otro.
- `pdftotext` es opcional: sin el, los PDFs entran igual pero no son buscables por contenido.
- Una Relacion es una arista con tipo entre dos items (`domain/relation.js`): requiere, continua, es parte de, cita, se relaciona con. Los tipos que expresan orden no admiten ciclos; "se relaciona con" no tiene direccion. El grafo son los items con alguna relacion.
- Unir dos items conserva uno y le pasa archivos, etiquetas, carpetas, listas y relaciones del otro. Un item con fuente no puede ser el absorbido.
- El catalogo se guarda en `./library/library.sqlite` (o `LIBRARY_DB`). `article.json` sigue siendo la verdad del contenido de cada articulo.
- No mezclar awareness social con el renderer Markdown.
- Los comentarios por defecto se recolectan best-effort desde browser, no desde la API paga de X.

## Defaults del producto

- `--format md`
- `--images embed`
- `--embedded-posts quote`
- `--signals none`
- `--comments`: `--signals x-basic --x-provider browser --x-replies best-effort`
- sin `--output`: `./downloads/articles/<slug>/article.*`
- `bundle`: escribe directo en `./downloads/articles/<slug>/`
- con `--images download`: assets en `./downloads/articles/<slug>/assets/`

## Contrato

- El schema vive en `src/core/article-schema.js`.
- `signals.provider_trace` siempre debe explicar intentos y fallos parciales.
- Los comentarios/replies viven en `signals.conversation` y `evidence_items`, no en el Markdown.
- Si faltan credenciales, devolver salida parcial en vez de romper la CLI.
- `bundle` debe seguir siendo legible por humanos y util para agentes.
- El servidor MCP actual es `stdio` y expone tools + resources.
- Tokens esperados por defecto: `X_BEARER_TOKEN` y `XAI_API_KEY`.

## Validacion minima

- `node ./src/cli.js '<status-url>'`
- `node ./src/cli.js '<status-url>' --format md+json`
- `node ./src/cli.js '<status-url>' --format bundle --images download`
- `node ./src/cli.js '<status-url>' --format json --signals x-basic --x-provider x-api`
- `node ./src/mcp/server.js`
- `npm run web` y abrir `http://127.0.0.1:4173`
- `npm test` (dominio, casos de uso y busqueda de la biblioteca)
