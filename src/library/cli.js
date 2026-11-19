#!/usr/bin/env node
import path from "node:path";
import { createCatalogStore } from "./adapters/fs-catalog-store.js";
import { createSqliteRepository } from "./adapters/sqlite-repository.js";
import { restoreSnapshot, takeSnapshot } from "./application/catalog-snapshot.js";

// Versionado del catalogo.
//   export: escribe ./library/catalog/ desde la base (el servidor web ya lo hace solo).
//   import: reconstruye una base vacia desde ./library/catalog/, por ejemplo
//           despues de clonar el repo de la biblioteca en otra maquina.

const [command] = process.argv.slice(2);
const database = path.resolve(process.env.LIBRARY_DB || "./library/library.sqlite");
const catalogDir = path.join(path.dirname(database), "catalog");

const repository = createSqliteRepository(database);
const store = createCatalogStore(catalogDir);

try {
  if (command === "export") {
    const snapshot = await takeSnapshot(repository);
    const { changed } = await store.write(snapshot);
    console.log(`${snapshot.items.length} items en ${catalogDir} (${changed} archivo(s) cambiaron).`);
  } else if (command === "import") {
    const snapshot = await store.read();
    await restoreSnapshot(repository, snapshot);
    console.log(`${snapshot.items.length} items restaurados en ${database}.`);
  } else {
    console.error("Uso: node ./src/library/cli.js export|import  (la base sale de LIBRARY_DB o ./library/library.sqlite)");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  repository.close();
}
