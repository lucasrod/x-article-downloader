#!/usr/bin/env node

import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildSocialBrief } from "../core/brief.js";
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
} from "../core/article-schema.js";
import { extractArticle } from "../core/extract.js";
import { defaultAssetsDir, defaultOutputPath, finalizeDocument } from "../core/output.js";
import { renderEvidenceJsonl } from "../core/render-jsonl.js";
import { renderMarkdown } from "../core/render-markdown.js";
import { prepareDocument, writePreparedOutput } from "../pipeline.js";
import { collectSignals } from "../providers/signals.js";
import { createLatestState, updateLatestState } from "./state.js";

const server = new McpServer({
  name: "x-article-downloader",
  version: "0.2.0",
});

const latest = createLatestState();

server.registerTool("article.fetch", {
  title: "Fetch X Article",
  description: "Fetch a public X Article from its status URL and return the normalized ArticleDocument JSON.",
  inputSchema: {
    url: z.url(),
    timeout: z.number().int().positive().optional(),
  },
}, async ({ url, timeout }) => {
  const document = await extractArticle(url, timeout ?? 120000);
  const rendered = finalizeDocument(document, {
    format: "json",
    imagesMode: "embed",
    embeddedPostsMode: "quote",
    signals: null,
    brief: null,
  });
  const markdown = await renderMarkdown(rendered, {
    embeddedPosts: "quote",
  });
  updateLatestState(latest, rendered, markdown, "");

  return {
    content: [{ type: "text", text: JSON.stringify(rendered, null, 2) }],
    structuredContent: rendered,
  };
});

server.registerTool("article.render", {
  title: "Render Article Output",
  description: "Render an article document into markdown, json, jsonl, md+json, or a bundle.",
  inputSchema: {
    document: z.any(),
    format: z.enum(OUTPUT_FORMATS).optional(),
    images_mode: z.enum(IMAGE_MODES).optional(),
    embedded_posts_mode: z.enum(EMBEDDED_POST_MODES).optional(),
    comments: z.boolean().optional(),
    chunk: z.enum(CHUNK_MODES).optional(),
    output_path: z.string().optional(),
    browser_storage_state: z.string().optional(),
    browser_cdp_endpoint: z.string().optional(),
  },
}, async ({ document, format, images_mode, embedded_posts_mode, comments, chunk, output_path, browser_storage_state, browser_cdp_endpoint }) => {
  const effectiveFormat = format ?? "md";
  const effectiveOutputPath = output_path ?? defaultOutputPath(document, effectiveFormat, images_mode ?? "embed");
  const assetsDir = images_mode === "download"
    ? defaultAssetsDir(effectiveOutputPath, effectiveFormat)
    : null;

  const prepared = await prepareDocument(document, {
    format: effectiveFormat,
    images: images_mode ?? "embed",
    embeddedPosts: embedded_posts_mode ?? "quote",
    chunk: chunk ?? "none",
    signals: comments ? "x-basic" : "none",
    xProvider: comments ? "browser" : "hybrid",
    xReplies: comments ? "best-effort" : "none",
    xQuotes: "none",
    brief: "none",
    bearerTokenEnv: "X_BEARER_TOKEN",
    grokApiKeyEnv: "XAI_API_KEY",
    browserStorageState: browser_storage_state ?? process.env.X_BROWSER_STORAGE_STATE ?? null,
    browserCdpEndpoint: browser_cdp_endpoint ?? process.env.X_BROWSER_CDP_ENDPOINT ?? null,
    timeout: 120000,
    outputPath: effectiveOutputPath,
    assetsDir,
  });
  prepared.document = finalizeDocument(prepared.document, {
    format: effectiveFormat,
    imagesMode: images_mode ?? "embed",
    embeddedPostsMode: embedded_posts_mode ?? "quote",
    signals: document.signals ?? null,
    brief: document.brief ?? null,
  });

  if (output_path) {
    await writePreparedOutput(prepared);
  }
  updateLatestState(latest, prepared.document, prepared.markdown, renderEvidenceJsonl(prepared.document));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        format: effectiveFormat,
        output_path: output_path ?? null,
        latest_resources: resourceLinks(),
      }, null, 2),
    }],
    structuredContent: {
      format: effectiveFormat,
      output_path: output_path ?? null,
      latest_resources: resourceLinks(),
    },
  };
});

