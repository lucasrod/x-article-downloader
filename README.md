# x-article-downloader

CLI para extraer un Article publico de X desde su URL `status/...` y exportarlo como Markdown, JSON, JSONL o bundle agent-friendly.

## Requisitos

- Node.js 20+
- `npm install`
- `npx playwright install chromium`

## MCP status

Si: esto es un servidor MCP real por `stdio`.

En este repo el servidor:

- crea un `McpServer`
- registra `tools`
- registra `resources`
- conecta un `StdioServerTransport`

Entry point:

- [src/mcp/server.js](/Users/lucasrod/Workspace/x-article-downloader/src/mcp/server.js)

En la practica eso significa que un host compatible con MCP puede levantarlo como proceso local y descubrir:

- tools: `article.fetch`, `article.render`, `signals.enrich_x`, `social.brief`
- resources: `article://latest/json`, `article://latest/markdown`, `signals://latest/json`, `evidence://latest/jsonl`, `brief://latest/markdown`

Lo que no implementa hoy:

- prompts MCP
- transporte HTTP/SSE remoto

Eso no lo invalida como servidor MCP. Sigue siendo un servidor MCP valido, solo que con superficie `stdio` + `tools/resources`.

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

## Variables y tokens

Para usar todas las funcionalidades de enrichment necesitas, idealmente, estas dos variables:

- `X_BEARER_TOKEN`
  Token para X API. Se usa para metricas exactas, replies por API y quotes por API.
- `XAI_API_KEY`
  API key de xAI. Se usa para awareness, sintesis social y evidencia recuperada via Grok `x_search`.

Plantilla:

- [.env.example](/Users/lucasrod/Workspace/x-article-downloader/.env.example)

### Opcion 1: exportarlas en tu shell

```bash
export X_BEARER_TOKEN='tu_token_de_x'
export XAI_API_KEY='tu_api_key_de_xai'
```

Luego puedes correr:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format json \
  --signals x-full \
  --x-provider hybrid \
  --x-replies api \
  --x-quotes api \
  --brief full
```

### Opcion 2: usar un archivo `.env` y cargarlo manualmente

```bash
cp .env.example .env
set -a
source .env
set +a
```

Luego ejecutas la CLI normalmente.

### Opcion 3: usar otros nombres de variables

Si no quieres usar los nombres default, puedes mapearlos:

```bash
export MY_X_TOKEN='tu_token_de_x'
export MY_XAI_KEY='tu_api_key_de_xai'

node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --signals x-full \
  --x-provider hybrid \
  --x-bearer-token-env MY_X_TOKEN \
  --grok-api-key-env MY_XAI_KEY
```

## Que funciona sin tokens

Sin ningun token deberias poder corroborar:

- extracción del Article desde la URL publica `status/...`
- render a `md`
- render a `json`
- render a `md+json`
- render a `jsonl`
- render a `bundle`
- `--images embed`
- `--images download`
- `--embedded-posts quote|link|omit`
- servidor MCP por `stdio`
- tools MCP que no dependan de enrichment autenticado:
  - `article.fetch`
  - `article.render`
  - `social.brief` sobre un documento ya enriquecido manualmente

Comandos para verificarlo:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011'
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' --format md+json
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' --format bundle --images download --chunk headings
node ./src/mcp/server.js
```

Tambien puedes probar enrichment sin tokens para confirmar el comportamiento degradado:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format json \
  --signals x-full \
  --x-provider hybrid
```

Resultado esperado:

- el comando termina bien
- se genera `signals`
- `signals.provider_trace.failures` explica que faltan credenciales

## Que requiere API / tokens

### Requiere `X_BEARER_TOKEN`

- `--signals x-basic --x-provider x-api`
- `--signals x-full --x-provider x-api`
- `--x-replies api`
- `--x-quotes api`
- MCP: `signals.enrich_x` con `x_provider=x-api`

Comando de prueba:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format json \
  --signals x-basic \
  --x-provider x-api \
  --x-replies api \
  --x-quotes api
```

Resultado esperado:

- `signals.metrics` con valores reales
- si hay acceso suficiente, replies/quotes poblados
- `signals.provider_trace.attempts` incluye `x-api`

### Requiere `XAI_API_KEY`

- `--signals x-full --x-provider grok`
- MCP: `signals.enrich_x` con `x_provider=grok`

Comando de prueba:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format json \
  --signals x-full \
  --x-provider grok \
  --brief short
```

Resultado esperado:

- `signals.awareness.summary`
- `signals.awareness.skepticism_themes`
- `signals.awareness.implementation_interest_themes`
- `signals.evidence_items` con hits de awareness cuando el provider los devuelve

### Requiere ambos

- `--signals x-full --x-provider hybrid`
- MCP: `signals.enrich_x` con `x_provider=hybrid`

Comando de prueba:

```bash
node ./src/cli.js 'https://x.com/shannholmberg/status/2055335043904492011' \
  --format json \
  --signals x-full \
  --x-provider hybrid \
  --x-replies api \
  --x-quotes api \
  --brief full
```

Resultado esperado:

- métricas exactas desde X API
- awareness y síntesis desde Grok
- `signals.provider_trace.attempts` con `x-api` y `grok`

## Donde conseguir los tokens

### X Bearer Token

Documentacion oficial:

- [Get started with the X API](https://docs.x.com/x-api/getting-started/getting-access)
- [Using and generating an app-only Bearer Token](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/bearer-tokens)
- [Developer Console / apps](https://docs.x.com/resources/fundamentals/developer-portal)

Ruta practica:

1. entra al Developer Console de X
2. crea o abre tu app
3. ve a `Keys and tokens`
4. copia el `Bearer Token`

### xAI API key

Documentacion oficial:

- [xAI authentication / Management API](https://docs.x.ai/docs/management-api/auth)
- [xAI Console FAQ](https://docs.x.ai/console/faq/accounts)

Ruta practica:

1. entra a xAI Console
2. crea una API key para tu team/proyecto
3. copiala y guardala como `XAI_API_KEY`

## Usarlo como servidor MCP

### Arranque directo

```bash
node ./src/mcp/server.js
```

### Claude Code / hosts MCP via `.mcp.json`

Ejemplo de configuracion local por `stdio` siguiendo el patron documentado por Anthropic para `command`, `args` y `env`:

```json
{
  "mcpServers": {
    "x-article-downloader": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/x-article-downloader/src/mcp/server.js"
      ],
      "env": {
        "X_BEARER_TOKEN": "${X_BEARER_TOKEN}",
        "XAI_API_KEY": "${XAI_API_KEY}"
      }
    }
  }
}
```

Notas practicas:

- Usa una ruta absoluta al `server.js`.
- Para solo extracción/base Markdown no necesitas tokens.
- Para `signals.enrich_x` con `x-api` necesitas `X_BEARER_TOKEN`.
- Para `signals.enrich_x` con `grok` necesitas `XAI_API_KEY`.
- Para `hybrid`, necesitas ambos.
- En hosts MCP, no asumas que heredarán tu shell: pasa `env` explícitamente.

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

Flujo recomendado para agentes:

1. `article.fetch`
2. `signals.enrich_x`
3. `social.brief`
4. leer `article://latest/json` o `signals://latest/json`

## Limites

- La fuente canonica sigue siendo la URL publica del `status`, no `x.com/i/article/...`.
- Replies/quotes via API dependen de credenciales y limites del provider.
- `best-effort` para replies es solo eso: mejor esfuerzo, no garantia.
