import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibraryService } from "../src/library/application/library-service.js";
import { createSqliteRepository } from "../src/library/adapters/sqlite-repository.js";
import { createXArticleSource } from "../src/library/adapters/x-article-source.js";
import { DomainError } from "../src/library/domain/errors.js";
import { createItem, reviseItem } from "../src/library/domain/item.js";
import { addEntry, createReadingList, moveEntry } from "../src/library/domain/reading-list.js";
import { organization, searchCatalog } from "../src/web/catalog-search.js";
import { notifyingChanges, restoreSnapshot, takeSnapshot } from "../src/library/application/catalog-snapshot.js";
import { createCatalogStore } from "../src/library/adapters/fs-catalog-store.js";

const rejectsWith = (code) => (error) => error instanceof DomainError && error.code === code;

// `prefix` evita que dos tests compartan ids: la busqueda cachea docs por item.
function setup(articles = [], prefix = "id") {
  let counter = 0;
  const service = createLibraryService({
    repository: createSqliteRepository(":memory:"),
    sources: [createXArticleSource({ loadArticles: async () => articles })],
    newId: () => `${prefix}-${++counter}`,
    now: () => `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
  });
  return service;
}

const article = (slug, statusId, title = `Titulo ${slug}`) =>
  ({ slug, status_id: statusId, title, author_name: "Ana", author_handle: "@ana", status_url: `https://x.com/ana/status/${statusId}` });

test("item: normaliza etiquetas y solo guarda ubicacion si hay copia fisica", () => {
  const item = createItem({ id: "a", kind: "book", title: "  Cálculo   I ", tags: ["#Análisis", "análisis ", "Mate"], physical: { owned: false, location: "estante 2" }, now: "t" });
  assert.equal(item.title, "Cálculo I");
  assert.deepEqual(item.tags, ["análisis", "mate"]);
  assert.deepEqual(item.physical, { owned: false, location: null, volumes: [] });
  assert.deepEqual(reviseItem(item, { physical: { owned: true, location: " estante 2 " } }, "t2").physical, { owned: true, location: "estante 2", volumes: [] });

  // Una obra en varios tomos sigue siendo un item; cada tomo puede tener su ubicacion.
  const bound = reviseItem(item, { physical: { owned: true, volumes: [{ name: " Parte 1 ", location: "estante 2" }, { name: "Parte 2" }, { name: "  " }] } }, "t2");
  assert.deepEqual(bound.physical.volumes, [{ name: "Parte 1", location: "estante 2" }, { name: "Parte 2", location: null }]);
  assert.deepEqual(reviseItem(bound, { physical: { location: "caja" } }, "t3").physical.volumes.length, 2, "cambiar la ubicación conserva los tomos");
  assert.deepEqual(reviseItem(bound, { physical: { owned: false } }, "t3").physical.volumes, [], "sin copia física no hay tomos");
  assert.throws(() => reviseItem(item, { physical: { owned: true, volumes: [{ name: "Parte 1" }, { name: "parte 1" }] } }, "t2"), { code: "invalid" });
  assert.throws(() => createItem({ id: "b", kind: "revista", title: "x", now: "t" }), rejectsWith("invalid"));
  assert.throws(() => createItem({ id: "b", kind: "book", title: "  ", now: "t" }), rejectsWith("invalid"));
});

test("item con fuente: lo capturado no se edita a mano, lo curado si", () => {
  const item = createItem({ id: "a", kind: "article", title: "T", source: { key: "x:status:1", ref: {} }, now: "t" });
  assert.throws(() => reviseItem(item, { title: "Otro" }, "t2"), rejectsWith("invalid"));
  assert.deepEqual(reviseItem(item, { tags: ["ia"] }, "t2").tags, ["ia"]);
});

test("lista de lectura: orden, sin repetidos", () => {
  let list = createReadingList({ id: "l", name: "Semana 1", now: "t" });
  for (const id of ["a", "b", "c"]) list = addEntry(list, id, "t");
  assert.throws(() => addEntry(list, "a", "t"), rejectsWith("conflict"));
  assert.deepEqual(moveEntry(list, "c", 0, "t").entries.map((entry) => entry.itemId), ["c", "a", "b"]);
  assert.throws(() => moveEntry(list, "c", 3, "t"), rejectsWith("invalid"));
  assert.throws(() => moveEntry(list, "z", 0, "t"), rejectsWith("not_found"));
});

test("sincronizar fuentes crea items una sola vez y no pisa lo curado", async () => {
  const articles = [article("uno", "1"), article("dos", "2")];
  const service = setup(articles);
  assert.deepEqual(await service.syncSources(), { created: 2, refreshed: 0 });
  assert.deepEqual(await service.syncSources(), { created: 0, refreshed: 0 });

  const item = await service.findItemBySource("x:status:1");
  await service.reviseItem(item.id, { tags: ["leer"], physical: { owned: true, location: "impreso" } });

  // El articulo se vuelve a descargar con otro titulo y otra carpeta: mismo item.
  articles[0] = article("uno-v2", "1", "Titulo nuevo");
  assert.deepEqual(await service.syncSources(), { created: 0, refreshed: 1 });
  const after = await service.findItemBySource("x:status:1");
  assert.equal(after.id, item.id);
  assert.equal(after.title, "Titulo nuevo");
  assert.equal(after.source.ref.slug, "uno-v2");
  assert.deepEqual(after.tags, ["leer"]);
  assert.equal(after.physical.owned, true);
  await assert.rejects(service.removeItem(item.id), rejectsWith("invalid"));
});

test("un mismo item en dos carpetas no se duplica; borrar la carpeta no borra el item", async () => {
  const service = setup();
  const book = await service.registerItem({ kind: "book", title: "Apostol" });
  const math = await service.createFolder({ name: "Matemática" });
  const calc = await service.createFolder({ name: "Cálculo", parentId: math.id });
  const physics = await service.createFolder({ name: "Física" });
  await service.placeInFolder(calc.id, { itemId: book.id });
  await service.placeInFolder(physics.id, { itemId: book.id });
  await service.placeInFolder(physics.id, { itemId: book.id });

  let snapshot = await service.snapshot();
  assert.equal(snapshot.items.length, 1);
  const membership = snapshot.membership.get(book.id);
  assert.deepEqual(membership.folderIds.sort(), [calc.id, physics.id].sort());
  // Filtrar por la carpeta padre alcanza lo que esta en la subcarpeta.
  assert.ok(membership.folderScope.has(math.id));
  assert.equal(organization(snapshot).folders.find((folder) => folder.id === math.id).count, 1);

  await service.removeFolder(math.id);
  snapshot = await service.snapshot();
  assert.deepEqual(snapshot.folders.map((folder) => folder.name), ["Física"]);
  assert.equal(snapshot.items.length, 1);
  assert.deepEqual((await service.describeItem(book.id)).folderIds, [physics.id]);
});

test("carpetas: sin nombres repetidos entre hermanas ni ciclos", async () => {
  const service = setup();
  const a = await service.createFolder({ name: "A" });
  const b = await service.createFolder({ name: "B", parentId: a.id });
  await assert.rejects(service.createFolder({ name: "a" }), rejectsWith("conflict"));
  await assert.rejects(service.reviseFolder(a.id, { parentId: b.id }), rejectsWith("invalid"));
  await assert.rejects(service.createFolder({ name: "C", parentId: "nope" }), rejectsWith("not_found"));
  assert.equal((await service.reviseFolder(b.id, { parentId: null, name: "B2" })).parentId, null);
});

test("lista de lectura persistida: orden, notas y limpieza al borrar un item", async () => {
  const service = setup();
  const [a, b, c] = await Promise.all(["A", "B", "C"].map((title) => service.registerItem({ kind: "paper", title })));
  const list = await service.createReadingList({ name: "Intro" });
  for (const item of [a, b, c]) await service.addToReadingList(list.id, item.id);
  await service.reviseReadingListEntry(list.id, c.id, { position: 0, note: "empezar acá" });
  const folder = await service.createFolder({ name: "Cursos" });
  await service.placeInFolder(folder.id, { listId: list.id });

  await service.removeItem(b.id);
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.lists[0].entries, [{ itemId: c.id, note: "empezar acá" }, { itemId: a.id, note: "" }]);
  assert.deepEqual(snapshot.folders[0].listIds, [list.id]);

  await service.removeReadingList(list.id);
  assert.deepEqual((await service.snapshot()).folders[0].listIds, []);
});

test("busqueda unificada: items manuales, filtros por carpeta, etiqueta y lista", async () => {
  const service = setup();
  const book = await service.registerItem({ kind: "book", title: "Álgebra lineal", authors: ["Strang"], published: 2016, language: "ES", pages: 544, tags: ["mate"], physical: { owned: true }, notes: "espacios vectoriales" });
  const paper = await service.registerItem({ kind: "paper", title: "Attention", authors: ["Vaswani"], published: "2017-06-12" });
  const folder = await service.createFolder({ name: "Mate" });
  await service.placeInFolder(folder.id, { itemId: book.id });
  const list = await service.createReadingList({ name: "Orden" });
  await service.addToReadingList(list.id, paper.id);
  await service.addToReadingList(list.id, book.id);

  const search = (query) => searchCatalog({ root: "/nonexistent", service, params: new URLSearchParams(query) });
  assert.equal((await search("")).count, 2);
  assert.deepEqual((await search("q=vectoriales")).results.map((r) => r.item_id), [book.id]);
  assert.deepEqual((await search(`folder=${folder.id}`)).results.map((r) => r.item_id), [book.id]);
  assert.deepEqual((await search("folder=none")).results.map((r) => r.item_id), [paper.id]);
  assert.deepEqual((await search("tag=mate")).results.map((r) => r.item_id), [book.id]);
  assert.deepEqual((await search("physical=yes")).results.map((r) => r.item_id), [book.id]);
  assert.deepEqual((await search("kind=paper")).results.map((r) => r.item_id), [paper.id]);
  const inList = await search(`list=${list.id}`);
  assert.equal(inList.sort, "list");
  assert.deepEqual(inList.results.map((r) => r.item_id), [paper.id, book.id]);
  assert.deepEqual(inList.facets.kind.map((option) => [option.value, option.count]), [["book", 1], ["paper", 1]]);
});

// ---------- etapa 2: carpetas de origen ----------

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSourceSyncService } from "../src/library/application/source-sync-service.js";
import { createFileStore } from "../src/library/adapters/fs-file-store.js";
import { createFolderScanner } from "../src/library/adapters/fs-folder-scanner.js";
import { planFolderSync } from "../src/library/domain/folder-sync.js";
import { createSourceFolder, titleFromFileName } from "../src/library/domain/source-folder.js";

test("plan de sincronizacion: nuevo, movido, version nueva y descartado", () => {
  const files = new Map([["h-a", { itemId: "item-a" }], ["h-b", { itemId: "item-b" }], ["h-x", { itemId: null }]]);
  const plan = planFolderSync({
    previous: [{ relPath: "a.pdf", sha256: "h-a" }, { relPath: "b.pdf", sha256: "h-b" }, { relPath: "c.pdf", sha256: "h-c" }],
    scanned: [
      { relPath: "sub/a.pdf", sha256: "h-a", size: 1, mtimeMs: 1 }, // movido
      { relPath: "b.pdf", sha256: "h-b2", size: 1, mtimeMs: 2 },    // editado en el lugar
      { relPath: "new.pdf", sha256: "h-n", size: 1, mtimeMs: 1 },   // nuevo
      { relPath: "copy.pdf", sha256: "h-n", size: 1, mtimeMs: 1 },  // copia del nuevo
      { relPath: "x.pdf", sha256: "h-x", size: 1, mtimeMs: 1 },     // descartado antes
    ],
    files,
    elsewhere: new Set(),
  });
  assert.deepEqual(plan.create.map((entry) => entry.relPath), ["copy.pdf"]);
  assert.deepEqual(plan.newVersions.map((entry) => [entry.relPath, entry.itemId, entry.replaces]), [["b.pdf", "item-b", "h-b"]]);
  assert.deepEqual(plan.gone.sort(), ["h-b", "h-c"]);
  assert.equal(plan.locations.length, 5);
});

test("carpeta de origen: ruta absoluta, sin superposiciones", () => {
  const first = createSourceFolder([], { id: "s1", path: "/data/Estudio/", now: "t" });
  assert.equal(first.path, "/data/Estudio");
  assert.equal(first.label, "Estudio");
  assert.equal(first.policy, "archive");
  assert.throws(() => createSourceFolder([first], { id: "s2", path: "/data/Estudio/Calculo", now: "t" }), rejectsWith("conflict"));
  assert.throws(() => createSourceFolder([first], { id: "s2", path: "/data", now: "t" }), rejectsWith("conflict"));
  assert.throws(() => createSourceFolder([], { id: "s2", path: "Estudio", now: "t" }), rejectsWith("invalid"));
  assert.equal(titleFromFileName("apuntes_calculo_1.pdf"), "apuntes calculo 1");
});

test("sincronizar una carpeta real: importa, archiva, sigue movimientos y no pisa lo organizado", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biblioteca-"));
  const folder = path.join(root, "Estudio");
  await fs.mkdir(path.join(folder, "Calculo"), { recursive: true });
  await fs.writeFile(path.join(folder, "Calculo", "apostol.pdf"), "contenido de apostol");
  await fs.writeFile(path.join(folder, "notas.pdf"), "mis notas");
  await fs.writeFile(path.join(folder, "ignorar.txt"), "no es pdf");

  let counter = 0;
  const repository = createSqliteRepository(":memory:");
  const ports = { repository, newId: () => `id-${++counter}`, now: () => `2026-01-01T00:00:00.${String(++counter).padStart(3, "0")}Z` };
  const library = createLibraryService(ports);
  const store = createFileStore(path.join(root, "store"));
  const sync = createSourceSyncService({
    ...ports,
    scanner: createFolderScanner(),
    store,
    textExtractor: { extract: async (file) => ({ text: await fs.readFile(file, "utf8"), pages: 1 }) },
  });
  const runSync = async (id) => (await sync.startSync(id)).finished;
  const lastRun = async () => (await sync.listSources())[0].run;

  await assert.rejects(sync.addSourceFolder({ path: path.join(root, "no-existe") }), rejectsWith("invalid"));
  const source = await sync.addSourceFolder({ path: folder });
  await runSync(source.id);
  assert.deepEqual((await lastRun()).summary, { scanned: 2, created: 2, new_versions: 0, moved: 0, missing: 0, archived: 2, failures: 0, folders_imported: true });

  // Las carpetas del disco se reflejan una vez, bajo el nombre de la carpeta de origen.
  let snapshot = await library.snapshot();
  assert.deepEqual(snapshot.folders.map((entry) => entry.name).sort(), ["Calculo", "Estudio"]);
  const apostol = snapshot.items.find((item) => item.title === "apostol");
  const calculo = snapshot.folders.find((entry) => entry.name === "Calculo");
  assert.deepEqual(calculo.itemIds, [apostol.id]);
  const [file] = snapshot.filesByItem.get(apostol.id);
  assert.equal(file.archived, true);
  assert.equal(await store.has(file.sha256), true);

  // El texto del PDF es buscable.
  const search = (query) => searchCatalog({ root: "/nonexistent", service: library, params: new URLSearchParams(query), readFileText: (sha) => repository.getFileText(sha) });
  assert.deepEqual((await search("q=contenido+apostol")).results.map((result) => result.item_id), [apostol.id]);
  assert.equal((await search("has=file")).count, 2);

  // El usuario organiza: renombra el item y lo saca de la carpeta importada.
  await library.reviseItem(apostol.id, { title: "Calculus, Vol. 1", kind: "book", tags: ["cálculo"] });
  await library.takeOutOfFolder(calculo.id, { itemId: apostol.id });

  // Mover el archivo en disco no crea un item nuevo ni rearma carpetas.
  await fs.mkdir(path.join(folder, "Libros"));
  await fs.rename(path.join(folder, "Calculo", "apostol.pdf"), path.join(folder, "Libros", "Apostol vol 1.pdf"));
  await fs.writeFile(path.join(folder, "Libros", "nuevo.pdf"), "otro libro");
  await runSync(source.id);
  const second = (await lastRun()).summary;
  assert.deepEqual([second.created, second.moved, second.folders_imported], [1, 1, false]);
  snapshot = await library.snapshot();
  assert.equal(snapshot.items.length, 3);
  assert.equal(snapshot.items.find((item) => item.id === apostol.id).title, "Calculus, Vol. 1");
  assert.deepEqual(snapshot.folders.map((entry) => entry.name).sort(), ["Calculo", "Estudio"]);
  assert.equal(snapshot.membership.get(apostol.id).folderIds.length, 0);
  assert.equal(snapshot.membership.get(snapshot.items.find((item) => item.title === "nuevo").id).folderIds.length, 0);
  assert.deepEqual((await sync.describeFiles(apostol.id))[0].locations, [path.join(folder, "Libros", "Apostol vol 1.pdf")]);

  // Editar el archivo en el lugar es una version nueva del mismo item.
  await fs.writeFile(path.join(folder, "notas.pdf"), "mis notas, ahora anotadas");
  await runSync(source.id);
  assert.equal((await lastRun()).summary.new_versions, 1);
  const notas = (await library.snapshot()).items.find((item) => item.title === "notas");
  assert.equal((await sync.describeFiles(notas.id)).length, 2);

  // Si el original desaparece, lo archivado se sigue pudiendo abrir.
  await fs.rm(path.join(folder, "Libros", "Apostol vol 1.pdf"));
  await runSync(source.id);
  assert.equal((await sync.locateFile(apostol.id)).path, store.pathOf(file.sha256));

  // Un item eliminado no vuelve a importarse aunque su PDF siga en la carpeta.
  await library.removeItem(notas.id);
  await runSync(source.id);
  assert.equal((await lastRun()).summary.created, 0);
  assert.equal((await library.snapshot()).items.some((item) => item.title === "notas"), false);

  await fs.rm(root, { recursive: true, force: true });
});

