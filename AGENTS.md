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
- Mantener providers separados en `src/providers/*`.
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
