// Plan de sincronizacion de una carpeta de origen. Funcion pura: compara lo que
// hay hoy en disco con lo que la biblioteca ya conocia y decide que hacer.
//
// La identidad de un archivo es su huella (SHA-256), no su ruta:
// - huella conocida en otra ruta      → el archivo se movio o renombro: mismo item;
// - huella nueva en una ruta conocida → el archivo se edito (p. ej. anotado):
//   es una version nueva del mismo item, siempre que la huella anterior ya no
//   exista en ningun otro lugar;
// - huella nueva en una ruta nueva    → item nuevo.
// Un archivo conocido sin item (`itemId: null`) fue descartado por el usuario
// y no vuelve a crear un item.

/**
 * @param {object} input
 * @param {Array<{ relPath: string, sha256: string, size: number, mtimeMs: number }>} input.scanned  archivos hoy en la carpeta
 * @param {Array<{ relPath: string, sha256: string }>} input.previous  ubicaciones que la biblioteca conocia en esta carpeta
 * @param {Map<string, { itemId: string|null }>} input.files  archivos conocidos por huella
 * @param {Set<string>} input.elsewhere  huellas presentes en otras carpetas de origen
 */
export function planFolderSync({ scanned, previous, files, elsewhere }) {
  const present = new Set(scanned.map((entry) => entry.sha256));
  const previousByPath = new Map(previous.map((entry) => [entry.relPath, entry.sha256]));
  const create = [];
  const newVersions = [];
  const planned = new Set();
  const superseded = new Set();

  for (const entry of [...scanned].sort((left, right) => left.relPath.localeCompare(right.relPath))) {
    if (files.has(entry.sha256) || planned.has(entry.sha256)) continue;
    planned.add(entry.sha256);

    const before = previousByPath.get(entry.relPath);
    const itemId = before ? files.get(before)?.itemId ?? null : null;
    const replaced = before && itemId && !present.has(before) && !elsewhere.has(before) && !superseded.has(before);
    if (replaced) {
      superseded.add(before);
      newVersions.push({ ...entry, itemId, replaces: before });
    } else {
      create.push(entry);
    }
  }

  // Huellas que estaban en esta carpeta y ya no estan en ningun lado.
  const gone = [...new Set(previous.map((entry) => entry.sha256))]
    .filter((sha256) => !present.has(sha256) && !elsewhere.has(sha256));

  return {
    create,
    newVersions,
    gone,
    moved: scanned.filter((entry) => files.has(entry.sha256) && previousByPath.get(entry.relPath) !== entry.sha256).length,
    locations: scanned.map(({ relPath, sha256, size, mtimeMs }) => ({ relPath, sha256, size, mtimeMs })),
  };
}

// Carpetas del disco que hay que reflejar en la biblioteca para un archivo:
// "Calculo/Practicos/p1.pdf" → ["Calculo", "Practicos"].
export const directoriesOf = (relPath) => relPath.split("/").slice(0, -1);