// ---------- etapa 3: relaciones y union de items ----------

import { createRelation } from "../src/library/domain/relation.js";

test("relaciones: sin repetidas, simetricas normalizadas y sin ciclos donde hay orden", () => {
  const make = (existing, fromId, toId, type) => createRelation(existing, { id: `${type}:${fromId}:${toId}`, fromId, toId, type, now: "t" });
  const ab = make([], "a", "b", "requires");
  const bc = make([ab], "b", "c", "requires");
  assert.throws(() => make([ab, bc], "c", "a", "requires"), rejectsWith("invalid"));
  assert.throws(() => make([ab], "a", "b", "requires"), rejectsWith("conflict"));
  assert.throws(() => make([], "a", "a", "cites"), rejectsWith("invalid"));
  assert.throws(() => make([], "a", "b", "inspira"), rejectsWith("invalid"));
  // Citarse mutuamente es valido; "se relaciona con" no tiene direccion.
  assert.equal(make([make([], "a", "b", "cites")], "b", "a", "cites").fromId, "b");
  const related = make([], "z", "a", "related");
  assert.deepEqual([related.fromId, related.toId], ["a", "z"]);
  assert.throws(() => make([related], "a", "z", "related"), rejectsWith("conflict"));
});

test("relaciones persistidas: se leen desde los dos extremos y se van con el item", async () => {
  const service = setup();
  const [apostol, practico] = await Promise.all(["Apostol", "Práctico 3"].map((title) => service.registerItem({ kind: "book", title })));
  await service.relateItems({ fromId: practico.id, toId: apostol.id, type: "requires" });
  assert.deepEqual((await service.describeItem(practico.id)).relations.map((r) => [r.label, r.other.title]), [["requiere haber leído", "Apostol"]]);
  assert.deepEqual((await service.describeItem(apostol.id)).relations.map((r) => [r.label, r.other.title]), [["es requisito de", "Práctico 3"]]);
  const graph = await service.graph();
  assert.deepEqual([graph.nodes.length, graph.edges.length], [2, 1]);
  await service.removeItem(practico.id);
  assert.deepEqual((await service.graph()).edges, []);
});

