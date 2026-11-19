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
