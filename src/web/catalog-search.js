import { xArticleKey } from "../library/adapters/x-article-source.js";
import { createDoc, loadArticleDocs, searchDocs } from "./library.js";

// Vista de busqueda de la biblioteca: un doc por item del catalogo. Los
// articulos de X aportan su texto desde disco; el catalogo aporta lo curado
// (tipo, etiquetas, copia fisica, carpetas y listas).

export async function searchCatalog({ root, service, params, now = Date.now() }) {
  // Sincronizar al leer hace que tambien aparezca lo descargado por la CLI.
  await service.syncSources();
  const [articles, snapshot] = await Promise.all([loadArticleDocs(root), service.snapshot()]);
  const articleByKey = new Map();
  for (const article of articles) {
    const key = xArticleKey(article);
    if (!articleByKey.has(key)) articleByKey.set(key, article);
  }

  const selectedList = params.get("list");
  const docs = snapshot.items.map((item) => {
    const membership = snapshot.membership.get(item.id);
    const article = item.source ? articleByKey.get(item.source.key) : null;
    const base = article ?? createDoc({
      title: item.title,
      content: item.notes,
      author_name: item.authors.join(", "),
      published_at: item.year ? new Date(Date.UTC(item.year, 0, 1)).toISOString() : null,
      fetched_at: item.createdAt,
    });
    const inList = membership.lists.find((entry) => entry.id === selectedList);
    return {
      ...base,
      item_id: item.id,
      kind: item.kind,
      year: item.year,
      tags: item.tags,
      physical: item.physical,
      has_source: Boolean(item.source),
      folder_ids: membership.folderIds,
      folder_scope: [...membership.folderScope],
      list_ids: membership.lists.map((entry) => entry.id),
      list_position: inList?.position ?? null,
      list_note: inList?.note ?? "",
    };
  });

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
