// Error de regla de negocio. `code` lo traduce cada adaptador de entrada
// (HTTP: invalid → 400, not_found → 404, conflict → 409).

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export const invalid = (message) => new DomainError("invalid", message);
export const notFound = (message) => new DomainError("not_found", message);
export const conflict = (message) => new DomainError("conflict", message);

export function requireName(value, what) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name) {
    throw invalid(`${what} necesita un nombre.`);
  }
  if (name.length > 200) {
    throw invalid(`${what} no puede tener más de 200 caracteres.`);
  }
  return name;
}
