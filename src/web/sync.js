import { scanBookmarkArticles } from "../providers/x-bookmarks.js";
import { getLibraryKeys } from "./library.js";

const MAX_ATTEMPTS = 2;
const TERMINAL = new Set(["done", "error", "cancelled", "skipped"]);

// Sincronizacion de bookmarks: escanear -> (revisar) -> descargar, con un solo
// proceso a la vez. Las descargas usan la misma cola de jobs que la pagina Agregar.
export function createBookmarkSync({ root, cdpEndpoint, enqueue, cancelJobs, onChange }) {
  let state = initialState();
  let stopRequested = false;
  let enqueuing = false;

  function initialState() {
    return {
      status: "idle",
      settings: { auto: true, limit: 20 },
      scan: { scanned: 0, known: 0, duplicates: 0, complete: false },
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
      settings: { auto: settings.auto !== false, limit },
      started_at: new Date().toISOString(),
    };
    stopRequested = false;
    onChange();

    // El escaneo corre en segundo plano; el progreso llega por SSE.
    scan().catch((error) => finish("error", error.message));
    return snapshot();
  }

  async function scan() {
    const keys = await getLibraryKeys(root);
    const result = await scanBookmarkArticles({
      cdpEndpoint,
      limit: state.settings.limit,
      shouldStop: () => stopRequested,
      isKnown: ({ statusId, titleKey }) => keys.statusIds.has(statusId) || (Boolean(titleKey) && keys.titles.has(titleKey)),
      onProgress: (progress) => {
        state.scan = { scanned: progress.scanned, known: progress.known, duplicates: progress.duplicates, complete: false };
        mergeFound(progress.found);
        onChange();
      },
    });

    state.scan = { scanned: result.scanned, known: result.known, duplicates: result.duplicates, complete: result.complete };
    mergeFound(result.found);

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

  function snapshot() {
    const counts = {};
    for (const item of state.items) counts[item.state] = (counts[item.state] ?? 0) + 1;
    return { ...state, counts, cdp_configured: Boolean(cdpEndpoint) };
  }

  return { start, download, stop, updateFromJobs, snapshot };
}
