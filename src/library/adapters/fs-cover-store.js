import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// CoverStore: tapas de los items en disco, nombradas por su huella
// (<dir>/<sha256>.<ext>). Dos items con la misma imagen comparten el archivo.

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function createCoverStore(dir) {
  const pathOf = (file) => path.join(dir, path.basename(file));

  return {
    pathOf,

    extensionFor: (contentType) => EXTENSIONS[String(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? null,

    async put(bytes, extension) {
      const file = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
      const target = pathOf(file);
      if (!(await fs.stat(target).catch(() => null))) {
        await fs.mkdir(dir, { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, target);
      }
      return file;
    },
  };
}
