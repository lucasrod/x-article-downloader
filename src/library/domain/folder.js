import { conflict, invalid, notFound, requireName } from "./errors.js";

// Carpeta: nodo de un arbol que clasifica. Contiene referencias a items y a
// listas de lectura; el mismo item puede estar en varias carpetas. No tiene orden.

export function createFolder(folders, { id, name, parentId = null, now }) {
  const folder = { id, name: requireName(name, "La carpeta"), parentId, itemIds: [], listIds: [], createdAt: now };
  assertParentExists(folders, parentId);
  assertUniqueAmongSiblings(folders, folder);
  return folder;
}

export function renameFolder(folders, folder, name) {
  const next = { ...folder, name: requireName(name, "La carpeta") };
  assertUniqueAmongSiblings(folders, next);
  return next;
}

export function moveFolder(folders, folder, parentId) {
  assertParentExists(folders, parentId);
  if (parentId !== null && subtreeIds(folders, folder.id).includes(parentId)) {
    throw invalid("Una carpeta no puede moverse dentro de sí misma ni de una de sus subcarpetas.");
  }
  const next = { ...folder, parentId };
  assertUniqueAmongSiblings(folders, next);
  return next;
}

// Colocar y quitar son idempotentes: una referencia esta o no esta.
export function placeInFolder(folder, { itemId = null, listId = null }) {
  return {
    ...folder,
    itemIds: itemId && !folder.itemIds.includes(itemId) ? [...folder.itemIds, itemId] : folder.itemIds,
    listIds: listId && !folder.listIds.includes(listId) ? [...folder.listIds, listId] : folder.listIds,
  };
}

export function takeOutOfFolder(folder, { itemId = null, listId = null }) {
  return {
    ...folder,
    itemIds: folder.itemIds.filter((id) => id !== itemId),
    listIds: folder.listIds.filter((id) => id !== listId),
  };
}

// La carpeta y todas sus descendientes.
export function subtreeIds(folders, rootId) {
  const ids = [rootId];
  for (let index = 0; index < ids.length; index += 1) {
    for (const folder of folders) {
      if (folder.parentId === ids[index]) ids.push(folder.id);
    }
  }
  return ids;
}

// La carpeta y todas sus ancestros, de adentro hacia afuera.
export function ancestryIds(folders, folderId) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids = [];
  for (let current = byId.get(folderId); current && !ids.includes(current.id); current = byId.get(current.parentId)) {
    ids.push(current.id);
  }
  return ids;
}

function assertParentExists(folders, parentId) {
  if (parentId !== null && !folders.some((folder) => folder.id === parentId)) {
    throw notFound("La carpeta de destino no existe.");
  }
}

function assertUniqueAmongSiblings(folders, candidate) {
  const key = candidate.name.toLowerCase();
  const clash = folders.some((folder) => folder.id !== candidate.id
    && folder.parentId === candidate.parentId
    && folder.name.toLowerCase() === key);
  if (clash) {
    throw conflict(`Ya hay una carpeta "${candidate.name}" en ese lugar.`);
  }
}
