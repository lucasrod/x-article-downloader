import { DomainError } from "../library/domain/errors.js";
import { ITEM_KINDS } from "../library/domain/item.js";
import { KIND_LABELS } from "./library.js";
import { organization } from "./catalog-search.js";

// Adaptador HTTP de la biblioteca: traduce requests a casos de uso y errores
// de dominio a status. Devuelve `undefined` si la ruta no es suya.

const STATUS_BY_CODE = { invalid: 400, not_found: 404, conflict: 409 };

export function createCatalogRoutes({ service, readJsonBody }) {
  return async function routeCatalog({ method, parts, request }) {
    try {
      return await dispatch({ method, parts, request });
    } catch (error) {
      if (error instanceof DomainError) {
        error.status = STATUS_BY_CODE[error.code] ?? 400;
      }
      throw error;
    }
  };

  async function dispatch({ method, parts, request }) {
    const [, resource, id, sub, subId] = parts;
    const body = () => readJsonBody(request);

    if (resource === "catalog" && method === "GET" && parts.length === 2) {
      await service.syncSources();
      return {
        kinds: ITEM_KINDS.filter((kind) => kind !== "article").map((value) => ({ value, label: KIND_LABELS[value] })),
        ...organization(await service.snapshot()),
      };
    }

    if (resource === "items") {
      if (method === "POST" && parts.length === 2) return itemView(await service.registerItem(itemInput(await body())));
      if (method === "GET" && parts.length === 3) return describe(id);
      if (method === "PATCH" && parts.length === 3) {
        await service.reviseItem(id, itemInput(await body()));
        return describe(id);
      }
      if (method === "DELETE" && parts.length === 3) return done(await service.removeItem(id));
    }

    if (resource === "folders") {
      if (method === "POST" && parts.length === 2) {
        const input = await body();
        return folderView(await service.createFolder({ name: input.name, parentId: input.parent_id ?? null }));
      }
      if (method === "PATCH" && parts.length === 3) {
        const input = await body();
        const changes = {};
        if ("name" in input) changes.name = input.name;
        if ("parent_id" in input) changes.parentId = input.parent_id;
        return folderView(await service.reviseFolder(id, changes));
      }
      if (method === "DELETE" && parts.length === 3) return done(await service.removeFolder(id));
      if (parts.length === 5 && (sub === "items" || sub === "lists")) {
        const reference = sub === "items" ? { itemId: subId } : { listId: subId };
        if (method === "PUT") return done(await service.placeInFolder(id, reference));
        if (method === "DELETE") return done(await service.takeOutOfFolder(id, reference));
      }
    }

    if (resource === "lists") {
      if (method === "POST" && parts.length === 2) return listView(await service.createReadingList(await body()));
      if (method === "PATCH" && parts.length === 3) {
        const input = await body();
        const changes = {};
        if ("name" in input) changes.name = input.name;
        if ("description" in input) changes.description = input.description;
        return listView(await service.reviseReadingList(id, changes));
      }
      if (method === "DELETE" && parts.length === 3) return done(await service.removeReadingList(id));
      if (parts.length === 5 && sub === "items") {
        if (method === "PUT") return listView(await service.addToReadingList(id, subId, (await body()).note));
        if (method === "PATCH") return listView(await service.reviseReadingListEntry(id, subId, await body()));
        if (method === "DELETE") return listView(await service.removeFromReadingList(id, subId));
      }
    }

    return undefined;
  }

  async function describe(id) {
    const { item, folderIds, listIds } = await service.describeItem(id);
    return { ...itemView(item), folder_ids: folderIds, list_ids: listIds };
  }
}

const done = () => ({ ok: true });

// Solo pasan al dominio los campos que el cliente mando.
function itemInput(body) {
  const input = {};
  for (const field of ["kind", "title", "authors", "year", "notes", "tags", "physical"]) {
    if (field in body) input[field] = body[field];
  }
  return input;
}

function itemView(item) {
  return {
    id: item.id,
    kind: item.kind,
    kind_label: KIND_LABELS[item.kind] ?? item.kind,
    title: item.title,
    authors: item.authors,
    year: item.year,
    notes: item.notes,
    tags: item.tags,
    physical: item.physical,
    source: item.source,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

const folderView = (folder) => ({ id: folder.id, name: folder.name, parent_id: folder.parentId });

const listView = (list) => ({
  id: list.id,
  name: list.name,
  description: list.description,
  entries: list.entries.map((entry) => ({ item_id: entry.itemId, note: entry.note })),
});
