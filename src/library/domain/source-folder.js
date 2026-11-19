import { conflict, invalid, requireName } from "./errors.js";

// Carpeta de origen: una carpeta del disco cuyo material entra a la biblioteca.
// La politica decide que pasa con cada archivo:
// - archive: se guarda una copia en el almacen por huella; el item sobrevive
//   aunque el original se mueva o se borre;
// - reference: solo se indexa; el archivo se lee desde donde esta.

export const SOURCE_POLICIES = ["archive", "reference"];

export function createSourceFolder(existing, { id, path, label = "", policy = "archive", now }) {
  const normalized = normalizePath(path);
  for (const other of existing) {
    if (other.path === normalized) {
      throw conflict("Esa carpeta ya está en la biblioteca.");
    }
    if (isInside(normalized, other.path) || isInside(other.path, normalized)) {
      throw conflict(`Esa carpeta se superpone con "${other.path}", que ya está en la biblioteca.`);
    }
  }
  return {
    id,
    path: normalized,
    label: requireName(label || normalized.split("/").pop(), "La carpeta de origen"),
    policy: requirePolicy(policy),
    foldersImportedAt: null,
    lastSyncedAt: null,
    createdAt: now,
  };
}

export function reviseSourceFolder(source, changes) {
  const next = { ...source };
  if ("label" in changes) next.label = requireName(changes.label, "La carpeta de origen");
  if ("policy" in changes) next.policy = requirePolicy(changes.policy);
  return next;
}

// La estructura de subcarpetas del disco se importa una sola vez; despues la
// organizacion es del usuario y sincronizar no la toca.
export function markSynced(source, now) {
  return { ...source, lastSyncedAt: now, foldersImportedAt: source.foldersImportedAt ?? now };
}

export const importsFolders = (source) => source.foldersImportedAt === null;

// Titulo inicial de un item a partir del nombre de su archivo. Es solo una
// sugerencia: el usuario lo puede corregir y sincronizar no lo vuelve a pisar.
export function titleFromFileName(name) {
  const title = String(name).replace(/\.[^.\/]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return title || String(name);
}

function normalizePath(value) {
  const path = String(value ?? "").trim().replace(/\/+$/, "");
  if (!path.startsWith("/")) {
    throw invalid("La carpeta debe indicarse con su ruta completa, por ejemplo /Users/vos/Documentos/Estudio.");
  }
  return path;
}

function requirePolicy(policy) {
  if (!SOURCE_POLICIES.includes(policy)) {
    throw invalid(`Política desconocida: ${policy}.`);
  }
  return policy;
}

const isInside = (child, parent) => child.startsWith(`${parent}/`);
