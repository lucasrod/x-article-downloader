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
  await writeTextFile(outputPlan.signalsPath, signalsText);
  await writeTextFile(outputPlan.briefPath, briefMarkdown ?? "");
  await writeTextFile(outputPlan.evidencePath, evidenceJsonl ?? "");
  if (chunksJsonl != null) {
    await writeTextFile(outputPlan.chunksPath, chunksJsonl);
  }
}
