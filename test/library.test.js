import assert from "node:assert/strict";
import { test } from "node:test";
import { createLibraryService } from "../src/library/application/library-service.js";
import { createSqliteRepository } from "../src/library/adapters/sqlite-repository.js";
import { createXArticleSource } from "../src/library/adapters/x-article-source.js";
import { DomainError } from "../src/library/domain/errors.js";
import { createItem, reviseItem } from "../src/library/domain/item.js";
import { addEntry, createReadingList, moveEntry } from "../src/library/domain/reading-list.js";
import { organization, searchCatalog } from "../src/web/catalog-search.js";

const rejectsWith = (code) => (error) => error instanceof DomainError && error.code === code;

function setup(articles = []) {
  let counter = 0;
  const service = createLibraryService({
    repository: createSqliteRepository(":memory:"),
    sources: [createXArticleSource({ loadArticles: async () => articles })],
    newId: () => `id-${++counter}`,
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
  assert.deepEqual(item.physical, { owned: false, location: null });
  assert.deepEqual(reviseItem(item, { physical: { owned: true, location: " estante 2 " } }, "t2").physical, { owned: true, location: "estante 2" });
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
  const book = await service.registerItem({ kind: "book", title: "Álgebra lineal", authors: ["Strang"], year: 2016, tags: ["mate"], physical: { owned: true }, notes: "espacios vectoriales" });
  const paper = await service.registerItem({ kind: "paper", title: "Attention", authors: ["Vaswani"], year: 2017 });
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
