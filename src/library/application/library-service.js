import { notFound, invalid } from "../domain/errors.js";
import { absorbItem, createItem, refreshFromSource, reviseItem } from "../domain/item.js";
import { createRelation, relationsOf, repointRelations } from "../domain/relation.js";
import {
  ancestryIds,
  createFolder,
  moveFolder,
  placeInFolder,
  renameFolder,
  subtreeIds,
  takeOutOfFolder,
} from "../domain/folder.js";
import {
  addEntry,
  annotateEntry,
  createReadingList,
  moveEntry,
  removeEntry,
  replaceEntry,
  reviseReadingList,
} from "../domain/reading-list.js";

// Casos de uso de la biblioteca. Orquesta dominio y puertos (ver ports.js);
// no conoce HTTP, SQLite ni el filesystem.

export function createLibraryService({ repository, sources = [], covers = null, newId, now }) {
  async function requireItem(id) {
    const item = await repository.getItem(id);
    if (!item) throw notFound("Ese item no existe.");
    return item;
  }

  async function requireFolder(id) {
    const folders = await repository.listFolders();
    const folder = folders.find((candidate) => candidate.id === id);
    if (!folder) throw notFound("Esa carpeta no existe.");
    return { folders, folder };
  }

  async function requireList(id) {
    const list = await repository.getReadingList(id);
    if (!list) throw notFound("Esa lista no existe.");
    return list;
  }

  return {
    // ---------- items ----------

    async registerItem(input) {
      const item = createItem({ ...input, id: newId(), source: null, now: now() });
      await repository.saveItems([item]);
      return item;
    },

    async reviseItem(id, changes) {
      const item = reviseItem(await requireItem(id), changes, now());
      await repository.saveItems([item]);
      return item;
    },

    // La tapa es curada: una foto, la pagina 1 de un PDF, la imagen de la editorial.
    async setItemCover(id, { bytes, extension, origin = null }) {
      const current = await requireItem(id);
      if (!covers) throw invalid("Esta biblioteca no tiene donde guardar tapas.");
      const file = await covers.put(bytes, extension);
      const item = reviseItem(current, { cover: { file, origin } }, now());
      await repository.saveItems([item]);
      return item;
    },

    async removeItemCover(id) {
      const item = reviseItem(await requireItem(id), { cover: null }, now());
      await repository.saveItems([item]);
      return item;
    },

    async removeItem(id) {
      const item = await requireItem(id);
      if (item.source) {
        throw invalid("Este item viene de una fuente sincronizada; se va de la biblioteca cuando se borra en su origen.");
      }
      await repository.deleteItem(id);
    },

    // Item con las carpetas y listas que lo referencian.
    async describeItem(id) {
      const item = await requireItem(id);
      const [folders, lists, relations, items] = await Promise.all([
        repository.listFolders(),
        repository.listReadingLists(),
        repository.listRelations(),
        repository.listItems(),
      ]);
      const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
      return {
        item,
        relations: relationsOf(relations, id)
          .map((relation) => ({ ...relation, other: byId.get(relation.otherId) }))
          .filter((relation) => relation.other),
        folderIds: folders.filter((folder) => folder.itemIds.includes(id)).map((folder) => folder.id),
        listIds: lists.filter((list) => list.entries.some((entry) => entry.itemId === id)).map((list) => list.id),
      };
    },

    async findItemBySource(key) {
      return (await repository.listItems()).find((item) => item.source?.key === key) ?? null;
    },

    // Trae a la biblioteca el material capturado por las fuentes. Crea items
    // nuevos y refresca lo capturado de los existentes; nunca toca lo curado.
    async syncSources() {
      const captured = (await Promise.all(sources.map((source) => source.listCaptured()))).flat();
      const byKey = new Map((await repository.listItems()).filter((item) => item.source).map((item) => [item.source.key, item]));
      const changed = [];
      let created = 0;

      for (const entry of captured) {
        const existing = byKey.get(entry.key);
        try {
          if (!existing) {
            const item = createItem({
              id: newId(),
              kind: entry.kind,
              title: entry.title,
              authors: entry.authors,
              source: { key: entry.key, ref: entry.ref },
              now: now(),
            });
            byKey.set(entry.key, item);
            changed.push(item);
            created += 1;
          } else {
            const refreshed = refreshFromSource(existing, entry, now());
            if (refreshed !== existing) changed.push(refreshed);
          }
        } catch {
          // Material capturado sin titulo valido: se saltea, no rompe la sincronizacion.
        }
      }

      if (changed.length > 0) await repository.saveItems(changed);
      return { created, refreshed: changed.length - created };
    },

    // Une `absorbedId` dentro de `targetId`. Archivos, carpetas, listas y
    // relaciones del absorbido pasan al que queda; el absorbido desaparece.
    async mergeItems(targetId, absorbedId) {
      const merged = absorbItem(await requireItem(targetId), await requireItem(absorbedId), now());
      const [files, folders, lists, relations] = await Promise.all([
        repository.listFiles(),
        repository.listFolders(),
        repository.listReadingLists(),
        repository.listRelations(),
      ]);

      await repository.saveItems([merged]);
      await repository.saveFiles(files.filter((file) => file.itemId === absorbedId).map((file) => ({ ...file, itemId: targetId })));
      for (const folder of folders.filter((candidate) => candidate.itemIds.includes(absorbedId))) {
        await repository.saveFolder(placeInFolder(takeOutOfFolder(folder, { itemId: absorbedId }), { itemId: targetId }));
      }
      for (const list of lists.filter((candidate) => candidate.entries.some((entry) => entry.itemId === absorbedId))) {
        await repository.saveReadingList(replaceEntry(list, absorbedId, targetId, now()));
      }
      const { changed, dropped } = repointRelations(relations, absorbedId, targetId);
      await repository.deleteRelations(dropped);
      await repository.saveRelations(changed);
      await repository.deleteItem(absorbedId);
      return merged;
    },

    // ---------- relaciones ----------

    async relateItems({ fromId, toId, type, note = "" }) {
      await requireItem(fromId);
      await requireItem(toId);
      const relation = createRelation(await repository.listRelations(), { id: newId(), fromId, toId, type, note, now: now() });
      await repository.saveRelations([relation]);
      return relation;
    },

    async unrelate(relationId) {
      await repository.deleteRelations([relationId]);
    },

    // El grafo de conocimiento: los items que tienen alguna relacion y sus aristas.
    async graph() {
      const [items, relations] = await Promise.all([repository.listItems(), repository.listRelations()]);
      const connected = new Set(relations.flatMap((relation) => [relation.fromId, relation.toId]));
      return { nodes: items.filter((item) => connected.has(item.id)), edges: relations };
    },

    // ---------- carpetas ----------

    async createFolder({ name, parentId = null }) {
      const folders = await repository.listFolders();
      const folder = createFolder(folders, { id: newId(), name, parentId, now: now() });
      await repository.saveFolder(folder);
      return folder;
    },

    async reviseFolder(id, changes) {
      const { folders, folder } = await requireFolder(id);
      let next = folder;
      if ("parentId" in changes) next = moveFolder(folders, next, changes.parentId ?? null);
      if ("name" in changes) next = renameFolder(folders, next, changes.name);
      await repository.saveFolder(next);
      return next;
    },

    // Borra la carpeta y sus subcarpetas. Los items y listas referenciados siguen en la biblioteca.
    async removeFolder(id) {
      const { folders } = await requireFolder(id);
      await repository.deleteFolders(subtreeIds(folders, id));
    },

    async placeInFolder(folderId, { itemId = null, listId = null }) {
      const { folder } = await requireFolder(folderId);
      if (itemId) await requireItem(itemId);
      if (listId) await requireList(listId);
      await repository.saveFolder(placeInFolder(folder, { itemId, listId }));
    },

    async takeOutOfFolder(folderId, reference) {
      const { folder } = await requireFolder(folderId);
      await repository.saveFolder(takeOutOfFolder(folder, reference));
    },

    // ---------- listas de lectura ----------

    async createReadingList(input) {
      const list = createReadingList({ ...input, id: newId(), now: now() });
      await repository.saveReadingList(list);
      return list;
    },

    async reviseReadingList(id, changes) {
      const list = reviseReadingList(await requireList(id), changes, now());
      await repository.saveReadingList(list);
      return list;
    },

    async removeReadingList(id) {
      await requireList(id);
      await repository.deleteReadingList(id);
    },

    async addToReadingList(listId, itemId, note = "") {
      await requireItem(itemId);
      const list = addEntry(await requireList(listId), itemId, now(), note);
      await repository.saveReadingList(list);
      return list;
    },

    async removeFromReadingList(listId, itemId) {
      const list = removeEntry(await requireList(listId), itemId, now());
      await repository.saveReadingList(list);
      return list;
    },

    // Cambia posicion y/o nota de una entrada existente.
    async reviseReadingListEntry(listId, itemId, { position, note }) {
      let list = await requireList(listId);
      if (note !== undefined) list = annotateEntry(list, itemId, note, now());
      if (position !== undefined) list = moveEntry(list, itemId, position, now());
      await repository.saveReadingList(list);
      return list;
    },

    // ---------- lecturas ----------

    // Todo el catalogo con las pertenencias ya resueltas, para buscar y filtrar.
    // `folderScope` incluye las carpetas ancestro: filtrar por una carpeta
    // muestra tambien lo que esta en sus subcarpetas.
    async snapshot() {
      const [items, folders, lists, files, locations] = await Promise.all([
        repository.listItems(),
        repository.listFolders(),
        repository.listReadingLists(),
        repository.listFiles(),
        repository.listLocations(),
      ]);

      // Archivos de cada item, del mas nuevo al mas viejo. `available` dice si
      // hay de donde leerlo: el almacen o alguna ubicacion conocida en disco.
      const located = new Set(locations.map((entry) => entry.sha256));
      const filesByItem = new Map();
      for (const file of [...files].reverse()) {
        if (!file.itemId) continue;
        if (!filesByItem.has(file.itemId)) filesByItem.set(file.itemId, []);
        filesByItem.get(file.itemId).push({ ...file, available: file.archived || located.has(file.sha256) });
      }

      const membership = new Map(items.map((item) => [item.id, { folderIds: [], folderScope: new Set(), lists: [] }]));
      for (const folder of folders) {
        const scope = ancestryIds(folders, folder.id);
        for (const itemId of folder.itemIds) {
          const entry = membership.get(itemId);
          if (!entry) continue;
          entry.folderIds.push(folder.id);
          for (const id of scope) entry.folderScope.add(id);
        }
      }
      for (const list of lists) {
        list.entries.forEach((entry, position) => {
          membership.get(entry.itemId)?.lists.push({ id: list.id, position, note: entry.note });
        });
      }

      return { items, folders, lists, membership, filesByItem };
    },
  };
}
