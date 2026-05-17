export async function renderMarkdown(document, options) {
  const lines = [];
  lines.push(`# ${document.article.title}`);

  const meta = [document.source.author_name, document.source.author_handle].filter(Boolean).join(" ");
  if (meta) {
    lines.push("");
    lines.push(meta);
  }

  lines.push("");
  lines.push(`Fuente: ${document.source.status_url}`);

  for (const block of document.article.blocks) {
    const rendered = renderBlock(block, options);
    if (!rendered) {
      continue;
    }

    if (lines.at(-1) !== "") {
      lines.push("");
    }

    lines.push(rendered);
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderBlock(block, options) {
  switch (block.type) {
    case "paragraph":
      return cleanupInlineMarkdown(block.text);
    case "heading":
      return `${"#".repeat(Math.max(2, Math.min(block.level, 6)))} ${stripWrappingMarkers(cleanupInlineMarkdown(block.text))}`;
    case "blockquote":
      return cleanupInlineMarkdown(block.text)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "list":
      return block.items
        .map((item, index) => block.ordered ? `${index + 1}. ${cleanupInlineMarkdown(item)}` : `- ${cleanupInlineMarkdown(item)}`)
        .join("\n");
    case "separator":
      return "---";
    case "code":
      return `\`\`\`${block.language}\n${block.text}\n\`\`\``;
    case "image":
      return `![${escapeBrackets(block.alt || "Image")}](${block.src})`;
    case "embedded_post":
      return renderEmbeddedPost(block, options);
    default:
      return null;
  }
}

function renderEmbeddedPost(block, options) {
  if (options.embeddedPosts === "omit") {
    return null;
  }

  if (options.embeddedPosts === "link") {
    return block.url ? `[Post embebido](${block.url})` : "Post embebido";
  }

  const header = [block.author?.name, block.author?.handle].filter(Boolean).join(" ");
  const date = block.date_text ? ` · ${block.date_text}` : "";
  const bodyLines = String(block.text || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => `> ${line}`);
  const footer = block.url ? `> ${block.url}` : null;

  return [
    `> [Post embebido]`,
    header ? `> ${header}${date}` : null,
    ...bodyLines,
    footer,
  ]
    .filter(Boolean)
    .join("\n");
}

function cleanupInlineMarkdown(text) {
  return String(text || "")
    .replace(/\s+\)/g, ")")
    .replace(/\(\s+/g, "(")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .trim();
}

function stripWrappingMarkers(text) {
  return text
    .replace(/^([*_`]+)/, "")
    .replace(/([*_`]+)$/, "")
    .trim();
}

function escapeBrackets(text) {
  return String(text || "").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
