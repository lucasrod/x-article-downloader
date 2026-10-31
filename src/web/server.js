#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BRIEF_MODES,
  EMBEDDED_POST_MODES,
  IMAGE_MODES,
  OUTPUT_FORMATS,
  SIGNAL_MODES,
  X_PROVIDERS,
} from "../core/article-schema.js";
import { DEFAULT_DOWNLOAD_ROOT } from "../core/output.js";
import { downloadArticle } from "../pipeline.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const LIBRARY_ROOT = path.resolve(DEFAULT_DOWNLOAD_ROOT);
const MAX_JOBS_KEPT = 50;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Cola en memoria: un solo navegador a la vez, igual que correr la CLI en serie.
const jobs = [];
const subscribers = new Set();
let queueRunning = false;

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendJson(response, error.status ?? 500, { error: error.message ?? String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`x-article-downloader web en http://${HOST}:${PORT}`);
  console.log(`Biblioteca: ${LIBRARY_ROOT}`);
});

async function route(request, response) {
  assertLocalRequest(request);

  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "GET" && url.pathname === "/") {
    return sendFile(response, path.join(PUBLIC_DIR, "index.html"));
  }

  if (parts[0] !== "api") {
    throw httpError(404, "No encontrado");
  }

  if (request.method === "GET" && parts[1] === "articles" && parts.length === 2) {
    return sendJson(response, 200, { articles: await listArticles() });
  }

  if (request.method === "GET" && parts[1] === "articles" && parts.length === 3) {
    return sendJson(response, 200, await readArticle(parts[2]));
  }

  if (request.method === "GET" && parts[1] === "articles" && parts[3] === "files" && parts.length >= 5) {
    const articleDir = resolveInside(LIBRARY_ROOT, parts[2]);
    return sendFile(response, resolveInside(articleDir, ...parts.slice(4)), url.searchParams.has("download"));
  }

  if (request.method === "GET" && url.pathname === "/api/jobs") {
    return sendJson(response, 200, { jobs: jobs.map(publicJob) });
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJsonBody(request);
    const created = enqueueJobs(body);
    return sendJson(response, 202, { jobs: created.map(publicJob) });
  }

  if (request.method === "DELETE" && url.pathname === "/api/jobs") {
    clearFinishedJobs();
    return sendJson(response, 200, { jobs: jobs.map(publicJob) });
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    return openEventStream(request, response);
  }

  throw httpError(404, "No encontrado");
}

// El servidor usa la sesion de X guardada en tmp/.auth, asi que solo acepta
// requests de la propia maquina y bloquea DNS rebinding / CSRF desde otros sitios.
function assertLocalRequest(request) {
  const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  if (!allowedHosts.has(request.headers.host)) {
    throw httpError(403, "Host no permitido");
  }

  const origin = request.headers.origin;
  if (request.method !== "GET" && origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
    throw httpError(403, "Origen no permitido");
  }
}

async function listArticles() {
  let entries;
  try {
    entries = await fs.readdir(LIBRARY_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const articles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => summarizeArticle(entry.name).catch(() => null)),
  );

  return articles
    .filter(Boolean)
    .sort((left, right) => String(right.fetched_at ?? "").localeCompare(String(left.fetched_at ?? "")));
}

async function summarizeArticle(slug) {
  const articleDir = resolveInside(LIBRARY_ROOT, slug);
  const files = await listFiles(articleDir);
  const document = files.includes("article.json")
    ? JSON.parse(await fs.readFile(path.join(articleDir, "article.json"), "utf8"))
    : null;
  const signals = files.includes("signals.json")
    ? JSON.parse(await fs.readFile(path.join(articleDir, "signals.json"), "utf8"))
    : document?.signals ?? null;

  let title = document?.article.title;
  if (!title && files.includes("article.md")) {
    const markdown = await fs.readFile(path.join(articleDir, "article.md"), "utf8");
    title = markdown.match(/^# (.+)$/m)?.[1];
  }
  if (!title) {
    return null;
  }

  const blocks = document?.article.blocks ?? [];
  return {
    slug,
    title,
    author_name: document?.source.author_name ?? null,
    author_handle: document?.source.author_handle ?? null,
    status_url: document?.source.status_url ?? null,
    fetched_at: document?.source.fetched_at ?? (await fs.stat(articleDir)).mtime.toISOString(),
    word_count: countWords(blocks),
    image_count: document?.article.images.length ?? 0,
    reply_count: signals?.conversation?.reply_count_collected ?? 0,
    has_json: Boolean(document),
    files,
  };
}

async function readArticle(slug) {
  const summary = await summarizeArticle(slug);
  if (!summary) {
    throw httpError(404, `No hay articulo en ${slug}`);
  }

  const articleDir = resolveInside(LIBRARY_ROOT, slug);
  const readOptional = async (name) => summary.files.includes(name)
    ? fs.readFile(path.join(articleDir, name), "utf8")
    : null;

  const documentText = await readOptional("article.json");
  const signalsText = await readOptional("signals.json");
  const document = documentText ? JSON.parse(documentText) : null;

  return {
    summary,
    document,
    signals: signalsText ? JSON.parse(signalsText) : document?.signals ?? null,
    markdown: await readOptional("article.md"),
    brief_markdown: await readOptional("brief.md"),
  };
}

async function listFiles(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(dir, entry.name), relative));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

