import fs from "node:fs/promises";
import path from "node:path";

// Busqueda de texto, filtros y facetas sobre "docs" en memoria.
// Los docs de articulos salen de downloads/articles (el indice se reconstruye
// solo cuando cambian los archivos, firma por mtime). La biblioteca agrega los
// campos de catalogo (item_id, kind, tags, carpetas, listas) en catalog-search.js.

const WORDS_PER_MINUTE = 230;
const X_EPOCH_MS = 1288834974657n;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DATE_PRESETS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

// Un articulo se mide en minutos de lectura; un documento, en paginas.
export const LENGTH_BUCKETS = [
  { value: "short", label: "Corto (<5 min · <30 pág.)", max: 5, maxPages: 30 },
  { value: "medium", label: "Medio (5–15 min · 30–150 pág.)", max: 15, maxPages: 150 },
  { value: "long", label: "Largo (>15 min · >150 pág.)", max: Infinity, maxPages: Infinity },
];

// Palabras de una pagina impresa tipica: sirve para comparar el largo de un
// documento con el de un articulo al ordenar.
const WORDS_PER_PAGE = 400;

export const LANGUAGE_LABELS = {
  es: "Español",
  en: "Inglés",
  pt: "Portugués",
  fr: "Francés",
  it: "Italiano",
  de: "Alemán",
  other: "Otro / sin detectar",
};

export const KIND_LABELS = {
  article: "Artículo de X",
  book: "Libro",
  paper: "Paper",
  notes: "Notas de curso",
  slides: "Slides",
  "problem-set": "Práctico / repartido",
  handwritten: "Notas manuscritas",
  document: "Otro documento",
};

export const FEATURES = {
  images: "Con imágenes",
  embeds: "Con posts embebidos",
  comments: "Con comentarios",
  file: "Con archivo PDF",
};

const SPANISH_HINTS = new Set(["que", "de", "la", "el", "los", "las", "por", "para", "con", "una", "como", "pero", "es", "en", "del", "se", "lo", "más", "mas", "muy", "porque", "también", "tambien"]);
const ENGLISH_HINTS = new Set(["the", "and", "of", "to", "is", "that", "it", "for", "you", "with", "this", "are", "on", "your", "but", "be", "what", "how", "they", "not"]);

let cache = { signature: null, docs: [] };

export async function searchLibrary(root, params, now = Date.now()) {
  return searchDocs(await loadArticleDocs(root), params, now);
}

export function searchDocs(docs, params, now = Date.now()) {
  const query = parseQuery(params.get("q") ?? "");
  const filters = parseFilters(params);

  const matched = [];
  for (const doc of docs) {
    const score = scoreDocument(doc, query);
    if (score !== null) {
      matched.push({ doc, score });
    }
  }

  const results = applyFilters(matched, filters, now);
  const sort = resolveSort(params.get("sort"), query, filters);
  results.sort(SORTERS[sort]);

  return {
    total: docs.length,
    count: results.length,
    sort,
    query: query.terms,
    results: results.map(({ doc, score }) => ({
      ...publicFields(doc),
      score,
      title_segments: highlight(doc.title, doc.titleNorm, doc.titleMap, query.terms),
      snippet: query.terms.length ? buildSnippet(doc, query.terms) : buildLead(doc),
    })),
    facets: buildFacets(matched, filters, now),
  };
}

// Claves para saber si un bookmark ya esta en la biblioteca (por status o por titulo).
export async function getLibraryKeys(root) {
  const docs = await loadArticleDocs(root);
  return {
    statusIds: new Set(docs.map((doc) => doc.status_id).filter(Boolean)),
    titles: new Set(docs.map((doc) => doc.titleNorm).filter(Boolean)),
  };
}

// ---------- indice ----------

export async function loadArticleDocs(root) {
  let entries;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }

  const stamps = await Promise.all(entries.map(async (entry) => {
    const dir = path.join(root, entry.name);
    const [json, signals] = await Promise.all([
      fs.stat(path.join(dir, "article.json")).then((stat) => stat.mtimeMs).catch(() => 0),
      fs.stat(path.join(dir, "signals.json")).then((stat) => stat.mtimeMs).catch(() => 0),
    ]);
    return `${entry.name}:${json}:${signals}`;
  }));
  const signature = stamps.sort().join("|");
  if (signature === cache.signature) {
    return cache.docs;
  }

  const docs = await Promise.all(entries.map((entry) => indexArticle(path.join(root, entry.name), entry.name).catch(() => null)));
  cache = { signature, docs: docs.filter(Boolean) };
  return cache.docs;
}

