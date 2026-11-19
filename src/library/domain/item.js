import { invalid, requireName } from "./errors.js";

// Item: la unidad unica de la biblioteca. Carpetas y listas de lectura solo lo
// referencian por id, nunca lo copian.
//
// Un item separa lo capturado de lo curado:
// - capturado (title, authors): si el item tiene `source`, lo dicta la fuente
//   y se refresca en cada sincronizacion;
// - curado (tags, physical, notes, cover): es del usuario y la sincronizacion no lo toca.
//
// La tapa (`cover`) es una imagen guardada por huella: `file` es
// "<sha256>.<ext>" y `origin` dice de donde salio (una URL, "pagina 1 del PDF").

export const ITEM_KINDS = ["article", "book", "paper", "notes", "slides", "problem-set", "handwritten", "document"];

const MAX_TAG_LENGTH = 50;

export function createItem({ id, kind, title, authors = [], year = null, notes = "", tags = [], physical = null, cover = null, source = null, now }) {
  if (!ITEM_KINDS.includes(kind)) {
    throw invalid(`Tipo de item desconocido: ${kind}.`);
  }
  return {
    id,
    kind,
    title: requireName(title, "El item"),
    authors: normalizeAuthors(authors),
    year: normalizeYear(year),
    notes: String(notes ?? "").trim(),
    tags: normalizeTags(tags),
    physical: normalizePhysical(physical),
    cover: normalizeCover(cover),
    source: source ? { key: String(source.key), ref: source.ref ?? {} } : null,
    createdAt: now,
    updatedAt: now,
  };
}

// Cambios hechos por el usuario. En un item con fuente, titulo y autores no se editan.
export function reviseItem(item, changes, now) {
  const descriptive = ["kind", "title", "authors", "year"].filter((field) => field in changes);
  if (item.source && descriptive.length > 0) {
    throw invalid("El título, los autores y el tipo de este item vienen de su fuente y no se editan a mano.");
  }

  const next = { ...item, updatedAt: now };
  if ("kind" in changes) {
    if (!ITEM_KINDS.includes(changes.kind)) throw invalid(`Tipo de item desconocido: ${changes.kind}.`);
    next.kind = changes.kind;
  }
  if ("title" in changes) next.title = requireName(changes.title, "El item");
  if ("authors" in changes) next.authors = normalizeAuthors(changes.authors);
  if ("year" in changes) next.year = normalizeYear(changes.year);
  if ("notes" in changes) next.notes = String(changes.notes ?? "").trim();
  if ("tags" in changes) next.tags = normalizeTags(changes.tags);
  // Un cambio parcial (solo la ubicacion, solo los tomos) conserva el resto.
  if ("physical" in changes) next.physical = normalizePhysical({ ...item.physical, ...changes.physical });
  if ("cover" in changes) next.cover = normalizeCover(changes.cover);
  return next;
}

// Refresca solo lo capturado. Devuelve el mismo objeto si nada cambio.
export function refreshFromSource(item, captured, now) {
  const title = requireName(captured.title, "El item");
  const authors = normalizeAuthors(captured.authors);
  const ref = captured.ref ?? item.source.ref;
  const same = title === item.title
    && JSON.stringify(authors) === JSON.stringify(item.authors)
    && JSON.stringify(ref) === JSON.stringify(item.source.ref);
  if (same) {
    return item;
  }
  return { ...item, title, authors, source: { ...item.source, ref }, updatedAt: now };
}

// Une `absorbed` dentro de `target`: el que queda conserva su identidad y su
// descripcion, y suma lo curado del otro. El caso tipico es un libro registrado
// a mano que absorbe el item creado por su PDF.
export function absorbItem(target, absorbed, now) {
  if (target.id === absorbed.id) {
    throw invalid("No se puede unir un item consigo mismo.");
  }
  if (absorbed.source) {
    throw invalid("Un item que viene de una fuente sincronizada no puede unirse dentro de otro: volvería a aparecer al sincronizar.");
  }
  return {
    ...target,
    authors: target.source || target.authors.length > 0 ? target.authors : absorbed.authors,
    year: target.source ? target.year : target.year ?? absorbed.year,
    notes: [target.notes, absorbed.notes].filter(Boolean).join("\n\n"),
    tags: normalizeTags([...target.tags, ...absorbed.tags]),
    physical: target.physical.owned ? target.physical : absorbed.physical,
    cover: target.cover ?? absorbed.cover ?? null,
    updatedAt: now,
  };
}

export function normalizeTag(value) {
  const tag = String(value ?? "").replace(/^#+/, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (tag.length > MAX_TAG_LENGTH) {
    throw invalid(`Una etiqueta no puede tener más de ${MAX_TAG_LENGTH} caracteres.`);
  }
  return tag;
}

export function normalizeTags(values) {
  if (!Array.isArray(values)) {
    throw invalid("Las etiquetas deben ser una lista.");
  }
  return [...new Set(values.map(normalizeTag).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeAuthors(values) {
  if (!Array.isArray(values)) {
    throw invalid("Los autores deben ser una lista.");
  }
  return values.map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

function normalizeYear(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const year = Number(value);
  if (!Number.isInteger(year) || year < 0 || year > 3000) {
    throw invalid("El año debe ser un número entero.");
  }
  return year;
}

// Copia fisica: "lo tengo impreso o comprado", con ubicacion opcional.
// Una obra puede estar repartida en varios tomos (un libro anillado en partes):
// siguen siendo un solo item, y cada tomo puede tener su propia ubicacion.
// Ubicacion y tomos solo tienen sentido si la copia existe.
function normalizePhysical(value) {
  const owned = Boolean(value?.owned);
  const location = owned ? cleanLine(value?.location) : "";
  return { owned, location: location || null, volumes: owned ? normalizeVolumes(value?.volumes ?? []) : [] };
}

function normalizeVolumes(values) {
  if (!Array.isArray(values)) {
    throw invalid("Los tomos deben ser una lista.");
  }
  const volumes = values
    .map((volume) => ({ name: cleanLine(volume?.name), location: cleanLine(volume?.location) || null }))
    .filter((volume) => volume.name);
  const names = volumes.map((volume) => volume.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw invalid("Hay dos tomos con el mismo nombre.");
  }
  return volumes;
}

const COVER_FILE = /^[0-9a-f]{64}\.(jpg|png|webp)$/;

function normalizeCover(value) {
  if (value == null) return null;
  const file = String(value.file ?? "");
  if (!COVER_FILE.test(file)) {
    throw invalid("La tapa debe ser una imagen guardada en la biblioteca.");
  }
  return { file, origin: cleanLine(value.origin) || null };
}

const cleanLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
