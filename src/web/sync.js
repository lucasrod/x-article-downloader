import fs from "node:fs/promises";
import path from "node:path";
import { scanBookmarkArticles } from "../providers/x-bookmarks.js";
import { getLibraryKeys } from "./library.js";

const MAX_ATTEMPTS = 2;
const TERMINAL = new Set(["done", "error", "cancelled", "skipped"]);
const CACHE_FILE = ".bookmarks-cache.json";

// Sincronizacion de bookmarks: escanear -> (revisar) -> descargar, con un solo
// proceso a la vez. Las descargas usan la misma cola de jobs que la pagina Agregar.
export function createBookmarkSync({ root, cdpEndpoint, enqueue, cancelJobs, onChange }) {
  let state = initialState();
  let stopRequested = false;
  let enqueuing = false;
  // Ids de status de todos los bookmarks ya revisados (Articles o no), para que
  // las sincronizaciones siguientes lean solo los nuevos.
  const cachePath = path.join(root, CACHE_FILE);
  let cache = { seen: new Set(), full_scan_at: null, updated_at: null };
  const cacheLoaded = loadCache();

  function initialState() {
    return {
      status: "idle",
      settings: { auto: true, limit: 20, full: false },
      scan: { scanned: 0, known: 0, duplicates: 0, complete: false, incremental: false, reached_seen: false },
      items: [],
      error: null,
      started_at: null,
      finished_at: null,
    };
  }

  function busy() {
    return state.status === "scanning" || state.status === "downloading";
  }

  async function start(settings = {}) {
    if (busy()) {
      throw Object.assign(new Error("Ya hay una sincronizacion en curso."), { status: 409 });
    }

    const limit = settings.limit === null ? null : Math.max(1, Math.min(1000, Number(settings.limit) || 20));
    state = {
      ...initialState(),
      status: "scanning",
      settings: { auto: settings.auto !== false, limit, full: settings.full === true },
      started_at: new Date().toISOString(),
    };
    stopRequested = false;
    onChange();

    // El escaneo corre en segundo plano; el progreso llega por SSE.
    scan().catch((error) => finish("error", error.message));
    return snapshot();
  }

  async function scan() {
    await cacheLoaded;
    const keys = await getLibraryKeys(root);
    const incremental = !state.settings.full;
    state.scan.incremental = incremental;
    const result = await scanBookmarkArticles({
      cdpEndpoint,
      limit: state.settings.limit,
      isSeen: incremental && cache.seen.size > 0 ? (statusId) => cache.seen.has(statusId) : null,
      stopAtKnown: incremental,
      shouldStop: () => stopRequested,
      isKnown: ({ statusId, titleKey }) => keys.statusIds.has(statusId) || (Boolean(titleKey) && keys.titles.has(titleKey)),
      onProgress: (progress) => {
        state.scan = { ...state.scan, scanned: progress.scanned, known: progress.known, duplicates: progress.duplicates };
        mergeFound(progress.found);
        onChange();
      },
    });

    state.scan = {
      ...state.scan,
      scanned: result.scanned,
      known: result.known,
      duplicates: result.duplicates,
      complete: result.complete,
      reached_seen: result.reachedSeen,
    };
    mergeFound(result.found);
    // Solo se guarda un tramo que empalma con lo ya revisado (o llega al final):
    // si el escaneo corto antes, quedarian bookmarks viejos sin revisar debajo.
    if (!stopRequested && (result.complete || result.reachedSeen)) {
      await saveCache(result.ids, result.complete);
    }

    if (stopRequested) return finish("cancelled");
    if (state.items.length === 0) return finish("done");
    if (state.settings.auto) return download(state.items.map((item) => item.url));
    state.status = "review";
    onChange();
  }

  function mergeFound(found) {
    const known = new Set(state.items.map((item) => item.url));
    for (const entry of found) {
      if (!known.has(entry.url)) {
        state.items.push({ ...entry, state: "found", job_id: null, slug: null, stage: null, error: null, attempts: 0 });
      }
    }
  }

  function download(urls) {
    if (state.status !== "review" && state.status !== "scanning") {
      throw Object.assign(new Error("No hay bookmarks escaneados para descargar."), { status: 409 });
    }
    const selected = new Set(urls);
    const items = state.items.filter((item) => selected.has(item.url));
    if (items.length === 0) {
      throw Object.assign(new Error("Elegi al menos un articulo."), { status: 400 });
    }
    for (const item of state.items) {
      if (!selected.has(item.url)) item.state = "skipped";
    }

    state.status = "downloading";
    enqueueItems(items);
    onChange();
    return snapshot();
  }

  function enqueueItems(items) {
    // enqueue dispara un broadcast; sin este guard los items todavia sin job
    // harian parecer terminada la sincronizacion.
    enqueuing = true;
    let jobs;
    try {
      jobs = enqueue(items.map((item) => item.url));
    } finally {
      enqueuing = false;
    }
    for (const job of jobs) {
      const item = items.find((candidate) => candidate.url === job.url);
      item.job_id = job.id;
      item.state = "queued";
      item.error = null;
      item.attempts += 1;
    }
  }

  function stop() {
    if (state.status === "scanning") {
      stopRequested = true;
    } else if (state.status === "downloading") {
      const pending = state.items.filter((item) => item.state === "queued");
      cancelJobs(pending.map((item) => item.job_id));
      for (const item of pending) item.state = "cancelled";
      // El articulo que se esta descargando termina normalmente.
      if (!state.items.some((item) => item.state === "running")) finish("cancelled");
      else state.stopping = true;
    } else if (state.status === "review") {
      finish("cancelled");
    }
    onChange();
    return snapshot();
  }

  // Refleja el estado de los jobs en los items y reintenta una vez los que fallan.
  function updateFromJobs(jobs) {
    if (state.status !== "downloading" || enqueuing) return;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const retries = [];

    for (const item of state.items) {
      const job = item.job_id && byId.get(item.job_id);
      if (!job || TERMINAL.has(item.state)) continue;
      item.stage = job.stage;
      if (job.status === "done") {
        item.state = "done";
        item.slug = job.slug;
        item.title = job.title ?? item.title;
      } else if (job.status === "error") {
        if (item.attempts < MAX_ATTEMPTS && !state.stopping) {
          retries.push(item);
        } else {
          item.state = "error";
          item.error = job.error;
        }
      } else {
        item.state = job.status;
      }
    }

    if (retries.length) {
      for (const item of retries) item.state = "retrying";
      queueMicrotask(() => {
        enqueueItems(retries);
        onChange();
      });
      return;
    }

    const active = state.items.filter((item) => !TERMINAL.has(item.state) && item.state !== "found");
    if (active.length === 0) finish(state.stopping ? "cancelled" : "done");
  }

  function finish(status, error = null) {
    state.status = status;
    state.error = error;
    state.stopping = false;
    state.finished_at = new Date().toISOString();
    onChange();
  }

  async function loadCache() {
    try {
      const saved = JSON.parse(await fs.readFile(cachePath, "utf8"));
      cache = { seen: new Set(saved.seen ?? []), full_scan_at: saved.full_scan_at ?? null, updated_at: saved.updated_at ?? null };
    } catch {
      // Sin cache: la primera sincronizacion recorre todo.
    }
  }

  async function saveCache(ids, complete) {
    const now = new Date().toISOString();
    if (complete) {
      cache.seen = new Set(ids);
      cache.full_scan_at = now;
    } else {
      for (const id of ids) cache.seen.add(id);
    }
    cache.updated_at = now;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify({ seen: [...cache.seen], full_scan_at: cache.full_scan_at, updated_at: cache.updated_at }, null, 2)}\n`);
  }

  function snapshot() {
    const counts = {};
    for (const item of state.items) counts[item.state] = (counts[item.state] ?? 0) + 1;
    return {
      ...state,
      counts,
      cdp_configured: Boolean(cdpEndpoint),
      cache: { size: cache.seen.size, full_scan_at: cache.full_scan_at, updated_at: cache.updated_at },
    };
  }

  return { start, download, stop, updateFromJobs, snapshot };
}
