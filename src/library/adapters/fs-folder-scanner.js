import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

// FolderScanner sobre el filesystem local: lista los PDFs de una carpeta y
// calcula su huella. No sigue enlaces simbolicos ni entra en carpetas ocultas.

export function createFolderScanner({ extensions = [".pdf"] } = {}) {
  async function walk(root, relative, found) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(root, relPath, found);
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(path.join(root, relPath));
        found.push({ relPath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      }
    }
  }

  return {
    resolve: (root, relPath) => path.join(root, ...relPath.split("/")),

    isDirectory: (target) => fs.stat(target).then((stat) => stat.isDirectory()).catch(() => false),

    isFile: (target) => fs.stat(target).then((stat) => stat.isFile()).catch(() => false),

    async list(root) {
      const found = [];
      await walk(root, "", found);
      return found.sort((left, right) => left.relPath.localeCompare(right.relPath));
    },

    hash: (root, relPath) => hashFile(path.join(root, ...relPath.split("/"))),
  };
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
