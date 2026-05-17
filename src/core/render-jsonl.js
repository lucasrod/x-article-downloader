import { summarizeTextForEvidence } from "./utils.js";

export function renderJsonl(document, options = {}) {
  const records = options.chunkMode === "headings"
    ? buildChunkRecords(document)
    : buildBlockRecords(document);

  if (options.includeEvidence !== false) {
    for (const evidence of document.signals?.evidence_items ?? []) {
      records.push({
        record_type: "evidence",
        ...evidence,
      });
    }
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`;
}

export function renderEvidenceJsonl(document) {
  const evidence = document.signals?.evidence_items ?? [];
  return `${evidence.map((item) => JSON.stringify(item)).join("\n")}${evidence.length ? "\n" : ""}`;
}

function buildBlockRecords(document) {
  return document.article.blocks.map((block, index) => ({
    record_type: "block",
    block_index: index,
    article_slug: document.article.slug,
    block,
  }));
}

function buildChunkRecords(document) {
  const chunks = [];
  const headings = [];
  let chunkIndex = 0;

  for (const block of document.article.blocks) {
    if (block.type === "heading") {
      headings[block.level - 1] = stripMarkdown(block.text);
      headings.length = block.level;
      continue;
    }

    const text = blockToChunkText(block);
    if (!text) {
      continue;
    }

    chunks.push({
      record_type: "chunk",
      chunk_id: `${document.article.slug}-chunk-${String(++chunkIndex).padStart(3, "0")}`,
      heading_path: headings.filter(Boolean),
      text,
      source_url: document.source.status_url,
    });
  }

  return chunks;
}

function blockToChunkText(block) {
  switch (block.type) {
    case "paragraph":
    case "blockquote":
      return summarizeTextForEvidence(block.text, 4000);
    case "list":
      return block.items.map((item) => `- ${stripMarkdown(item)}`).join("\n");
    case "code":
      return block.text;
    case "image":
      return `[image] ${block.alt || "Image"} ${block.src}`;
    case "embedded_post":
      return `[embedded_post] ${stripMarkdown(block.text || "")}`;
    default:
      return null;
  }
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
