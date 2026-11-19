import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_CHARS = 300_000;

// TextExtractor con `pdftotext` (poppler). Devuelve null si el PDF no se puede
// leer; un PDF escaneado o manuscrito devuelve texto vacio, que es valido.

export function createPdfTextExtractor({ command = "pdftotext" } = {}) {
  return {
    async extract(file) {
      try {
        const { stdout } = await run(command, ["-enc", "UTF-8", "-q", file, "-"], {
          maxBuffer: 256 * 1024 * 1024,
          timeout: 120_000,
        });
        const pages = stdout.split("\f").length - 1;
        const text = stdout.replace(/\f/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        return { pages: pages || null, text: text.slice(0, MAX_CHARS) };
      } catch {
        return null;
      }
    },
  };
}

// Si `pdftotext` no esta instalado, la biblioteca funciona igual sin texto buscable.
export async function detectPdfTextExtractor(options) {
  const command = options?.command ?? "pdftotext";
  try {
    await run(command, ["-v"]);
    return createPdfTextExtractor({ command });
  } catch (error) {
    // `pdftotext -v` sale con codigo distinto de cero en algunas versiones aunque exista.
    return error.code === "ENOENT" ? null : createPdfTextExtractor({ command });
  }
}
