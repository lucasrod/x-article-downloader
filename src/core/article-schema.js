export const SCHEMA_VERSION = "x-social-intelligence/v1";

export const IMAGE_MODES = ["embed", "download"];
export const EMBEDDED_POST_MODES = ["quote", "link", "omit"];
export const OUTPUT_FORMATS = ["md", "json", "md+json", "jsonl", "bundle"];
export const SIGNAL_MODES = ["none", "x-basic", "x-full"];
export const X_PROVIDERS = ["x-api", "grok", "hybrid"];
export const X_REPLIES_MODES = ["none", "api", "best-effort"];
export const X_QUOTES_MODES = ["none", "api"];
export const BRIEF_MODES = ["none", "short", "full"];
export const CHUNK_MODES = ["none", "headings"];

export function createArticleDocument({
  sourceUrl,
  statusId,
  authorHandle,
  authorName,
  fetchedAt,
  title,
  slug,
  blocks,
}) {
  return {
    schema_version: SCHEMA_VERSION,
    source: {
      platform: "x",
      status_url: sourceUrl,
      status_id: statusId,
      author_handle: authorHandle,
      author_name: authorName,
      fetched_at: fetchedAt,
    },
    article: {
      title,
      slug,
      blocks,
      embedded_posts: collectEmbeddedPosts(blocks),
      images: collectImages(blocks),
    },
    rendering: null,
    provenance: {
      extractor: "playwright-status-dom@1",
      renderer: null,
      content_hash: null,
    },
    signals: null,
    brief: null,
  };
}

export function rebuildDocumentIndexes(document) {
  return {
    ...document,
    article: {
      ...document.article,
      embedded_posts: collectEmbeddedPosts(document.article.blocks),
      images: collectImages(document.article.blocks),
    },
  };
}

export function collectEmbeddedPosts(blocks) {
  return blocks
    .filter((block) => block.type === "embedded_post")
    .map((block) => ({
      id: block.id,
      url: block.url,
      author: block.author,
      date_text: block.date_text,
      date_iso: block.date_iso,
      text: block.text,
      images: block.images ?? [],
    }));
}

export function collectImages(blocks) {
  return blocks
    .filter((block) => block.type === "image")
    .map((block) => ({
      alt: block.alt,
      src: block.src,
    }));
}
