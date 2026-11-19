import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./fs-folder-scanner.js";

// FileStore: almacen por huella en disco. Cada archivo vive en
// <dir>/<2 primeros caracteres>/<sha256>.pdf, el mismo esquema que usaria un
// bucket. La copia pide un clon (APFS/btrfs), que no ocupa espacio extra cuando
// el almacen esta en el mismo volumen; si no se puede, copia normal.

export function createFileStore(dir) {
  const pathOf = (sha256) => path.join(dir, sha256.slice(0, 2), `${sha256}.pdf`);

  return {
    pathOf,

    has: (sha256) => fs.stat(pathOf(sha256)).then((stat) => stat.isFile()).catch(() => false),

    async archive(sourcePath, sha256) {
      const target = pathOf(sha256);
      if (await this.has(sha256)) return;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        await fs.copyFile(sourcePath, temporary, constants.COPYFILE_FICLONE);
        // El archivo pudo cambiar desde que se calculo la huella: el almacen
        // solo acepta contenido que coincide con su nombre.
        if (await hashFile(temporary) !== sha256) {
          throw new Error(`El archivo cambió mientras se archivaba: ${sourcePath}`);
        }
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
  };
}
