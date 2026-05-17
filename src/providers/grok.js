import { extractRecurringThemes, safeJsonParse } from "../core/utils.js";

const RESPONSES_API_URL = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4.20-reasoning";

export async function collectGrokAwareness(document, currentSignals, options) {
  const apiKey = options.apiKey;
  const trace = {
    provider: "grok",
    started_at: new Date().toISOString(),
    status: "skipped",
    steps: [],
    failures: [],
  };

  if (!apiKey) {
    trace.failures.push({
      step: "auth",
      detail: `Falta API key en ${options.apiKeyEnv}`,
    });
    trace.finished_at = new Date().toISOString();
    return { trace, awareness: null, evidenceItems: [] };
  }

  const prompt = buildPrompt(document, currentSignals, options);

  try {
    const response = await fetch(RESPONSES_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_GROK_MODEL,
        input: [
          {
            role: "system",
            content: "You analyze social awareness around X posts and X Articles. Return only schema-compliant JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        tools: [
          {
            type: "x_search",
            enable_image_understanding: false,
            enable_video_understanding: false,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "x_article_awareness",
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "summary",
                "viral_stage",
                "engagement_velocity_bucket",
                "sentiment_mix",
                "skepticism_themes",
                "implementation_interest_themes",
                "notable_amplifiers",
              ],
              properties: {
                summary: { type: "string" },
                viral_stage: { type: "string" },
                engagement_velocity_bucket: { type: "string" },
                sentiment_mix: { type: "string" },
                skepticism_themes: {
                  type: "array",
                  items: { type: "string" },
                },
                implementation_interest_themes: {
                  type: "array",
                  items: { type: "string" },
                },
                notable_amplifiers: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["handle", "reason"],
                    properties: {
                      handle: { type: "string" },
                      reason: { type: "string" },
                    },
                  },
                },
                example_posts: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["url", "author_handle", "text", "relevance_reason"],
                    properties: {
                      url: { type: "string" },
                      author_handle: { type: "string" },
                      text: { type: "string" },
                      relevance_reason: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`xAI ${response.status}: ${body.slice(0, 400)}`);
    }

    trace.steps.push("responses.create");
    const payload = await response.json();
    const outputText = payload.output_text ?? extractOutputText(payload) ?? "{}";
    const parsed = safeJsonParse(outputText, {});
    const evidenceItems = (parsed.example_posts ?? []).map((item) => ({
      source_platform: "x",
      kind: "awareness_hit",
      url: item.url,
      author: {
        handle: item.author_handle,
      },
      created_at: null,
      text: item.text,
      metrics: null,
      relevance_reason: item.relevance_reason,
    }));

    trace.status = "ok";
    trace.finished_at = new Date().toISOString();

    return {
      trace,
      awareness: {
        provider: "grok",
        summary: parsed.summary ?? "No summary returned.",
        viral_stage: parsed.viral_stage ?? currentSignals?.awareness?.viral_stage ?? "unknown",
        engagement_velocity_bucket: parsed.engagement_velocity_bucket ?? currentSignals?.awareness?.engagement_velocity_bucket ?? "unknown",
        sentiment_mix: parsed.sentiment_mix ?? "unknown",
        skepticism_themes: parsed.skepticism_themes ?? [],
        implementation_interest_themes: parsed.implementation_interest_themes ?? [],
        notable_amplifiers: parsed.notable_amplifiers ?? [],
        recurring_themes: extractRecurringThemes(evidenceItems.map((item) => item.text)),
      },
      evidenceItems,
    };
  } catch (error) {
    trace.status = "error";
    trace.failures.push({
      step: "responses.create",
      detail: error.message,
    });
    trace.finished_at = new Date().toISOString();
    return { trace, awareness: null, evidenceItems: [] };
  }
}

function buildPrompt(document, currentSignals, options) {
  return [
    `Analyze the X article post at ${document.source.status_url}.`,
    `Article title: ${document.article.title}`,
    `Author: ${document.source.author_name ?? "unknown"} ${document.source.author_handle ?? ""}`.trim(),
    `Existing metrics: ${JSON.stringify(currentSignals?.metrics ?? {})}`,
    `Embedded posts in article: ${(document.article.embedded_posts ?? []).length}`,
    "Need: summarize if it appears viral, what people are saying on X, notable amplifiers, skepticism themes, and implementation-interest themes.",
    "If you cite example posts, prefer highly relevant posts about the same article or root post.",
    options.repliesMode !== "none" ? `Replies mode requested: ${options.repliesMode}` : "",
    options.quotesMode !== "none" ? `Quotes mode requested: ${options.quotesMode}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractOutputText(payload) {
  if (!Array.isArray(payload.output)) {
    return null;
  }

  const texts = [];
  for (const item of payload.output) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  return texts.join("\n").trim() || null;
}