server.registerTool("signals.enrich_x", {
  title: "Enrich X Signals",
  description: "Collect X-first metrics and awareness for a normalized article document or status URL.",
  inputSchema: {
    url: z.string().optional(),
    document: z.any().optional(),
    comments: z.boolean().optional(),
    signals_mode: z.enum(SIGNAL_MODES).optional(),
    x_provider: z.enum(X_PROVIDERS).optional(),
    x_replies: z.enum(X_REPLIES_MODES).optional(),
    x_quotes: z.enum(X_QUOTES_MODES).optional(),
    x_bearer_token_env: z.string().optional(),
    grok_api_key_env: z.string().optional(),
    browser_storage_state: z.string().optional(),
    browser_cdp_endpoint: z.string().optional(),
    timeout: z.number().int().positive().optional(),
  },
}, async ({ url, document, comments, signals_mode, x_provider, x_replies, x_quotes, x_bearer_token_env, grok_api_key_env, browser_storage_state, browser_cdp_endpoint, timeout }) => {
  const result = await collectSignals(document ?? url, {
    signalsMode: signals_mode ?? (comments ? "x-basic" : "x-full"),
    xProvider: x_provider ?? (comments ? "browser" : "hybrid"),
    repliesMode: x_replies ?? (comments ? "best-effort" : "none"),
    quotesMode: x_quotes ?? "none",
    bearerTokenEnv: x_bearer_token_env ?? "X_BEARER_TOKEN",
    grokApiKeyEnv: grok_api_key_env ?? "XAI_API_KEY",
    browserStorageState: browser_storage_state ?? process.env.X_BROWSER_STORAGE_STATE ?? null,
    browserCdpEndpoint: browser_cdp_endpoint ?? process.env.X_BROWSER_CDP_ENDPOINT ?? null,
    timeout: timeout ?? 120000,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(result.signals, null, 2) }],
    structuredContent: result.signals,
  };
});

server.registerTool("social.brief", {
  title: "Build Social Brief",
  description: "Build a concise or full markdown brief from an article document plus collected signals.",
  inputSchema: {
    document: z.any(),
    brief_mode: z.enum(BRIEF_MODES).optional(),
    signals: z.any().optional(),
  },
}, async ({ document, brief_mode, signals }) => {
  const enrichedDocument = {
    ...document,
    signals: signals ?? document.signals ?? null,
  };
  const brief = buildSocialBrief(enrichedDocument, brief_mode ?? "short");

  if (brief) {
    const finalized = {
      ...enrichedDocument,
      brief,
    };
    const markdown = await renderMarkdown(finalized, {
      embeddedPosts: finalized.rendering?.embedded_posts_mode ?? "quote",
    });
    updateLatestState(latest, finalized, markdown, renderEvidenceJsonl(finalized));
  }

  return {
    content: [{ type: "text", text: brief?.markdown ?? "" }],
    structuredContent: brief,
  };
});

server.registerResource("latest-article-json", "article://latest/json", {
  title: "Latest Article JSON",
  mimeType: "application/json",
}, async () => ({
  contents: [{ uri: "article://latest/json", text: latest.articleJson ?? "{}\n" }],
}));

server.registerResource("latest-article-markdown", "article://latest/markdown", {
  title: "Latest Article Markdown",
  mimeType: "text/markdown",
}, async () => ({
  contents: [{ uri: "article://latest/markdown", text: latest.articleMarkdown ?? "" }],
}));

server.registerResource("latest-signals-json", "signals://latest/json", {
  title: "Latest Signals JSON",
  mimeType: "application/json",
}, async () => ({
  contents: [{ uri: "signals://latest/json", text: latest.signalsJson ?? "null\n" }],
}));

server.registerResource("latest-evidence-jsonl", "evidence://latest/jsonl", {
  title: "Latest Evidence JSONL",
  mimeType: "application/x-ndjson",
}, async () => ({
  contents: [{ uri: "evidence://latest/jsonl", text: latest.evidenceJsonl ?? "" }],
}));

server.registerResource("latest-brief-markdown", "brief://latest/markdown", {
  title: "Latest Brief Markdown",
  mimeType: "text/markdown",
}, async () => ({
  contents: [{ uri: "brief://latest/markdown", text: latest.briefMarkdown ?? "" }],
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("x-article-downloader MCP server running on stdio");
}

function resourceLinks() {
  return [
    "article://latest/json",
    "article://latest/markdown",
    "signals://latest/json",
    "evidence://latest/jsonl",
    "brief://latest/markdown",
  ];
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
