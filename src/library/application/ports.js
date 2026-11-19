// Puertos de salida de la biblioteca. La aplicacion depende de estas formas,
// no de SQLite ni del filesystem; los adaptadores viven en src/library/adapters.
// Todos los metodos pueden ser asincronos.

/**
 * Persistencia de los tres agregados. Guardar un agregado reemplaza su estado
 * completo (incluidas etiquetas, referencias y entradas) de forma atomica.
 * Borrar un item o una lista tambien borra las referencias que lo apuntan.
 *
 * @typedef {object} LibraryRepository
 * @property {() => Promise<object[]>} listItems
 * @property {(id: string) => Promise<object|null>} getItem
 * @property {(items: object[]) => Promise<void>} saveItems
 * @property {(id: string) => Promise<void>} deleteItem
 * @property {() => Promise<object[]>} listFolders
 * @property {(folder: object) => Promise<void>} saveFolder
 * @property {(ids: string[]) => Promise<void>} deleteFolders
 * @property {() => Promise<object[]>} listReadingLists
 * @property {(id: string) => Promise<object|null>} getReadingList
 * @property {(list: object) => Promise<void>} saveReadingList
 * @property {(id: string) => Promise<void>} deleteReadingList
 * @property {() => Promise<object[]>} listSources
 * @property {(source: object) => Promise<void>} saveSource
 * @property {(id: string) => Promise<void>} deleteSource  borra tambien sus ubicaciones
 * @property {() => Promise<object[]>} listFiles
 * @property {(files: object[]) => Promise<void>} saveFiles
 * @property {(hashes: string[]) => Promise<void>} deleteFiles
 * @property {(sha256: string) => Promise<string>} getFileText
 * @property {(sha256: string, text: string) => Promise<void>} saveFileText
 * @property {(sourceId?: string) => Promise<object[]>} listLocations
 * @property {(sourceId: string, locations: object[]) => Promise<void>} replaceLocations
 */

/**
 * Lectura de una carpeta del disco.
 *
 * @typedef {object} FolderScanner
 * @property {(root: string) => Promise<Array<{ relPath: string, size: number, mtimeMs: number }>>} list
 * @property {(root: string, relPath: string) => Promise<string>} hash  SHA-256 en hexadecimal
 * @property {(root: string, relPath: string) => string} resolve  ruta absoluta
 * @property {(path: string) => Promise<boolean>} isDirectory
 * @property {(path: string) => Promise<boolean>} isFile
 */

/**
 * Almacen de archivos por huella. Solo guarda contenido cuyo SHA-256 coincide.
 *
 * @typedef {object} FileStore
 * @property {(sourcePath: string, sha256: string) => Promise<void>} archive
 * @property {(sha256: string) => Promise<boolean>} has
 * @property {(sha256: string) => string} pathOf
 */

/**
 * Extraccion de texto. Opcional: sin ella los archivos no son buscables por contenido.
 *
 * @typedef {object} TextExtractor
 * @property {(path: string) => Promise<{ text: string, pages: number|null }|null>} extract
 */

/**
 * Fuente de material capturado fuera de la biblioteca (hoy: articulos de X en
 * disco; despues: una carpeta de PDFs). `key` es la identidad estable del
 * material en su origen; `ref` es la referencia para volver a encontrarlo.
 *
 * @typedef {object} CapturedSource
 * @property {() => Promise<Array<{ key: string, kind: string, title: string, authors: string[], ref: object }>>} listCaptured
 */

export {};