async function indexArticle(dir, slug) {
  const document = JSON.parse(await fs.readFile(path.join(dir, "article.json"), "utf8"));
  const signals = await fs.readFile(path.join(dir, "signals.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => document.signals ?? null);

  const blocks = document.article.blocks ?? [];
  const content = blocks.map(blockText).filter(Boolean).join("\n\n");
  const words = content.match(/\S+/g)?.length ?? 0;
  const title = document.article.title ?? slug;
  const authorName = document.source.author_name ?? "";
  const authorHandle = document.source.author_handle ?? "";

  return createDoc({
    slug,
    title,
    content,
    author_name: authorName,
    author_handle: authorHandle,
    author_avatar: document.source.author_avatar ?? null,
    status_url: document.source.status_url,
    status_id: document.source.status_id ?? null,
    published_at: statusIdToDate(document.source.status_id),
    fetched_at: document.source.fetched_at ?? null,
    words,
    reading_minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    image_count: document.article.images?.length ?? 0,
    thumbnail: thumbnailUrl(slug, document.article.images?.[0]?.src),
    embed_count: document.article.embedded_posts?.length ?? 0,
    reply_count: signals?.conversation?.reply_count_collected ?? 0,
  });
}

// Completa un doc con los campos derivados que usa la busqueda. Sirve tambien
// para items sin articulo en disco (un libro registrado a mano).
export function createDoc(fields) {
  const [titleNorm, titleMap] = normalizeWithMap(fields.title);
  const [contentNorm, contentMap] = normalizeWithMap(fields.content ?? "");
  return {
    slug: null,
    author_name: "",
    author_handle: "",
    author_avatar: null,
    status_url: null,
    status_id: null,
    published_at: null,
    fetched_at: null,
    words: 0,
    reading_minutes: null,
    pages: null,
    published: null,
    image_count: 0,
    thumbnail: null,
    embed_count: 0,
    reply_count: 0,
    kind: "article",
    ...fields,
    content: fields.content ?? "",
    author_key: fields.author_handle || fields.author_name || "",
    // El idioma cargado a mano gana; si no hay, se detecta del texto.
    lang: fields.lang || detectLanguage(contentNorm),
    titleNorm,
    titleMap,
    contentNorm,
    contentMap,
    authorNorm: normalize(`${fields.author_name ?? ""} ${fields.author_handle ?? ""}`),
  };
}

// Primera imagen en tamaño chico: las de X se piden con name=small; las
// descargadas en assets/ se sirven por la ruta de archivos del articulo.
function thumbnailUrl(slug, src) {
  if (!src || src.startsWith("data:")) {
    return null;
  }
  if (/^https?:\/\//.test(src)) {
    const url = new URL(src);
    if (url.hostname === "pbs.twimg.com") url.searchParams.set("name", "small");
    return url.toString();
  }
  return `/api/articles/${encodeURIComponent(slug)}/files/${src.replace(/^\.\//, "")}`;
}

function blockText(block) {
  if (block.type === "list") {
    return block.items.map(stripInlineMarkdown).join("\n");
  }
  if (block.type === "image" || block.type === "separator") {
    return "";
  }
  return stripInlineMarkdown(block.text ?? "");
}

function stripInlineMarkdown(text) {
  return String(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]+/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function statusIdToDate(statusId) {
  if (!/^\d+$/.test(String(statusId ?? ""))) {
    return null;
  }
  return new Date(Number((BigInt(statusId) >> 22n) + X_EPOCH_MS)).toISOString();
}

function detectLanguage(normalizedText) {
  let spanish = 0;
  let english = 0;
  for (const word of normalizedText.slice(0, 20000).split(/[^a-z]+/)) {
    if (SPANISH_HINTS.has(word)) spanish += 1;
    if (ENGLISH_HINTS.has(word)) english += 1;
  }
  if (spanish + english < 20) {
    return "other";
  }
  return spanish > english ? "es" : "en";
}

function publicFields(doc) {
  return {
    slug: doc.slug,
    title: doc.title,
    author_name: doc.author_name,
    author_handle: doc.author_handle,
    author_avatar: doc.author_avatar,
    status_url: doc.status_url,
    published_at: doc.published_at,
    fetched_at: doc.fetched_at,
    words: doc.words,
    reading_minutes: doc.reading_minutes,
    pages: doc.pages ?? null,
    published: doc.published ?? null,
    image_count: doc.image_count,
    thumbnail: doc.thumbnail,
    embed_count: doc.embed_count,
    reply_count: doc.reply_count,
    lang: doc.lang,
    item_id: doc.item_id ?? null,
    kind: doc.kind,
    tags: doc.tags ?? [],
    physical: doc.physical ?? { owned: false, location: null, volumes: [] },
    cover_url: doc.cover_url ?? null,
    has_source: doc.has_source ?? true,
    folder_ids: doc.folder_ids ?? [],
    list_ids: doc.list_ids ?? [],
    list_note: doc.list_note ?? "",
    file: doc.file ?? null,
  };
}

// ---------- texto ----------

export function normalize(text) {
  return normalizeWithMap(text)[0];
}

// Normaliza caracter por caracter (sin tildes, minusculas) y guarda el indice
// original de cada caracter normalizado para poder resaltar sobre el texto real.
function normalizeWithMap(text) {
  let normalized = "";
  const map = [];
  const source = String(text ?? "");
  for (let index = 0; index < source.length; index += 1) {
    const folded = source[index].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (const char of folded) {
      normalized += char;
      map.push(index);
    }
  }
  return [normalized, map];
}

export function parseQuery(raw) {
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const term = normalize(match[1] ?? match[2]).trim();
    if (term) {
      terms.push(term);
    }
  }
  return { terms: [...new Set(terms)] };
}

function scoreDocument(doc, query) {
  if (query.terms.length === 0) {
    return 0;
  }

  let score = 0;
  for (const term of query.terms) {
    const inTitle = doc.titleNorm.includes(term);
    const inAuthor = doc.authorNorm.includes(term);
    const contentHits = countOccurrences(doc.contentNorm, term, 10);
    if (!inTitle && !inAuthor && contentHits === 0) {
      return null;
    }
    score += (inTitle ? 10 : 0) + (inAuthor ? 5 : 0) + contentHits;
  }
  return score;
}

function countOccurrences(haystack, needle, limit) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < limit) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// Devuelve el texto partido en segmentos [{ text, mark }] para resaltar en el cliente.
function highlight(original, normalized, map, terms, start = 0, end = original.length) {
  const ranges = [];
  for (const term of terms) {
    let index = normalized.indexOf(term);
    while (index !== -1) {
      const from = map[index];
      const to = map[index + term.length - 1] + 1;
      if (to > start && from < end) {
        ranges.push([Math.max(from, start), Math.min(to, end)]);
      }
      index = normalized.indexOf(term, index + term.length);
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);

  const segments = [];
  let cursor = start;
  for (const [from, to] of ranges) {
    if (to <= cursor) continue;
    if (from > cursor) segments.push({ text: original.slice(cursor, from), mark: false });
    segments.push({ text: original.slice(Math.max(from, cursor), to), mark: true });
    cursor = to;
  }
  if (cursor < end) segments.push({ text: original.slice(cursor, end), mark: false });
  return segments;
}

function buildSnippet(doc, terms) {
  const positions = terms
    .map((term) => doc.contentNorm.indexOf(term))
    .filter((index) => index !== -1);
  if (positions.length === 0) {
    return buildLead(doc);
  }

  const center = doc.contentMap[Math.min(...positions)];
  let start = Math.max(0, center - 90);
  let end = Math.min(doc.content.length, center + 180);
  if (start > 0) start = doc.content.indexOf(" ", start) + 1 || start;
  if (end < doc.content.length) end = doc.content.lastIndexOf(" ", end) > start ? doc.content.lastIndexOf(" ", end) : end;

  const segments = highlight(doc.content, doc.contentNorm, doc.contentMap, terms, start, end)
    .map((segment) => ({ ...segment, text: segment.text.replace(/\s+/g, " ") }));
  if (start > 0) segments.unshift({ text: "…", mark: false });
  if (end < doc.content.length) segments.push({ text: "…", mark: false });
  return segments;
}

function buildLead(doc) {
  const text = doc.content.slice(0, 220).replace(/\s+/g, " ");
  return [{ text: doc.content.length > 220 ? `${text.slice(0, text.lastIndexOf(" "))}…` : text, mark: false }];
}

// ---------- filtros y facetas ----------

function splitList(value) {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function parseFilters(params) {
  return {
    author: splitList(params.get("author")),
    pub: parseDateFilter(params.get("pub"), params.get("pub_from"), params.get("pub_to")),
    len: splitList(params.get("len")),
    lang: splitList(params.get("lang")),
    has: splitList(params.get("has")).filter((feature) => feature in FEATURES),
    dl: parseDateFilter(params.get("dl"), params.get("dl_from"), params.get("dl_to")),
    kind: splitList(params.get("kind")),
    tag: splitList(params.get("tag")),
    physical: splitList(params.get("physical")),
    folder: params.get("folder") || null,
    list: params.get("list") || null,
  };
}

function parseDateFilter(preset, from, to) {
  if (preset && preset in DATE_PRESETS) {
    return { preset };
  }
  if (from || to) {
    return { from: from || null, to: to || null };
  }
  return null;
}

function matchesDate(iso, filter, now) {
  if (!filter) return true;
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (filter.preset) {
    return time >= now - DAY_MS * DATE_PRESETS[filter.preset];
  }
  if (filter.from && time < new Date(`${filter.from}T00:00:00`).getTime()) return false;
  if (filter.to && time > new Date(`${filter.to}T23:59:59.999`).getTime()) return false;
  return true;
}

function lengthBucket(doc) {
  if (doc.pages != null) {
    return LENGTH_BUCKETS.find((bucket) => doc.pages < bucket.maxPages || bucket.maxPages === Infinity).value;
  }
  if (doc.reading_minutes == null) return null;
  return LENGTH_BUCKETS.find((bucket) => doc.reading_minutes < bucket.max || bucket.max === Infinity).value;
}

const sizeOf = (doc) => (doc.pages != null ? doc.pages * WORDS_PER_PAGE : doc.words);

function hasFeature(doc, feature) {
  if (feature === "images") return doc.image_count > 0;
  if (feature === "embeds") return doc.embed_count > 0;
  if (feature === "comments") return doc.reply_count > 0;
  if (feature === "file") return Boolean(doc.file);
  return false;
}

const PREDICATES = {
  author: (doc, values) => values.length === 0 || values.includes(doc.author_key),
  pub: (doc, filter, now) => matchesDate(doc.published_at, filter, now),
  len: (doc, values) => values.length === 0 || values.includes(lengthBucket(doc)),
  lang: (doc, values) => values.length === 0 || values.includes(doc.lang),
  has: (doc, values) => values.every((feature) => hasFeature(doc, feature)),
  dl: (doc, filter, now) => matchesDate(doc.fetched_at, filter, now),
  kind: (doc, values) => values.length === 0 || values.includes(doc.kind),
  tag: (doc, values) => values.every((tag) => (doc.tags ?? []).includes(tag)),
  physical: (doc, values) => values.length === 0 || values.includes(doc.physical?.owned ? "yes" : "no"),
  folder: (doc, id) => !id || (id === "none" ? (doc.folder_ids ?? []).length === 0 : (doc.folder_scope ?? []).includes(id)),
  list: (doc, id) => !id || (doc.list_ids ?? []).includes(id),
};

function applyFilters(entries, filters, now, skip = null) {
  return entries.filter(({ doc }) => Object.entries(PREDICATES)
    .every(([key, predicate]) => key === skip || predicate(doc, filters[key], now)));
}

function countBy(entries, keyOf) {
  const counts = new Map();
  for (const { doc } of entries) {
    const key = keyOf(doc);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function datePresetCounts(entries, field, now) {
  return Object.keys(DATE_PRESETS).map((preset) => ({
    value: preset,
    count: entries.filter(({ doc }) => matchesDate(doc[field], { preset }, now)).length,
  }));
}

// Cada faceta cuenta con todos los demas filtros aplicados, pero no el suyo,
// asi se ve cuantos resultados daria elegir otra opcion de la misma faceta.
function buildFacets(matched, filters, now) {
  const authorBase = applyFilters(matched, filters, now, "author");
  const authorCounts = countBy(authorBase.filter(({ doc }) => doc.author_key), (doc) => doc.author_key);
  const authorNames = new Map(matched.map(({ doc }) => [doc.author_key, doc.author_name]));
  const authorHandles = new Map(matched.map(({ doc }) => [doc.author_key, doc.author_handle]));
  const authorAvatars = new Map(matched.map(({ doc }) => [doc.author_key, doc.author_avatar]));
  for (const handle of filters.author) {
    if (!authorCounts.has(handle)) authorCounts.set(handle, 0);
  }

  const lenCounts = countBy(applyFilters(matched, filters, now, "len"), (doc) => lengthBucket(doc));
  const langCounts = countBy(applyFilters(matched, filters, now, "lang"), (doc) => doc.lang);
  const hasBase = applyFilters(matched, filters, now, "has");
  const kindCounts = countBy(applyFilters(matched, filters, now, "kind"), (doc) => doc.kind);
  const physicalCounts = countBy(applyFilters(matched, filters, now, "physical"), (doc) => doc.physical?.owned ? "yes" : "no");
  // Las etiquetas se combinan con "y": cada una cuenta sobre lo ya filtrado.
  const tagCounts = new Map();
  for (const { doc } of applyFilters(matched, filters, now)) {
    for (const tag of doc.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  for (const tag of filters.tag) {
    if (!tagCounts.has(tag)) tagCounts.set(tag, 0);
  }

  return {
    author: [...authorCounts.entries()]
      .map(([value, count]) => ({ value, label: authorNames.get(value) || value, handle: authorHandles.get(value) || "", avatar: authorAvatars.get(value) ?? null, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    pub: datePresetCounts(applyFilters(matched, filters, now, "pub"), "published_at", now),
    len: LENGTH_BUCKETS.map((bucket) => ({ value: bucket.value, label: bucket.label, count: lenCounts.get(bucket.value) ?? 0 })),
    lang: [...new Set(["es", "en", ...langCounts.keys(), ...filters.lang, "other"])]
      .map((value) => ({ value, label: LANGUAGE_LABELS[value] ?? value, count: langCounts.get(value) ?? 0 })),
    has: Object.entries(FEATURES).map(([value, label]) => {
      const others = filters.has.filter((feature) => feature !== value);
      const base = hasBase.filter(({ doc }) => others.every((feature) => hasFeature(doc, feature)));
      return { value, label, count: base.filter(({ doc }) => hasFeature(doc, value)).length };
    }),
    dl: datePresetCounts(applyFilters(matched, filters, now, "dl"), "fetched_at", now),
    kind: Object.entries(KIND_LABELS)
      .map(([value, label]) => ({ value, label, count: kindCounts.get(value) ?? 0 }))
      .filter((option) => option.count > 0 || filters.kind.includes(option.value)),
    tag: [...tagCounts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    physical: [["yes", "En mi biblioteca física"], ["no", "Solo digital o sin copia"]]
      .map(([value, label]) => ({ value, label, count: physicalCounts.get(value) ?? 0 })),
  };
}

// ---------- orden ----------

const byDate = (field, direction) => (left, right) =>
  direction * (String(left.doc[field] ?? "").localeCompare(String(right.doc[field] ?? "")));

const SORTERS = {
  relevance: (left, right) => right.score - left.score || byDate("published_at", -1)(left, right),
  newest: byDate("published_at", -1),
  oldest: byDate("published_at", 1),
  downloaded: byDate("fetched_at", -1),
  longest: (left, right) => sizeOf(right.doc) - sizeOf(left.doc),
  shortest: (left, right) => sizeOf(left.doc) - sizeOf(right.doc),
  author: (left, right) => (left.doc.author_name || left.doc.author_handle)
    .localeCompare(right.doc.author_name || right.doc.author_handle),
  title: (left, right) => left.doc.title.localeCompare(right.doc.title),
  // Orden propio de la lista de lectura elegida.
  list: (left, right) => (left.doc.list_position ?? 0) - (right.doc.list_position ?? 0),
};

function resolveSort(requested, query, filters) {
  const allowed = requested && requested in SORTERS
    && !(requested === "relevance" && query.terms.length === 0)
    && !(requested === "list" && !filters.list);
  if (allowed) {
    return requested;
  }
  if (query.terms.length) return "relevance";
  return filters.list ? "list" : "newest";
}
