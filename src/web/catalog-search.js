import { xArticleKey } from "../library/adapters/x-article-source.js";
import { createDoc, loadArticleDocs, searchDocs } from "./library.js";

// Vista de busqueda de la biblioteca: un doc por item del catalogo. Los
// articulos de X aportan su texto desde disco; el catalogo aporta lo curado
// (tipo, etiquetas, copia fisica, carpetas y listas).

// Docs de items sin articulo en disco. Normalizar el texto de un PDF es caro,
// asi que se guarda mientras no cambien el item ni su archivo.
const docCache = new Map();

async function standaloneDoc(item, file, readFileText) {
  const signature = `${item.updatedAt}:${file?.sha256 ?? ""}:${file?.textChars ?? ""}`;
  const cached = docCache.get(item.id);
  if (cached?.signature === signature) return cached.doc;

  const text = file?.textChars ? await readFileText(file.sha256) : "";
  const content = [item.notes, text].filter(Boolean).join("\n\n");
  const words = text.match(/\S+/g)?.length ?? 0;
  const doc = createDoc({
    title: item.title,
    content,
    author_name: item.authors.join(", "),
    published_at: item.year ? new Date(Date.UTC(item.year, 0, 1)).toISOString() : null,
    fetched_at: item.createdAt,
    words,
    reading_minutes: words ? Math.max(1, Math.round(words / 230)) : null,
  });
  docCache.set(item.id, { signature, doc });
  return doc;
}

export async function searchCatalog({ root, service, params, readFileText = async () => "", now = Date.now() }) {
  // Sincronizar al leer hace que tambien aparezca lo descargado por la CLI.
  await service.syncSources();
  const [articles, snapshot] = await Promise.all([loadArticleDocs(root), service.snapshot()]);
  const articleByKey = new Map();
  for (const article of articles) {
    const key = xArticleKey(article);
    if (!articleByKey.has(key)) articleByKey.set(key, article);
  }

  const selectedList = params.get("list");
  const docs = await Promise.all(snapshot.items.map(async (item) => {
    const membership = snapshot.membership.get(item.id);
    const article = item.source ? articleByKey.get(item.source.key) : null;
    const file = snapshot.filesByItem.get(item.id)?.[0] ?? null;
    const base = article ?? await standaloneDoc(item, file, readFileText);
    const inList = membership.lists.find((entry) => entry.id === selectedList);
    return {
      ...base,
      item_id: item.id,
      kind: item.kind,
      year: item.year,
      tags: item.tags,
      physical: item.physical,
      cover_url: item.cover ? `/api/covers/${item.cover.file}` : null,
      has_source: Boolean(item.source),
      folder_ids: membership.folderIds,
      folder_scope: [...membership.folderScope],
      list_ids: membership.lists.map((entry) => entry.id),
      list_position: inList?.position ?? null,
      list_note: inList?.note ?? "",
      file: file ? { name: file.name, size: file.size, pages: file.pages, archived: file.archived, available: file.available } : null,
    };
  }));

  return { ...searchDocs(docs, params, now), ...organization(snapshot) };
}

// Arbol de carpetas, listas y etiquetas con sus conteos, para la navegacion.
export function organization(snapshot) {
  const scopeCounts = new Map();
  let unfiled = 0;
  for (const membership of snapshot.membership.values()) {
    if (membership.folderIds.length === 0) unfiled += 1;
    for (const id of membership.folderScope) scopeCounts.set(id, (scopeCounts.get(id) ?? 0) + 1);
  }
  const tagCounts = new Map();
  for (const item of snapshot.items) {
    for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  return {
    folders: snapshot.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parent_id: folder.parentId,
      list_ids: folder.listIds,
      count: scopeCounts.get(folder.id) ?? 0,
    })),
    lists: snapshot.lists.map((list) => ({
      id: list.id,
      name: list.name,
      description: list.description,
      count: list.entries.length,
    })),
    all_tags: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((left, right) => left.tag.localeCompare(right.tag)),
    unfiled,
  };
}
