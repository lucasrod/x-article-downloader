import fs from "node:fs/promises";
import path from "node:path";

// Indice en memoria de downloads/articles para busqueda de texto y facetas.
// Se reconstruye solo cuando cambian los archivos (firma por mtime).

const WORDS_PER_MINUTE = 230;
const X_EPOCH_MS = 1288834974657n;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DATE_PRESETS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

export const LENGTH_BUCKETS = [
  { value: "short", label: "Corto (<5 min)", max: 5 },
  { value: "medium", label: "Medio (5–15 min)", max: 15 },
  { value: "long", label: "Largo (>15 min)", max: Infinity },
];

export const FEATURES = {
  images: "Con imágenes",
  embeds: "Con posts embebidos",
  comments: "Con comentarios",
};

const SPANISH_HINTS = new Set(["que", "de", "la", "el", "los", "las", "por", "para", "con", "una", "como", "pero", "es", "en", "del", "se", "lo", "más", "mas", "muy", "porque", "también", "tambien"]);
const ENGLISH_HINTS = new Set(["the", "and", "of", "to", "is", "that", "it", "for", "you", "with", "this", "are", "on", "your", "but", "be", "what", "how", "they", "not"]);

let cache = { signature: null, docs: [] };

export async function searchLibrary(root, params, now = Date.now()) {
  const docs = await loadIndex(root);
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
  const sort = resolveSort(params.get("sort"), query);
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

// ---------- indice ----------

async function loadIndex(root) {
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
  const [titleNorm, titleMap] = normalizeWithMap(title);
  const [contentNorm, contentMap] = normalizeWithMap(content);

  return {
    slug,
    title,
    author_name: authorName,
    author_handle: authorHandle,
    status_url: document.source.status_url,
    published_at: statusIdToDate(document.source.status_id),
    fetched_at: document.source.fetched_at ?? null,
    words,
    reading_minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    image_count: document.article.images?.length ?? 0,
    embed_count: document.article.embedded_posts?.length ?? 0,
    reply_count: signals?.conversation?.reply_count_collected ?? 0,
    lang: detectLanguage(contentNorm),
    content,
    titleNorm,
    titleMap,
    contentNorm,
    contentMap,
    authorNorm: normalize(`${authorName} ${authorHandle}`),
  };
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
    status_url: doc.status_url,
    published_at: doc.published_at,
    fetched_at: doc.fetched_at,
    words: doc.words,
    reading_minutes: doc.reading_minutes,
    image_count: doc.image_count,
    embed_count: doc.embed_count,
    reply_count: doc.reply_count,
    lang: doc.lang,
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

function lengthBucket(minutes) {
  return LENGTH_BUCKETS.find((bucket) => minutes < bucket.max || bucket.max === Infinity).value;
}

function hasFeature(doc, feature) {
  if (feature === "images") return doc.image_count > 0;
  if (feature === "embeds") return doc.embed_count > 0;
  if (feature === "comments") return doc.reply_count > 0;
  return false;
}

const PREDICATES = {
  author: (doc, values) => values.length === 0 || values.includes(doc.author_handle),
  pub: (doc, filter, now) => matchesDate(doc.published_at, filter, now),
  len: (doc, values) => values.length === 0 || values.includes(lengthBucket(doc.reading_minutes)),
  lang: (doc, values) => values.length === 0 || values.includes(doc.lang),
  has: (doc, values) => values.every((feature) => hasFeature(doc, feature)),
  dl: (doc, filter, now) => matchesDate(doc.fetched_at, filter, now),
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
  const authorCounts = countBy(authorBase, (doc) => doc.author_handle);
  const authorNames = new Map(matched.map(({ doc }) => [doc.author_handle, doc.author_name]));
  for (const handle of filters.author) {
    if (!authorCounts.has(handle)) authorCounts.set(handle, 0);
  }

  const lenCounts = countBy(applyFilters(matched, filters, now, "len"), (doc) => lengthBucket(doc.reading_minutes));
  const langCounts = countBy(applyFilters(matched, filters, now, "lang"), (doc) => doc.lang);
  const hasBase = applyFilters(matched, filters, now, "has");

  return {
    author: [...authorCounts.entries()]
      .map(([value, count]) => ({ value, label: authorNames.get(value) || value, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    pub: datePresetCounts(applyFilters(matched, filters, now, "pub"), "published_at", now),
    len: LENGTH_BUCKETS.map((bucket) => ({ value: bucket.value, label: bucket.label, count: lenCounts.get(bucket.value) ?? 0 })),
    lang: [["es", "Español"], ["en", "Inglés"], ["other", "Otro / sin detectar"]]
      .map(([value, label]) => ({ value, label, count: langCounts.get(value) ?? 0 })),
    has: Object.entries(FEATURES).map(([value, label]) => {
      const others = filters.has.filter((feature) => feature !== value);
      const base = hasBase.filter(({ doc }) => others.every((feature) => hasFeature(doc, feature)));
      return { value, label, count: base.filter(({ doc }) => hasFeature(doc, value)).length };
    }),
    dl: datePresetCounts(applyFilters(matched, filters, now, "dl"), "fetched_at", now),
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
  longest: (left, right) => right.doc.words - left.doc.words,
  shortest: (left, right) => left.doc.words - right.doc.words,
  author: (left, right) => (left.doc.author_name || left.doc.author_handle)
    .localeCompare(right.doc.author_name || right.doc.author_handle),
};

function resolveSort(requested, query) {
  if (requested && requested in SORTERS && !(requested === "relevance" && query.terms.length === 0)) {
    return requested;
  }
  return query.terms.length ? "relevance" : "newest";
}
