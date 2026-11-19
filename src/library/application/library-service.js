import { notFound, invalid } from "../domain/errors.js";
import { createItem, refreshFromSource, reviseItem } from "../domain/item.js";
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
  reviseReadingList,
} from "../domain/reading-list.js";

// Casos de uso de la biblioteca. Orquesta dominio y puertos (ver ports.js);
// no conoce HTTP, SQLite ni el filesystem.

export function createLibraryService({ repository, sources = [], newId, now }) {
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
      const [folders, lists] = await Promise.all([repository.listFolders(), repository.listReadingLists()]);
      return {
        item,
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
      const [items, folders, lists] = await Promise.all([
        repository.listItems(),
        repository.listFolders(),
        repository.listReadingLists(),
      ]);

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

      return { items, folders, lists, membership };
    },
  };
}
