import { conflict, invalid, notFound, requireName } from "./errors.js";

// Lista de lectura: secuencia ordenada de referencias a items, cada una con una
// nota opcional. El orden es el del arreglo `entries`. Un item aparece una vez.

export function createReadingList({ id, name, description = "", now }) {
  return {
    id,
    name: requireName(name, "La lista"),
    description: String(description ?? "").trim(),
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function reviseReadingList(list, changes, now) {
  const next = { ...list, updatedAt: now };
  if ("name" in changes) next.name = requireName(changes.name, "La lista");
  if ("description" in changes) next.description = String(changes.description ?? "").trim();
  return next;
}

export function addEntry(list, itemId, now, note = "") {
  if (list.entries.some((entry) => entry.itemId === itemId)) {
    throw conflict("Ese item ya está en la lista.");
  }
  return { ...list, entries: [...list.entries, { itemId, note: String(note ?? "").trim() }], updatedAt: now };
}

export function removeEntry(list, itemId, now) {
  return { ...list, entries: list.entries.filter((entry) => entry.itemId !== itemId), updatedAt: now };
}

// Mueve una entrada a la posicion `index` (base 0) de la lista resultante.
export function moveEntry(list, itemId, index, now) {
  const from = requireEntryIndex(list, itemId);
  if (!Number.isInteger(index) || index < 0 || index >= list.entries.length) {
    throw invalid("La posición está fuera de la lista.");
  }
  const entries = [...list.entries];
  const [entry] = entries.splice(from, 1);
  entries.splice(index, 0, entry);
  return { ...list, entries, updatedAt: now };
}

export function annotateEntry(list, itemId, note, now) {
  const at = requireEntryIndex(list, itemId);
  const entries = list.entries.map((entry, index) => index === at ? { ...entry, note: String(note ?? "").trim() } : entry);
  return { ...list, entries, updatedAt: now };
}

function requireEntryIndex(list, itemId) {
  const index = list.entries.findIndex((entry) => entry.itemId === itemId);
  if (index === -1) {
    throw notFound("Ese item no está en la lista.");
  }
  return index;
}
