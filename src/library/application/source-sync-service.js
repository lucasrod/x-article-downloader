import { conflict, invalid, notFound } from "../domain/errors.js";
import { createFolder, placeInFolder } from "../domain/folder.js";
import { directoriesOf, planFolderSync } from "../domain/folder-sync.js";
import { createItem } from "../domain/item.js";
import {
  createSourceFolder,
  importsFolders,
  markSynced,
  reviseSourceFolder,
  titleFromFileName,
} from "../domain/source-folder.js";

// Casos de uso de las carpetas de origen: registrar una carpeta del disco y
// sincronizar sus PDFs con la biblioteca. Puertos en ports.js.

export function createSourceSyncService({ repository, scanner, store, textExtractor = null, newId, now, onChange = () => {} }) {
  // Progreso en memoria de la sincronizacion en curso o de la ultima, por carpeta.
  const runs = new Map();

  async function requireSource(id) {
    const source = (await repository.listSources()).find((candidate) => candidate.id === id);
    if (!source) throw notFound("Esa carpeta de origen no existe.");
    return source;
  }

  const isRunning = (id) => ["scanning", "hashing", "processing"].includes(runs.get(id)?.status);

  function report(id, patch) {
    runs.set(id, { ...runs.get(id), ...patch });
    onChange();
  }

  // Devuelve el id de la carpeta de biblioteca para una ruta de nombres,
  // creando las que falten. Reusa las que ya existan con el mismo nombre.
  async function ensureFolderPath(folders, names) {
    let parentId = null;
    for (const name of names) {
      let folder = folders.find((candidate) => candidate.parentId === parentId
        && candidate.name.toLowerCase() === name.trim().toLowerCase());
      if (!folder) {
        folder = createFolder(folders, { id: newId(), name, parentId, now: now() });
        await repository.saveFolder(folder);
        folders.push(folder);
      }
      parentId = folder.id;
    }
    return parentId;
  }

  async function run(source) {
    const id = source.id;
    report(id, { status: "scanning", done: 0, total: 0, error: null, summary: null, startedAt: now() });

    const entries = await scanner.list(source.path);
    const previous = await repository.listLocations(source.id);
    const previousByPath = new Map(previous.map((entry) => [entry.relPath, entry]));

    // Solo se vuelve a calcular la huella de lo que cambio de tamaño o fecha.
    report(id, { status: "hashing", total: entries.length });
    const scanned = [];
    for (const entry of entries) {
      const known = previousByPath.get(entry.relPath);
      const unchanged = known && known.size === entry.size && known.mtimeMs === entry.mtimeMs;
      scanned.push({ ...entry, sha256: unchanged ? known.sha256 : await scanner.hash(source.path, entry.relPath) });
      report(id, { done: scanned.length });
    }

    const files = new Map((await repository.listFiles()).map((file) => [file.sha256, file]));
    const elsewhere = new Set((await repository.listLocations()).filter((entry) => entry.sourceId !== id).map((entry) => entry.sha256));
    const plan = planFolderSync({ scanned, previous, files, elsewhere });

    const baseName = (relPath) => relPath.split("/").pop();
    const fileRecord = (entry, itemId) => ({
      sha256: entry.sha256, itemId, size: entry.size, name: baseName(entry.relPath),
      archived: false, pages: null, textChars: null, addedAt: now(),
    });

    const mirror = importsFolders(source);
    const folders = mirror ? await repository.listFolders() : [];
    const placements = new Map();
    const newItems = [];
    const newFiles = [];

    for (const entry of plan.create) {
      const item = createItem({ id: newId(), kind: "document", title: titleFromFileName(baseName(entry.relPath)), now: now() });
      newItems.push(item);
      newFiles.push(fileRecord(entry, item.id));
      if (mirror) {
        const folderId = await ensureFolderPath(folders, [source.label, ...directoriesOf(entry.relPath)]);
        placements.set(folderId, [...(placements.get(folderId) ?? []), item.id]);
      }
    }
    for (const entry of plan.newVersions) {
      newFiles.push(fileRecord(entry, entry.itemId));
    }

    await repository.saveItems(newItems);
    await repository.saveFiles(newFiles);
    for (const [folderId, itemIds] of placements) {
      let folder = folders.find((candidate) => candidate.id === folderId);
      for (const itemId of itemIds) folder = placeInFolder(folder, { itemId });
      await repository.saveFolder(folder);
    }
    await repository.replaceLocations(source.id, plan.locations);

    // La version anterior de un archivo editado solo se conserva si estaba archivada.
    const unreachable = plan.newVersions.map((entry) => files.get(entry.replaces)).filter((file) => file && !file.archived);
    await repository.deleteFiles(unreachable.map((file) => file.sha256));

    // Archivar y extraer texto de lo que todavia no lo tenga.
    for (const file of newFiles) files.set(file.sha256, file);
    const firstPath = new Map();
    for (const entry of scanned) if (!firstPath.has(entry.sha256)) firstPath.set(entry.sha256, entry.relPath);
    const pending = [...firstPath].map(([sha256, relPath]) => ({ file: files.get(sha256), relPath }))
      .filter(({ file }) => file?.itemId && ((source.policy === "archive" && !file.archived) || (textExtractor && file.textChars === null)));

    report(id, { status: "processing", done: 0, total: pending.length });
    let archived = 0;
    let failures = 0;
    for (const [index, { file, relPath }] of pending.entries()) {
      const next = { ...file };
      const absolute = scanner.resolve(source.path, relPath);
      try {
        if (source.policy === "archive" && !file.archived) {
          await store.archive(absolute, file.sha256);
          next.archived = true;
          archived += 1;
        }
        if (textExtractor && file.textChars === null) {
          const extracted = await textExtractor.extract(absolute);
          next.pages = extracted?.pages ?? null;
          next.textChars = extracted?.text.length ?? 0;
          await repository.saveFiles([next]);
          await repository.saveFileText(file.sha256, extracted?.text ?? "");
        } else {
          await repository.saveFiles([next]);
        }
      } catch {
        // Un archivo ilegible no frena al resto; queda pendiente para la proxima.
        failures += 1;
      }
      report(id, { done: index + 1 });
    }

    await repository.saveSource(markSynced(source, now()));
    report(id, {
      status: "done",
      summary: {
        scanned: scanned.length,
        created: plan.create.length,
        new_versions: plan.newVersions.length,
        moved: plan.moved,
        missing: plan.gone.length,
        archived,
        failures,
        folders_imported: mirror,
      },
    });
  }

  return {
    async listSources() {
      const [sources, locations] = await Promise.all([repository.listSources(), repository.listLocations()]);
      return sources.map((source) => ({
        ...source,
        fileCount: locations.filter((entry) => entry.sourceId === source.id).length,
        run: runs.get(source.id) ?? null,
      }));
    },

    async addSourceFolder({ path, label, policy }) {
      const source = createSourceFolder(await repository.listSources(), { id: newId(), path, label, policy, now: now() });
      if (!(await scanner.isDirectory(source.path))) {
        throw invalid(`No encuentro la carpeta ${source.path}.`);
      }
      await repository.saveSource(source);
      return source;
    },

    async reviseSource(id, changes) {
      const source = reviseSourceFolder(await requireSource(id), changes);
      await repository.saveSource(source);
      return source;
    },

    // Quita la carpeta de la biblioteca. Los items quedan; los archivos no
    // archivados dejan de estar disponibles.
    async removeSource(id) {
      await requireSource(id);
      if (isRunning(id)) throw conflict("Esa carpeta se está sincronizando.");
      await repository.deleteSource(id);
      runs.delete(id);
    },

    // Arranca la sincronizacion y devuelve la promesa de su final. El progreso
    // se consulta con listSources().
    async startSync(id) {
      const source = await requireSource(id);
      if (isRunning(id)) throw conflict("Esa carpeta ya se está sincronizando.");
      if (!(await scanner.isDirectory(source.path))) {
        throw invalid(`No encuentro la carpeta ${source.path}. Si está en un disco externo, conectalo y probá de nuevo.`);
      }
      const finished = run(source).catch((error) => {
        report(id, { status: "error", error: error.message ?? String(error) });
      });
      return { finished };
    },

    // Archivos de un item con sus ubicaciones en disco, del mas nuevo al mas viejo.
    async describeFiles(itemId) {
      const [files, locations, sources] = await Promise.all([repository.listFiles(), repository.listLocations(), repository.listSources()]);
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      return files
        .filter((file) => file.itemId === itemId)
        .sort((left, right) => right.addedAt.localeCompare(left.addedAt))
        .map((file) => ({
          ...file,
          locations: locations
            .filter((entry) => entry.sha256 === file.sha256 && sourceById.has(entry.sourceId))
            .map((entry) => scanner.resolve(sourceById.get(entry.sourceId).path, entry.relPath)),
        }));
    },

    // Ruta legible del archivo vigente de un item: el almacen si esta archivado,
    // si no la primera ubicacion que siga existiendo. null si no hay ninguna.
    async locateFile(itemId) {
      for (const file of await this.describeFiles(itemId)) {
        if (file.archived && await store.has(file.sha256)) {
          return { path: store.pathOf(file.sha256), name: file.name };
        }
        for (const location of file.locations) {
          if (await scanner.isFile(location)) return { path: location, name: file.name };
        }
      }
      return null;
    },
  };
}