test("unir items: el que queda suma archivos, etiquetas, carpetas, listas y relaciones", async () => {
  const service = setup([article("uno", "1")]);
  await service.syncSources();
  const xArticle = await service.findItemBySource("x:status:1");
  const book = await service.registerItem({ kind: "book", title: "Calculus, Vol. 1", authors: ["Apostol"], physical: { owned: true, location: "estante" } });
  const pdf = await service.registerItem({ kind: "document", title: "apostol calculus vol1", tags: ["cálculo"], notes: "escaneado" });
  const other = await service.registerItem({ kind: "notes", title: "Notas" });
  const folder = await service.createFolder({ name: "Mate" });
  await service.placeInFolder(folder.id, { itemId: pdf.id });
  const list = await service.createReadingList({ name: "Semana 1" });
  await service.addToReadingList(list.id, other.id);
  await service.addToReadingList(list.id, pdf.id, "capítulo 1");
  await service.relateItems({ fromId: other.id, toId: pdf.id, type: "requires" });
  await service.relateItems({ fromId: pdf.id, toId: book.id, type: "related" });

  await assert.rejects(service.mergeItems(book.id, xArticle.id), rejectsWith("invalid"));
  await assert.rejects(service.mergeItems(book.id, book.id), rejectsWith("invalid"));
  await service.mergeItems(book.id, pdf.id);

  const snapshot = await service.snapshot();
  assert.equal(snapshot.items.some((item) => item.id === pdf.id), false);
  const described = await service.describeItem(book.id);
  assert.equal(described.item.title, "Calculus, Vol. 1");
  assert.deepEqual(described.item.tags, ["cálculo"]);
  assert.equal(described.item.notes, "escaneado");
  assert.equal(described.item.physical.location, "estante");
  assert.deepEqual(described.folderIds, [folder.id]);
  assert.deepEqual(snapshot.lists[0].entries, [{ itemId: other.id, note: "" }, { itemId: book.id, note: "capítulo 1" }]);
  // La relacion con el propio libro desaparece; la de las notas pasa al libro.
  assert.deepEqual(described.relations.map((r) => [r.label, r.other.title]), [["es requisito de", "Notas"]]);
});

