import { extractArticle } from "../core/extract.js";
import { inferEngagementVelocityBucket, inferViralStage, pickEnv } from "../core/utils.js";
import { collectGrokAwareness } from "./grok.js";
import { collectXApiSignals } from "./x-api.js";

export async function collectSignals(documentOrUrl, options) {
  if (options.signalsMode === "none") {
    return { signals: null, evidenceItems: [] };
  }

  const document = typeof documentOrUrl === "string"
    ? await extractArticle(documentOrUrl, options.timeout ?? 120000)
    : documentOrUrl;

  const signalPack = {
    root_post: {
      url: document.source.status_url,
      id: document.source.status_id,
      author: {
        handle: document.source.author_handle,
        name: document.source.author_name,
      },
      created_at: null,
    },
    metrics: {
      likes: null,
      replies: null,
      reposts: null,
      quotes: null,
      bookmarks: null,
      impressions: null,
    },
    conversation: {
      mode_used: options.repliesMode,
      reply_count_collected: 0,
      top_replies: [],
      recurring_themes: [],
      source: options.repliesMode,
    },
    quotes: {
      mode_used: options.quotesMode,
      quote_count_collected: 0,
      top_quote_posts: [],
      recurring_themes: [],
      source: options.quotesMode,
    },
    awareness: {
      provider: "heuristic",
      summary: "No external provider data available yet.",
      viral_stage: "unknown",
      engagement_velocity_bucket: "unknown",
      sentiment_mix: "unknown",
      skepticism_themes: [],
      implementation_interest_themes: [],
      notable_amplifiers: [],
    },
    evidence_items: [],
    provider_trace: {
      requested_provider: options.xProvider,
      generated_at: new Date().toISOString(),
      attempts: [],
      failures: [],
    },
  };

  if (options.xProvider === "x-api" || options.xProvider === "hybrid") {
    const xApi = await collectXApiSignals(document, {
      bearerToken: pickEnv(options.bearerTokenEnv),
      bearerTokenEnv: options.bearerTokenEnv,
      repliesMode: options.repliesMode,
      quotesMode: options.quotesMode,
    });
    signalPack.provider_trace.attempts.push(xApi.trace);
    signalPack.provider_trace.failures.push(...xApi.trace.failures);
    mergeSignals(signalPack, xApi.patch);
    signalPack.evidence_items.push(...xApi.evidenceItems);
  }

  if (options.signalsMode === "x-full" && (options.xProvider === "grok" || options.xProvider === "hybrid")) {
    const grok = await collectGrokAwareness(document, signalPack, {
      apiKey: pickEnv(options.grokApiKeyEnv),
      apiKeyEnv: options.grokApiKeyEnv,
      repliesMode: options.repliesMode,
      quotesMode: options.quotesMode,
    });
    signalPack.provider_trace.attempts.push(grok.trace);
    signalPack.provider_trace.failures.push(...grok.trace.failures);
    if (grok.awareness) {
      signalPack.awareness = {
        ...signalPack.awareness,
        ...grok.awareness,
      };
    }
    signalPack.evidence_items.push(...grok.evidenceItems);
  }

  if (signalPack.awareness.provider === "heuristic") {
    signalPack.awareness = {
      ...signalPack.awareness,
      summary: buildHeuristicSummary(signalPack),
      viral_stage: inferViralStage(signalPack.metrics),
      engagement_velocity_bucket: inferEngagementVelocityBucket(signalPack.root_post.created_at, signalPack.metrics),
    };
  }

  return {
    signals: signalPack,
    evidenceItems: signalPack.evidence_items,
  };
}

function mergeSignals(target, patch) {
  if (!patch) {
    return;
  }

  if (patch.root_post) {
    target.root_post = { ...target.root_post, ...patch.root_post };
  }
  if (patch.metrics) {
    target.metrics = { ...target.metrics, ...patch.metrics };
  }
  if (patch.conversation) {
    target.conversation = { ...target.conversation, ...patch.conversation };
  }
  if (patch.quotes) {
    target.quotes = { ...target.quotes, ...patch.quotes };
  }
  if (patch.awareness) {
    target.awareness = { ...target.awareness, ...patch.awareness };
  }
}

function buildHeuristicSummary(signals) {
  const likes = signals.metrics.likes ?? 0;
  const replies = signals.metrics.replies ?? 0;
  const quotes = signals.metrics.quotes ?? 0;

  if (likes || replies || quotes) {
    return `La senal disponible muestra ${likes} likes, ${replies} replies y ${quotes} quotes en el post raiz.`;
  }

  if (signals.provider_trace.failures.length > 0) {
    return "No se pudo enriquecer con providers externos; revisa credenciales o limites del provider.";
  }

  return "No hubo datos sociales adicionales para este articulo.";
}
