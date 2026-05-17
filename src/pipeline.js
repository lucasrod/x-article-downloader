import { buildSocialBrief } from "./core/brief.js";
import { writeBundle } from "./core/bundle.js";
import { createImageResolver, materializeDocumentAssets } from "./core/images.js";
import { deriveOutputPlan, finalizeDocument, writeTextFile } from "./core/output.js";
import { renderJson } from "./core/render-json.js";
import { renderEvidenceJsonl, renderJsonl } from "./core/render-jsonl.js";
import { renderMarkdown } from "./core/render-markdown.js";
import { collectSignals } from "./providers/signals.js";

export async function prepareDocument(document, options) {
  const outputPlan = deriveOutputPlan(options.outputPath, options.format);
  const primaryOutputPath = outputPlan.markdownPath ?? outputPlan.jsonPath ?? outputPlan.jsonlPath;
  const resolver = createImageResolver({
    mode: options.images,
    assetsDir: options.assetsDir,
    outputPath: primaryOutputPath,
  });

  const materialized = await materializeDocumentAssets(document, resolver.resolveImage);
  const { signals } = await collectSignals(materialized, {
    signalsMode: options.signals,
    xProvider: options.xProvider,
    repliesMode: options.xReplies,
    quotesMode: options.xQuotes,
    bearerTokenEnv: options.bearerTokenEnv,
    grokApiKeyEnv: options.grokApiKeyEnv,
    timeout: options.timeout,
  });

  const provisional = finalizeDocument(materialized, {
    format: options.format,
    imagesMode: options.images,
    embeddedPostsMode: options.embeddedPosts,
    signals,
    brief: null,
  });
  const brief = buildSocialBrief(provisional, options.brief);
  const finalized = finalizeDocument(materialized, {
    format: options.format,
    imagesMode: options.images,
    embeddedPostsMode: options.embeddedPosts,
    signals,
    brief,
  });

  return {
    document: finalized,
    outputPlan,
    markdown: await renderMarkdown(finalized, {
      embeddedPosts: options.embeddedPosts,
    }),
    jsonText: renderJson(finalized),
    jsonlText: renderJsonl(finalized, {
      chunkMode: options.chunk,
    }),
    evidenceJsonl: renderEvidenceJsonl(finalized),
    briefMarkdown: brief?.markdown ?? "",
    chunksJsonl: options.chunk === "headings"
      ? renderJsonl(finalized, { chunkMode: "headings", includeEvidence: false })
      : null,
    downloadCount: resolver.downloadCount,
  };
}

export async function writePreparedOutput(prepared) {
  if (prepared.outputPlan.kind === "bundle") {
    await writeBundle({
      outputPlan: prepared.outputPlan,
      markdown: prepared.markdown,
      jsonText: prepared.jsonText,
      signalsText: `${JSON.stringify(prepared.document.signals, null, 2)}\n`,
      briefMarkdown: prepared.briefMarkdown,
      evidenceJsonl: prepared.evidenceJsonl,
      chunksJsonl: prepared.chunksJsonl,
    });
    return;
  }

  if (prepared.outputPlan.markdownPath) {
    await writeTextFile(prepared.outputPlan.markdownPath, prepared.markdown);
  }
  if (prepared.outputPlan.jsonPath) {
    await writeTextFile(prepared.outputPlan.jsonPath, prepared.jsonText);
  }
  if (prepared.outputPlan.jsonlPath) {
    await writeTextFile(prepared.outputPlan.jsonlPath, prepared.jsonlText);
  }
}
