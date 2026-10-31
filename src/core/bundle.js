import fs from "node:fs/promises";
import { writeTextFile } from "./output.js";

export async function writeBundle({
  outputPlan,
  markdown,
  jsonText,
  signalsText,
  briefMarkdown,
  evidenceJsonl,
  chunksJsonl,
}) {
  await fs.mkdir(outputPlan.bundleDir, { recursive: true });
  await writeTextFile(outputPlan.markdownPath, markdown);
  await writeTextFile(outputPlan.jsonPath, jsonText);
  // Sin signals nuevas no pisamos las de una descarga anterior (p. ej. comentarios ya recolectados).
  if (signalsText != null) {
    await writeTextFile(outputPlan.signalsPath, signalsText);
  }
  if (hasContent(briefMarkdown)) {
    await writeTextFile(outputPlan.briefPath, briefMarkdown);
  } else if (signalsText != null) {
    await fs.rm(outputPlan.briefPath, { force: true });
  }
  if (hasContent(evidenceJsonl)) {
    await writeTextFile(outputPlan.evidencePath, evidenceJsonl);
  } else if (signalsText != null) {
    await fs.rm(outputPlan.evidencePath, { force: true });
  }
  if (chunksJsonl != null) {
    await writeTextFile(outputPlan.chunksPath, chunksJsonl);
  } else {
    await fs.rm(outputPlan.chunksPath, { force: true });
  }
}

function hasContent(value) {
  return String(value ?? "").trim().length > 0;
}
