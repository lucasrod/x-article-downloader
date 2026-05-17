#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  BRIEF_MODES,
  CHUNK_MODES,
  EMBEDDED_POST_MODES,
  IMAGE_MODES,
  OUTPUT_FORMATS,
  SIGNAL_MODES,
  X_PROVIDERS,
  X_QUOTES_MODES,
  X_REPLIES_MODES,
} from "./core/article-schema.js";
import { extractArticle } from "./core/extract.js";
import { defaultOutputPath } from "./core/output.js";
import { prepareDocument, writePreparedOutput } from "./pipeline.js";

const HELP = `x-article-downloader

Uso:
  x-article-downloader <url> [opciones]

Opciones:
  --output, -o <ruta>                Ruta de salida principal
  --format <md|json|md+json|jsonl|bundle>
                                     Formato de salida (default: md)
  --images <embed|download>          Manejo de imagenes (default: embed)
  --embedded-posts <quote|link|omit> Como representar posts embebidos (default: quote)
  --assets-dir <ruta>                Directorio de assets para imagenes descargadas
  --signals <none|x-basic|x-full>    Enriquecimiento social (default: none)
  --x-provider <x-api|grok|hybrid>   Provider para X (default: hybrid)
  --x-replies <none|api|best-effort> Replies a incluir (default: none)
  --x-quotes <none|api>              Quotes a incluir (default: none)
  --brief <none|short|full>          Brief social (default: none)
  --chunk <none|headings>            Chunks JSONL (default: none)
  --x-bearer-token-env <ENV_NAME>    Env var para Bearer Token de X (default: X_BEARER_TOKEN)
  --grok-api-key-env <ENV_NAME>      Env var para API key de xAI (default: XAI_API_KEY)
  --timeout <ms>                     Timeout de navegacion (default: 120000)
  --help, -h                         Mostrar ayuda
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.url) {
    console.log(HELP);
    process.exit(options.help ? 0 : 1);
  }

  assertEnum("format", options.format, OUTPUT_FORMATS);
  assertEnum("images", options.images, IMAGE_MODES);
  assertEnum("embedded-posts", options.embeddedPosts, EMBEDDED_POST_MODES);
  assertEnum("signals", options.signals, SIGNAL_MODES);
  assertEnum("x-provider", options.xProvider, X_PROVIDERS);
  assertEnum("x-replies", options.xReplies, X_REPLIES_MODES);
  assertEnum("x-quotes", options.xQuotes, X_QUOTES_MODES);
  assertEnum("brief", options.brief, BRIEF_MODES);
  assertEnum("chunk", options.chunk, CHUNK_MODES);

  const article = await extractArticle(options.url, options.timeout);
  const outputPath = path.resolve(options.output ?? defaultOutputPath(article, options.format, options.images));
  const assetsDir = options.images === "download"
    ? path.resolve(
        options.assetsDir
          ?? path.join(
            options.format === "bundle" ? outputPath : path.dirname(outputPath),
            options.format === "bundle"
              ? "assets"
              : `${path.basename(outputPath, path.extname(outputPath))}.assets`,
          ),
      )
    : null;

  const prepared = await prepareDocument(article, {
    ...options,
    outputPath,
    assetsDir,
  });

  await writePreparedOutput(prepared);
  printSummary(prepared, assetsDir);
}

function parseArgs(argv) {
  const options = {
    url: null,
    output: null,
    format: "md",
    images: "embed",
    embeddedPosts: "quote",
    assetsDir: null,
    signals: "none",
    xProvider: "hybrid",
    xReplies: "none",
    xQuotes: "none",
    brief: "none",
    chunk: "none",
    bearerTokenEnv: "X_BEARER_TOKEN",
    grokApiKeyEnv: "XAI_API_KEY",
    timeout: 120000,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("-") && !options.url) {
      options.url = token;
      continue;
    }

    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }

    if (token === "--output" || token === "-o") {
      options.output = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--format") {
      options.format = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--images") {
      options.images = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--embedded-posts") {
      options.embeddedPosts = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--assets-dir" || token === "--media-dir") {
      options.assetsDir = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--signals") {
      options.signals = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--x-provider") {
      options.xProvider = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--x-replies") {
      options.xReplies = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--x-quotes") {
      options.xQuotes = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--brief") {
      options.brief = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--chunk") {
      options.chunk = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--x-bearer-token-env") {
      options.bearerTokenEnv = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--grok-api-key-env") {
      options.grokApiKeyEnv = readValue(argv, ++index, token);
      continue;
    }

    if (token === "--timeout") {
      options.timeout = Number(readValue(argv, ++index, token));
      continue;
    }

    throw new Error(`Opcion no reconocida: ${token}`);
  }

  if (Number.isNaN(options.timeout) || options.timeout <= 0) {
    throw new Error("`--timeout` debe ser un entero positivo.");
  }

  return options;
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Falta valor para ${option}`);
  }

  return value;
}

function assertEnum(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`Valor invalido para --${name}: ${value}. Esperado: ${allowed.join(", ")}`);
  }
}

function printSummary(prepared, assetsDir) {
  if (prepared.outputPlan.kind === "bundle") {
    console.log(`Bundle guardado en ${prepared.outputPlan.bundleDir}`);
  } else {
    if (prepared.outputPlan.markdownPath) {
      console.log(`Markdown guardado en ${prepared.outputPlan.markdownPath}`);
    }
    if (prepared.outputPlan.jsonPath) {
      console.log(`JSON guardado en ${prepared.outputPlan.jsonPath}`);
    }
    if (prepared.outputPlan.jsonlPath) {
      console.log(`JSONL guardado en ${prepared.outputPlan.jsonlPath}`);
    }
  }

  if (assetsDir && prepared.downloadCount > 0) {
    console.log(`Imagenes descargadas en ${assetsDir}`);
  }

  if (prepared.document.signals) {
    console.log(`Signals: ${prepared.document.signals.provider_trace.attempts.length} provider(s) intentados`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