test("tapa: dato curado, guardada por huella, sobrevive a sincronizar y pasa al unir", async () => {
  const stored = new Map();
  const covers = {
    put: async (bytes, extension) => {
      const file = `${"a".repeat(63)}${stored.size}.${extension}`;
      stored.set(file, bytes);
      return file;
    },
    pathOf: (file) => file,
  };
  let counter = 0;
  const articles = [article("uno", "1")];
  const service = createLibraryService({
    repository: createSqliteRepository(":memory:"),
    sources: [createXArticleSource({ loadArticles: async () => articles })],
    covers,
    newId: () => `id-${++counter}`,
    now: () => `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
  });

  assert.throws(() => createItem({ id: "x", kind: "book", title: "x", cover: { file: "../../etc/passwd" }, now: "t" }), rejectsWith("invalid"));

  const book = await service.registerItem({ kind: "book", title: "Statistical Inference", physical: { owned: true } });
  const withCover = await service.setItemCover(book.id, { bytes: new Uint8Array([1, 2, 3]), extension: "jpg", origin: " https://covers.example/1.jpg " });
  assert.deepEqual(withCover.cover, { file: `${"a".repeat(63)}0.jpg`, origin: "https://covers.example/1.jpg" });
  assert.deepEqual((await service.describeItem(book.id)).item.cover, withCover.cover, "se persiste");

  // Sincronizar refresca lo capturado de un item con fuente y conserva su tapa.
  await service.syncSources();
  const x = await service.findItemBySource((await service.snapshot()).items.find((item) => item.source).source.key);
  await service.setItemCover(x.id, { bytes: new Uint8Array([4]), extension: "png" });
  articles[0] = article("uno", "1", "Titulo nuevo");
  await service.syncSources();
  assert.equal((await service.describeItem(x.id)).item.cover.file, `${"a".repeat(63)}1.png`);

  // Al unir, el que queda conserva su tapa; si no tenia, toma la del otro.
  const copy = await service.registerItem({ kind: "book", title: "Statistical Inference (PDF)" });
  await service.mergeItems(copy.id, book.id);
  assert.deepEqual((await service.describeItem(copy.id)).item.cover, withCover.cover);

  assert.equal((await service.removeItemCover(copy.id)).cover, null);
});

test("item: fecha con la precision que se conozca, idioma como codigo y paginas", () => {
  const item = createItem({ id: "a", kind: "book", title: "Cálculo", published: 2016, language: " ES ", pages: "320", now: "t" });
  assert.equal(item.published, "2016");
  assert.equal(item.language, "es");
  assert.equal(item.pages, 320);
  assert.equal(reviseItem(item, { published: "2016-03" }, "t2").published, "2016-03");
  assert.equal(reviseItem(item, { published: "2016-02-29" }, "t2").published, "2016-02-29");
  assert.equal(reviseItem(item, { published: "", language: null, pages: "" }, "t2").pages, null);
  for (const published of ["2015-02-29", "2016-13", "16", "marzo 2016"]) {
    assert.throws(() => reviseItem(item, { published }, "t2"), rejectsWith("invalid"), published);
  }
  assert.throws(() => reviseItem(item, { language: "español" }, "t2"), rejectsWith("invalid"));
  assert.throws(() => reviseItem(item, { pages: 0 }, "t2"), rejectsWith("invalid"));
  assert.throws(() => reviseItem(item, { pages: 12.5 }, "t2"), rejectsWith("invalid"));

  const fromSource = createItem({ id: "x", kind: "article", title: "Hilo", source: { key: "x:1" }, now: "t" });
  assert.throws(() => reviseItem(fromSource, { language: "en" }, "t2"), rejectsWith("invalid"), "lo descriptivo de un item con fuente no se edita");
});

test("busqueda: documentos con idioma cargado, fecha parcial y largo en paginas", async () => {
  const service = setup([], "doc");
  await service.registerItem({ kind: "book", title: "Cálculo", published: "2016-03", language: "pt", pages: 600 });
  await service.registerItem({ kind: "notes", title: "Apuntes", pages: 12 });
  await service.registerItem({ kind: "document", title: "Sin datos" });

  const all = await searchCatalog({ root: "/nonexistent", service, params: new URLSearchParams() });
  const book = all.results.find((result) => result.title === "Cálculo");
  assert.equal(book.lang, "pt");
  assert.equal(book.pages, 600);
  assert.equal(book.published, "2016-03");
  assert.equal(book.published_at, "2016-03-01T00:00:00.000Z");
  assert.deepEqual(all.facets.lang.find((option) => option.value === "pt"), { value: "pt", label: "Portugués", count: 1 });
  assert.equal(all.facets.len.find((option) => option.value === "long").count, 1);
  assert.equal(all.facets.len.find((option) => option.value === "short").count, 1);

  const longest = await searchCatalog({ root: "/nonexistent", service, params: new URLSearchParams({ sort: "longest" }) });
  assert.deepEqual(longest.results.slice(0, 2).map((result) => result.title), ["Cálculo", "Apuntes"]);
  const short = await searchCatalog({ root: "/nonexistent", service, params: new URLSearchParams({ len: "short" }) });
  assert.deepEqual(short.results.map((result) => result.title), ["Apuntes"]);
});

test("snapshot del catalogo: ida y vuelta completa, sin datos que se regeneran", async () => {
  const repository = createSqliteRepository(":memory:");
  let counter = 0;
  const service = createLibraryService({ repository, newId: () => `snap-${++counter}`, now: () => `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z` });
  const book = await service.registerItem({ kind: "book", title: "Cálculo", published: "2016", language: "es", tags: ["mate"], physical: { owned: true, volumes: [{ name: "Tomo I" }] } });
  const notes = await service.registerItem({ kind: "notes", title: "Apuntes" });
  const parent = await service.createFolder({ name: "Facultad" });
  const child = await service.createFolder({ name: "Primer año", parentId: parent.id });
  await service.placeInFolder(child.id, { itemId: book.id });
  const list = await service.createReadingList({ name: "Verano" });
  await service.addToReadingList(list.id, notes.id, "antes del parcial");
  await service.relateItems({ fromId: notes.id, toId: book.id, type: "requires" });
  await repository.saveSource({ id: "src-1", path: "/tmp/pdfs", label: "PDFs", policy: "reference", foldersImportedAt: "t", lastSyncedAt: "cambia siempre", createdAt: "t" });
  await repository.saveFiles([{ sha256: "a".repeat(64), itemId: book.id, size: 10, name: "c.pdf", archived: false, pages: 3, textChars: 120, addedAt: "t" }]);

  const snapshot = await takeSnapshot(repository);
  assert.equal(snapshot.sources[0].lastSyncedAt, undefined);
  assert.equal(snapshot.files[0].textChars, undefined);

  // Ida y vuelta por disco: la base nueva queda igual.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-"));
  const store = createCatalogStore(dir);
  assert.ok((await store.write(snapshot)).changed > 0);
  assert.equal((await store.write(snapshot)).changed, 0, "sin cambios no reescribe nada");

  const restored = createSqliteRepository(":memory:");
  await restoreSnapshot(restored, await store.read());
  assert.deepEqual(await takeSnapshot(restored), snapshot);
  assert.equal((await restored.listFiles())[0].textChars, null, "el texto se vuelve a extraer al sincronizar");
  await assert.rejects(restoreSnapshot(restored, snapshot), rejectsWith("invalid"), "no pisa un catálogo con items");

  // Borrar un item borra su archivo.
  await service.removeItem(notes.id);
  assert.ok((await store.write(await takeSnapshot(repository))).changed > 0);
  assert.deepEqual((await fs.readdir(path.join(dir, "items"))).sort(), [`${book.id}.json`]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("aviso de cambios: solo las escrituras del repositorio avisan", async () => {
  const changes = [];
  const repository = notifyingChanges(createSqliteRepository(":memory:"), (name) => changes.push(name));
  const service = createLibraryService({ repository, newId: () => "n-1", now: () => "t" });
  await service.registerItem({ kind: "book", title: "Uno" });
  await repository.listItems();
  assert.deepEqual(changes, ["saveItems"]);
});
