import { invalid } from "../domain/errors.js";

// Snapshot del catalogo: todo lo que el usuario construyo, en una forma
// estable que se puede versionar y volver a cargar. Quedan afuera los datos que
// se regeneran solos (texto de los PDFs, ubicaciones en disco, hora de la ultima
// sincronizacion), para que el historial muestre solo cambios reales.

export const SNAPSHOT_VERSION = 1;

export async function takeSnapshot(repository) {
  const [items, folders, readingLists, relations, sources, files] = await Promise.all([
    repository.listItems(),
    repository.listFolders(),
    repository.listReadingLists(),
    repository.listRelations(),
    repository.listSources(),
    repository.listFiles(),
  ]);
  return {
    version: SNAPSHOT_VERSION,
    items: [...items].sort(byId),
    folders: [...folders].sort(byId),
    readingLists: [...readingLists].sort(byId),
    relations: [...relations].sort(byId),
    sources: sources.map(({ lastSyncedAt, ...source }) => source).sort(byId),
    files: files.map(({ textChars, ...file }) => file).sort((left, right) => left.sha256.localeCompare(right.sha256)),
  };
}

// Carga un snapshot en un catalogo vacio. Los archivos vuelven sin texto: la
// proxima sincronizacion de su carpeta lo extrae de nuevo.
export async function restoreSnapshot(repository, snapshot) {
  if (snapshot?.version !== SNAPSHOT_VERSION) {
    throw invalid(`No sé leer esta versión del catálogo (${snapshot?.version}).`);
  }
  if ((await repository.listItems()).length > 0) {
    throw invalid("El catálogo ya tiene items: restaurar solo funciona sobre uno vacío.");
  }

  await repository.saveItems(snapshot.items);
  for (const folder of parentsFirst(snapshot.folders)) await repository.saveFolder(folder);
  for (const list of snapshot.readingLists) await repository.saveReadingList(list);
  await repository.saveRelations(snapshot.relations);
  for (const source of snapshot.sources) await repository.saveSource({ ...source, lastSyncedAt: null });
  await repository.saveFiles(snapshot.files.map((file) => ({ ...file, textChars: null })));
}

// Avisa despues de cada escritura del repositorio. Sirve para mantener el
// snapshot al dia sin que cada caso de uso tenga que acordarse.
export function notifyingChanges(repository, onChange) {
  const notifying = {};
  for (const [name, method] of Object.entries(repository)) {
    notifying[name] = typeof method === "function" && /^(save|delete|replace)/.test(name)
      ? async (...args) => {
        const result = await method.apply(repository, args);
        onChange(name);
        return result;
      }
      : method;
  }
  return notifying;
}

const byId = (left, right) => left.id.localeCompare(right.id);

function parentsFirst(folders) {
  const pending = new Map(folders.map((folder) => [folder.id, folder]));
  const ordered = [];
  const visit = (folder) => {
    if (!pending.has(folder.id)) return;
    pending.delete(folder.id);
    if (folder.parentId && pending.has(folder.parentId)) visit(pending.get(folder.parentId));
    ordered.push(folder);
  };
  for (const folder of folders) visit(folder);
  return ordered;
}
