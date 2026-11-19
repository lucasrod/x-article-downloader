import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Adaptador SQLite del LibraryRepository (ver application/ports.js).
// El esquema usa solo tipos y constraints que existen igual en Postgres.

const MIGRATIONS = [
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '[]',
    year INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    physical_owned INTEGER NOT NULL DEFAULT 0,
    physical_location TEXT,
    source_key TEXT UNIQUE,
    source_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
  );
  CREATE TABLE reading_lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE reading_list_entries (
    list_id TEXT NOT NULL REFERENCES reading_lists(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (list_id, item_id)
  );
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE folder_items (
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, item_id)
  );
  CREATE TABLE folder_lists (
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    list_id TEXT NOT NULL REFERENCES reading_lists(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, list_id)
  );
  `,
];

export function createSqliteRepository(file) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(db);

  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const tagsByItem = () => groupBy(db.prepare("SELECT item_id, tag FROM item_tags ORDER BY tag").all(), "item_id", (row) => row.tag);

  const toItem = (row, tags) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    authors: JSON.parse(row.authors),
    year: row.year,
    notes: row.notes,
    tags,
    physical: { owned: row.physical_owned === 1, location: row.physical_location },
    source: row.source_key ? { key: row.source_key, ref: JSON.parse(row.source_ref ?? "{}") } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const toList = (row, entries) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    entries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const entriesOf = (rows) => rows.map((row) => ({ itemId: row.item_id, note: row.note }));

  return {
    close: () => db.close(),

    // ---------- items ----------

    async listItems() {
      const tags = tagsByItem();
      return db.prepare("SELECT * FROM items ORDER BY created_at, id").all().map((row) => toItem(row, tags.get(row.id) ?? []));
    },

    async getItem(id) {
      const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
      if (!row) return null;
      const tags = db.prepare("SELECT tag FROM item_tags WHERE item_id = ? ORDER BY tag").all(id).map((entry) => entry.tag);
      return toItem(row, tags);
    },

    async saveItems(items) {
      const upsert = db.prepare(`
        INSERT INTO items (id, kind, title, authors, year, notes, physical_owned, physical_location, source_key, source_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          kind = excluded.kind, title = excluded.title, authors = excluded.authors, year = excluded.year,
          notes = excluded.notes, physical_owned = excluded.physical_owned, physical_location = excluded.physical_location,
          source_key = excluded.source_key, source_ref = excluded.source_ref, updated_at = excluded.updated_at`);
      const clearTags = db.prepare("DELETE FROM item_tags WHERE item_id = ?");
      const addTag = db.prepare("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)");

      transaction(() => {
        for (const item of items) {
          upsert.run(
            item.id, item.kind, item.title, JSON.stringify(item.authors), item.year, item.notes,
            item.physical.owned ? 1 : 0, item.physical.location,
            item.source?.key ?? null, item.source ? JSON.stringify(item.source.ref) : null,
            item.createdAt, item.updatedAt,
          );
          clearTags.run(item.id);
          for (const tag of item.tags) addTag.run(item.id, tag);
        }
      });
    },

    async deleteItem(id) {
      db.prepare("DELETE FROM items WHERE id = ?").run(id);
    },

    // ---------- carpetas ----------

    async listFolders() {
      const items = groupBy(db.prepare("SELECT folder_id, item_id FROM folder_items").all(), "folder_id", (row) => row.item_id);
      const lists = groupBy(db.prepare("SELECT folder_id, list_id FROM folder_lists").all(), "folder_id", (row) => row.list_id);
      return db.prepare("SELECT * FROM folders ORDER BY name COLLATE NOCASE, id").all().map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parent_id,
        itemIds: items.get(row.id) ?? [],
        listIds: lists.get(row.id) ?? [],
        createdAt: row.created_at,
      }));
    },

    async saveFolder(folder) {
      transaction(() => {
        db.prepare(`
          INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id`)
          .run(folder.id, folder.name, folder.parentId, folder.createdAt);
        db.prepare("DELETE FROM folder_items WHERE folder_id = ?").run(folder.id);
        db.prepare("DELETE FROM folder_lists WHERE folder_id = ?").run(folder.id);
        const addItem = db.prepare("INSERT INTO folder_items (folder_id, item_id) VALUES (?, ?)");
        const addList = db.prepare("INSERT INTO folder_lists (folder_id, list_id) VALUES (?, ?)");
        for (const itemId of folder.itemIds) addItem.run(folder.id, itemId);
        for (const listId of folder.listIds) addList.run(folder.id, listId);
      });
    },

    async deleteFolders(ids) {
      const remove = db.prepare("DELETE FROM folders WHERE id = ?");
      transaction(() => {
        for (const id of ids) remove.run(id);
      });
    },

    // ---------- listas de lectura ----------

    async listReadingLists() {
      const entries = groupBy(
        db.prepare("SELECT list_id, item_id, note FROM reading_list_entries ORDER BY list_id, position").all(),
        "list_id",
        (row) => ({ itemId: row.item_id, note: row.note }),
      );
      return db.prepare("SELECT * FROM reading_lists ORDER BY name COLLATE NOCASE, id").all()
        .map((row) => toList(row, entries.get(row.id) ?? []));
    },

    async getReadingList(id) {
      const row = db.prepare("SELECT * FROM reading_lists WHERE id = ?").get(id);
      if (!row) return null;
      return toList(row, entriesOf(db.prepare("SELECT item_id, note FROM reading_list_entries WHERE list_id = ? ORDER BY position").all(id)));
    },

    async saveReadingList(list) {
      transaction(() => {
        db.prepare(`
          INSERT INTO reading_lists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at`)
          .run(list.id, list.name, list.description, list.createdAt, list.updatedAt);
        db.prepare("DELETE FROM reading_list_entries WHERE list_id = ?").run(list.id);
        const add = db.prepare("INSERT INTO reading_list_entries (list_id, item_id, position, note) VALUES (?, ?, ?, ?)");
        list.entries.forEach((entry, position) => add.run(list.id, entry.itemId, position, entry.note));
      });
    },

    async deleteReadingList(id) {
      db.prepare("DELETE FROM reading_lists WHERE id = ?").run(id);
    },
  };
}

function migrate(db) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get();
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[version]);
    db.exec(`PRAGMA user_version = ${version + 1}`);
    db.exec("COMMIT");
  }
}

function groupBy(rows, key, valueOf) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(valueOf(row));
  }
  return groups;
}
