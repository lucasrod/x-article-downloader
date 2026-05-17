# x-article-downloader

CLI para extraer un Article publico de X desde su URL `status/...` y exportarlo como Markdown, JSON, JSONL o bundle agent-friendly.

## Requisitos

- Node.js 20+
- `npm install`
- `npx playwright install chromium`

## Uso rapido

Default actual:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011'
```

Eso equivale a:

- `--format md`
- `--images embed`
- `--embedded-posts quote`
- salida en `./tmp/<slug>-remote-images.md`

## Formatos

- `md`
- `json`
- `md+json`
- `jsonl`
- `bundle`

Defaults de salida:

- `md` -> `./tmp/<slug>-remote-images.md`
- `json` -> `./tmp/<slug>-remote-images.json`
- `md+json` -> `.md` + `.json` hermanos
- `jsonl` -> `./tmp/<slug>-remote-images.jsonl`
- `bundle` -> `./tmp/<slug>-remote-images.bundle/`

Con `--images download`, el sufijo por defecto pasa a `-local-images`.

## Flags

```text
--output, -o <ruta>
--format <md|json|md+json|jsonl|bundle>
--images <embed|download>
--embedded-posts <quote|link|omit>
--assets-dir <ruta>
--signals <none|x-basic|x-full>
--x-provider <x-api|grok|hybrid>
--x-replies <none|api|best-effort>
--x-quotes <none|api>
--brief <none|short|full>
--chunk <none|headings>
--x-bearer-token-env <ENV_NAME>
--grok-api-key-env <ENV_NAME>
--timeout <ms>
```

## Ejemplos

Markdown default:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011'
```

Markdown con imagenes descargadas:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --images download
```

Markdown + JSON:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format md+json
```

Bundle listo para agentes / RAG:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format bundle \
  --images download \
  --chunk headings
```

Signals X-first:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format json \
  --signals x-full \
  --x-provider hybrid \
  --brief short
```

## Posts embebidos

- `quote`: default y recomendado. Bloque legible con autor, fecha, preview y link.
- `link`: deja solo el link canonico.
- `omit`: elimina el post embebido del Markdown.

## Signals

- `x-basic`: intenta traer metricas y estructura base.
- `x-full`: agrega awareness, evidencia y brief opcional.
- `x-api`: pensado para metricas exactas.
- `grok`: pensado para awareness/sintesis.
- `hybrid`: usa ambos si hay credenciales.

Env vars por defecto:

- `X_BEARER_TOKEN`
- `XAI_API_KEY`

Si faltan credenciales, la CLI no explota: deja trazas parciales en `signals.provider_trace.failures`.

## Bundle

`--format bundle` escribe:

- `article.md`
- `article.json`
- `signals.json`
- `brief.md`
- `evidence.jsonl`
- `article.chunks.jsonl` cuando `--chunk headings`
- `assets/` cuando `--images download`

## MCP

Servidor MCP por stdio:

```bash
node ./src/mcp/server.js
```

Tools:

- `article.fetch`
- `article.render`
- `signals.enrich_x`
- `social.brief`

Resources:

- `article://latest/json`
- `article://latest/markdown`
- `signals://latest/json`
- `evidence://latest/jsonl`
- `brief://latest/markdown`

## Limites

- La fuente canonica sigue siendo la URL publica del `status`, no `x.com/i/article/...`.
- Replies/quotes via API dependen de credenciales y limites del provider.
- `best-effort` para replies es solo eso: mejor esfuerzo, no garantia.
