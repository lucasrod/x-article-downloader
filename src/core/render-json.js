export function renderJson(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}
