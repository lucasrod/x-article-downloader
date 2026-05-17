import fs from "node:fs/promises";
import path from "node:path";
import { rebuildDocumentIndexes } from "./article-schema.js";

export function createImageResolver({ mode, assetsDir, outputPath }) {
  let downloadCount = 0;
  const seen = new Map();

  return {
    get downloadCount() {
      return downloadCount;
    },
    async resolveImage(src) {
      if (mode === "embed") {
        return normalizeImageUrl(src);
      }

      const normalized = normalizeImageUrl(src);
      if (seen.has(normalized)) {
        return seen.get(normalized);
      }

      await fs.mkdir(assetsDir, { recursive: true });

      const extension = inferExtension(normalized);
      const filename = `image-${String(downloadCount + 1).padStart(3, "0")}.${extension}`;
      const absolutePath = path.join(assetsDir, filename);
      const relativePath = path.relative(path.dirname(outputPath), absolutePath).split(path.sep).join("/");
      const response = await fetch(normalized, {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      });

      if (!response.ok) {
        throw new Error(`No pude descargar la imagen: ${normalized}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(absolutePath, buffer);

      downloadCount += 1;
      seen.set(normalized, relativePath);
      return relativePath;
    },
  };
}

export async function materializeDocumentAssets(document, resolveImage) {
  const cloned = structuredClone(document);

  for (const block of cloned.article.blocks) {
    if (block.type === "image") {
      block.src = await resolveImage(block.src);
      continue;
    }

    if (block.type === "embedded_post" && Array.isArray(block.images)) {
      for (const image of block.images) {
        image.src = await resolveImage(image.src);
      }
    }
  }

  return rebuildDocumentIndexes(cloned);
}

function normalizeImageUrl(src) {
  const url = new URL(src);
  if (!url.searchParams.has("name") || url.searchParams.get("name") !== "orig") {
    url.searchParams.set("name", "orig");
  }
  return url.toString();
}

function inferExtension(src) {
  const url = new URL(src);
  const format = url.searchParams.get("format");
  if (format) {
    return format;
  }

  const match = url.pathname.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1] ?? "jpg";
}