function countWords(blocks) {
  return blocks.reduce((total, block) => {
    const text = block.type === "list" ? block.items.join(" ") : block.text ?? "";
    return total + (String(text).match(/\S+/g)?.length ?? 0);
  }, 0);
}

function enqueueJobs(body) {
  const urls = [...new Set(
    (Array.isArray(body.urls) ? body.urls : String(body.urls ?? "").split(/\s+/))
      .map((value) => String(value).trim())
      .filter(Boolean),
  )];

  if (urls.length === 0) {
    throw httpError(400, "Pega al menos una URL de status de X.");
  }

  const invalid = urls.filter((value) => !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(value));
  if (invalid.length > 0) {
    throw httpError(400, `URLs invalidas (se espera https://x.com/<user>/status/<id>): ${invalid.join(", ")}`);
  }

  const options = resolveJobOptions(body.options ?? {});
  const created = urls.map((url) => ({
    id: randomUUID(),
    url,
    options,
    status: "queued",
    stage: null,
    created_at: new Date().toISOString(),
    finished_at: null,
    slug: null,
    title: null,
    reply_count: 0,
    failures: [],
    error: null,
  }));

  // La cola corre desde el final de `jobs`: invertimos para respetar el orden pegado.
  jobs.unshift(...[...created].reverse());
  trimFinishedJobs();
  broadcast();
  runQueue();
  return created;
}

// Mismas reglas derivadas que la CLI: `comments` activa replies best-effort via browser.
function resolveJobOptions(input) {
  const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  const comments = Boolean(input.comments);
  const signals = pick(input.signals, SIGNAL_MODES, comments ? "x-basic" : "none");

  return {
    format: pick(input.format, OUTPUT_FORMATS, "bundle"),
    images: pick(input.images, IMAGE_MODES, "embed"),
    embeddedPosts: pick(input.embeddedPosts, EMBEDDED_POST_MODES, "quote"),
    signals: comments && signals === "none" ? "x-basic" : signals,
    xProvider: pick(input.xProvider, X_PROVIDERS, comments ? "browser" : "hybrid"),
    xReplies: comments ? "best-effort" : "none",
    xQuotes: "none",
    brief: pick(input.brief, BRIEF_MODES, "none"),
    chunk: "none",
    output: null,
    assetsDir: null,
    bearerTokenEnv: "X_BEARER_TOKEN",
    grokApiKeyEnv: "XAI_API_KEY",
    browserStorageState: process.env.X_BROWSER_STORAGE_STATE || null,
    browserCdpEndpoint: process.env.X_BROWSER_CDP_ENDPOINT || null,
    timeout: 120000,
    comments,
  };
}

async function runQueue() {
  if (queueRunning) {
    return;
  }
  queueRunning = true;

  try {
    let job;
    while ((job = jobs.findLast((candidate) => candidate.status === "queued"))) {
      await runJob(job);
    }
  } finally {
    queueRunning = false;
  }
}

async function runJob(job) {
  job.status = "running";
  broadcast();

  try {
    const { prepared } = await downloadArticle({ ...job.options, url: job.url }, (stage) => {
      job.stage = stage;
      broadcast();
    });
    const { document } = prepared;
    job.status = "done";
    job.slug = document.article.slug;
    job.title = document.article.title;
    job.reply_count = document.signals?.conversation?.reply_count_collected ?? 0;
    job.failures = document.signals?.provider_trace.failures ?? [];
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    job.stage = null;
    job.finished_at = new Date().toISOString();
    trimFinishedJobs();
    broadcast();
  }
}

// Solo descarta terminados viejos: los que estan en cola o corriendo nunca se pierden.
function trimFinishedJobs() {
  let finished = 0;
  for (let index = 0; index < jobs.length; index += 1) {
    if (jobs[index].status !== "done" && jobs[index].status !== "error") {
      continue;
    }
    finished += 1;
    if (finished > MAX_JOBS_KEPT) {
      jobs.splice(index, 1);
      index -= 1;
    }
  }
}

function clearFinishedJobs() {
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    if (jobs[index].status === "done" || jobs[index].status === "error") {
      jobs.splice(index, 1);
    }
  }
  broadcast();
}

function publicJob(job) {
  const { options, ...rest } = job;
  return {
    ...rest,
    options: {
      format: options.format,
      images: options.images,
      comments: options.comments,
      signals: options.signals,
    },
  };
}

function openEventStream(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({ jobs: jobs.map(publicJob) })}\n\n`);
  subscribers.add(response);

  const keepAlive = setInterval(() => response.write(": ping\n\n"), 25000);
  request.on("close", () => {
    clearInterval(keepAlive);
    subscribers.delete(response);
  });
}

function broadcast() {
  const payload = `data: ${JSON.stringify({ jobs: jobs.map(publicJob) })}\n\n`;
  for (const subscriber of subscribers) {
    subscriber.write(payload);
  }
}

function resolveInside(root, ...segments) {
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw httpError(400, "Ruta invalida");
  }
  return resolved;
}

async function sendFile(response, filePath, asAttachment = false) {
  let content;
  try {
    content = await fs.readFile(filePath);
  } catch {
    throw httpError(404, "Archivo no encontrado");
  }

  const headers = {
    "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-store",
  };
  if (asAttachment) {
    headers["content-disposition"] = `attachment; filename="${path.basename(filePath)}"`;
  }
  response.writeHead(200, headers);
  response.end(content);
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw httpError(413, "Body demasiado grande");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "JSON invalido");
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
