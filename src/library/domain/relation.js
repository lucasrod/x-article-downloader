import { conflict, invalid } from "./errors.js";

// Relacion: una arista con significado entre dos items. Es lo que convierte la
// biblioteca en un grafo de conocimiento.
//
// - `label` se lee de origen a destino; `inverse`, de destino a origen.
// - `symmetric`: no tiene direccion (A–B es lo mismo que B–A).
// - `acyclic`: expresa un orden, asi que no admite ciclos (si A requiere B,
//   B no puede requerir A, ni directa ni indirectamente).

export const RELATION_TYPES = {
  requires: { label: "requiere haber leído", inverse: "es requisito de", symmetric: false, acyclic: true },
  continues: { label: "es continuación de", inverse: "continúa en", symmetric: false, acyclic: true },
  "part-of": { label: "es parte de", inverse: "contiene a", symmetric: false, acyclic: true },
  cites: { label: "cita a", inverse: "es citado por", symmetric: false, acyclic: false },
  related: { label: "se relaciona con", inverse: "se relaciona con", symmetric: true, acyclic: false },
};

export function createRelation(existing, { id, fromId, toId, type, note = "", now }) {
  const rules = RELATION_TYPES[type];
  if (!rules) {
    throw invalid(`Tipo de relación desconocido: ${type}.`);
  }
  if (fromId === toId) {
    throw invalid("Un item no puede relacionarse consigo mismo.");
  }
  // Una relacion simetrica se guarda siempre en el mismo sentido.
  const [from, to] = rules.symmetric && fromId > toId ? [toId, fromId] : [fromId, toId];

  if (existing.some((relation) => relation.type === type && relation.fromId === from && relation.toId === to)) {
    throw conflict("Esa relación ya existe.");
  }
  if (rules.acyclic && reaches(existing.filter((relation) => relation.type === type), to, from)) {
    throw invalid(`Esa relación formaría un ciclo: el destino ya "${rules.label}" el origen, directa o indirectamente.`);
  }
  return { id, fromId: from, toId: to, type, note: String(note ?? "").trim(), createdAt: now };
}

// Al unir dos items, las relaciones del absorbido pasan al que queda. Las que
// quedarian apuntando a si mismo o repetidas se descartan.
export function repointRelations(relations, absorbedId, targetId) {
  const seen = new Set(relations
    .filter((relation) => relation.fromId !== absorbedId && relation.toId !== absorbedId)
    .map(relationKey));
  const changed = [];
  const dropped = [];

  for (const relation of relations) {
    if (relation.fromId !== absorbedId && relation.toId !== absorbedId) continue;
    let fromId = relation.fromId === absorbedId ? targetId : relation.fromId;
    let toId = relation.toId === absorbedId ? targetId : relation.toId;
    if (RELATION_TYPES[relation.type]?.symmetric && fromId > toId) [fromId, toId] = [toId, fromId];
    const next = { ...relation, fromId, toId };
    if (fromId === toId || seen.has(relationKey(next))) {
      dropped.push(relation.id);
    } else {
      seen.add(relationKey(next));
      changed.push(next);
    }
  }
  return { changed, dropped };
}

// Relaciones de un item vistas desde el: con quien, y como se lee desde aca.
export function relationsOf(relations, itemId) {
  return relations
    .filter((relation) => relation.fromId === itemId || relation.toId === itemId)
    .map((relation) => {
      const outgoing = relation.fromId === itemId;
      const rules = RELATION_TYPES[relation.type];
      return {
        id: relation.id,
        type: relation.type,
        direction: rules.symmetric ? "both" : outgoing ? "out" : "in",
        label: outgoing ? rules.label : rules.inverse,
        otherId: outgoing ? relation.toId : relation.fromId,
        note: relation.note,
      };
    });
}

const relationKey = (relation) => `${relation.type}:${relation.fromId}:${relation.toId}`;

// ¿Se llega de `start` a `goal` siguiendo las relaciones en su sentido?
function reaches(relations, start, goal) {
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === goal) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const relation of relations) {
      if (relation.fromId === current) pending.push(relation.toId);
    }
  }
  return false;
}
