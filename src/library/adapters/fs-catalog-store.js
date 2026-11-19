import fs from "node:fs/promises";
import path from "node:path";

// CatalogStore en disco, pensado para git: un archivo por item (un cambio en
// un item es un diff chico) y un archivo por cada coleccion chica. Solo
// reescribe lo que cambio, y borra los items que ya no existen.

const COLLECTIONS = {
  folders: "folders.json",
  readingLists: "reading-lists.json",
  relations: "relations.json",
  sources: "sources.json",
  files: "files.json",
};

const format = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function createCatalogStore(dir) {
  const itemsDir = path.join(dir, "items");

  async function writeIfChanged(file, content) {
    const current = await fs.readFile(file, "utf8").catch(() => null);
    if (current === content) return false;
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, file);
    return true;
  }

  return {
    async write(snapshot) {
      await fs.mkdir(itemsDir, { recursive: true });
      let changed = 0;
      if (await writeIfChanged(path.join(dir, "catalog.json"), format({ version: snapshot.version }))) changed += 1;
      for (const [key, file] of Object.entries(COLLECTIONS)) {
        if (await writeIfChanged(path.join(dir, file), format(snapshot[key]))) changed += 1;
      }

      const keep = new Set();
      for (const item of snapshot.items) {
        const file = `${item.id}.json`;
        keep.add(file);
        if (await writeIfChanged(path.join(itemsDir, file), format(item))) changed += 1;
      }
      for (const file of await fs.readdir(itemsDir)) {
        if (file.endsWith(".json") && !keep.has(file)) {
          await fs.rm(path.join(itemsDir, file));
          changed += 1;
        }
      }
      return { changed };
    },

    async read() {
      const readJson = async (file) => JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
      const { version } = await readJson("catalog.json");
      const files = (await fs.readdir(itemsDir)).filter((file) => file.endsWith(".json")).sort();
      const snapshot = { version, items: await Promise.all(files.map((file) => readJson(path.join("items", file)))) };
      for (const [key, file] of Object.entries(COLLECTIONS)) snapshot[key] = await readJson(file);
      return snapshot;
    },
  };
}
