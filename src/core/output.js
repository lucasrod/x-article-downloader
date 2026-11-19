import fs from "node:fs/promises";
import path from "node:path";
import { computeContentHash } from "./utils.js";

export const DEFAULT_DOWNLOAD_ROOT = "./downloads/articles";

export function defaultOutputPath(document, format, imagesMode) {
  const articleDir = path.join(DEFAULT_DOWNLOAD_ROOT, document.article.slug);

  switch (format) {
    case "md":
      return path.join(articleDir, "article.md");
    case "json":
      return path.join(articleDir, "article.json");
    case "md+json":
      return path.join(articleDir, "article.md");
    case "jsonl":
      return path.join(articleDir, "article.jsonl");
    case "bundle":
      return articleDir;
    default:
      return path.join(articleDir, "article.md");
  }
}

export function defaultAssetsDir(outputPath, format) {
  const resolved = path.resolve(outputPath);
  if (format === "bundle") {
    return path.join(resolved, "assets");
  }
  return path.join(path.dirname(resolved), "assets");
}

export function deriveOutputPlan(outputPath, format) {
  const resolved = path.resolve(outputPath);

  if (format === "bundle") {
    return {
      kind: "bundle",
      bundleDir: resolved,
      markdownPath: path.join(resolved, "article.md"),
      jsonPath: path.join(resolved, "article.json"),
      signalsPath: path.join(resolved, "signals.json"),
      briefPath: path.join(resolved, "brief.md"),
      evidencePath: path.join(resolved, "evidence.jsonl"),
      chunksPath: path.join(resolved, "article.chunks.jsonl"),
    };
  }

  const extension = path.extname(resolved);
  const stem = extension ? resolved.slice(0, -extension.length) : resolved;

  switch (format) {
    case "md":
      return { kind: "single", markdownPath: extension === ".md" ? resolved : `${resolved}.md` };
    case "json":
      return { kind: "single", jsonPath: extension === ".json" ? resolved : `${resolved}.json` };
    case "md+json":
      return {
        kind: "paired",
        markdownPath: extension === ".json" ? `${stem}.md` : extension === ".md" ? resolved : `${resolved}.md`,
        jsonPath: `${stem}.json`,
      };
    case "jsonl":
      return { kind: "single", jsonlPath: extension === ".jsonl" ? resolved : `${resolved}.jsonl` };
    default:
      throw new Error(`Formato no soportado para plan de salida: ${format}`);
  }
}

export function finalizeDocument(document, { format, imagesMode, embeddedPostsMode, signals, brief }) {
  const next = structuredClone(document);
  next.rendering = {
    format,
    images_mode: imagesMode,
    embedded_posts_mode: embeddedPostsMode,
  };
  next.signals = signals;
  next.brief = brief;
  next.provenance = {
    ...next.provenance,
    renderer: format,
    content_hash: computeContentHash({
      source: next.source,
      article: next.article,
      signals: next.signals,
      brief: next.brief,
      rendering: next.rendering,
    }),
  };
  return next;
}

export async function writeTextFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
