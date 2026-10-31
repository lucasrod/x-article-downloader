import { chromium } from "playwright";
import { extractRecurringThemes, summarizeTextForEvidence } from "../core/utils.js";

export async function collectBrowserCommentSignals(document, options) {
  const trace = {
    provider: "browser",
    started_at: new Date().toISOString(),
    status: "skipped",
    steps: [],
    failures: [],
  };

  if (options.repliesMode !== "best-effort") {
    trace.finished_at = new Date().toISOString();
    return { trace, patch: null, evidenceItems: [] };
  }

  let browser = null;
  let context = null;
  const connectedOverCdp = Boolean(options.cdpEndpoint);

  try {
    browser = connectedOverCdp
      ? await chromium.connectOverCDP(options.cdpEndpoint)
      : await chromium.launch({ headless: true });
    context = connectedOverCdp
      ? browser.contexts()[0] ?? await browser.newContext()
      : await browser.newContext({
          viewport: { width: 1440, height: 2400 },
          storageState: options.storageState || undefined,
        });

    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 2400 });
    await page.goto(document.source.status_url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeout,
    });
    trace.steps.push("status_page");

    await page.locator('article[data-testid="tweet"]').first().waitFor({
      state: "attached",
      timeout: Math.min(options.timeout, 60000),
    });

    for (let index = 0; index < 5; index += 1) {
      await page.waitForTimeout(1500);
      await page.mouse.wheel(0, 1400);
    }

    const replies = await page.evaluate(({ rootStatusId, limit }) => {
      const seen = new Set();
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      const items = [];

      for (const article of articles) {
        const statusLink = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map((link) => link.href)
          .find((href) => /\/status\/\d+/.test(href));
        const statusId = statusLink?.match(/\/status\/(\d+)/)?.[1] ?? null;
        if (!statusId || statusId === rootStatusId || seen.has(statusId)) {
          continue;
        }

        const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() ?? "";
        if (!text) {
          continue;
        }

        seen.add(statusId);
        const userNameText = article.querySelector('[data-testid="User-Name"]')?.innerText ?? "";
        const handle = userNameText.match(/@[\w_]+/)?.[0] ?? null;
        const name = userNameText
          .split("\n")
          .map((part) => part.trim())
          .find((part) => part && !part.startsWith("@")) ?? null;
        const time = article.querySelector("time");
        const metricLabel = article.querySelector('[role="group"][aria-label]')?.getAttribute("aria-label") ?? "";

        items.push({
          id: statusId,
          url: statusLink,
          author: { name, handle },
          created_at: time?.getAttribute("datetime") ?? null,
          text,
          metric_label: metricLabel,
        });

        if (items.length >= limit) {
          break;
        }
      }

      return items;
    }, {
      rootStatusId: document.source.status_id,
      limit: options.limit ?? 12,
    });

    trace.steps.push("visible_replies");
    trace.status = "ok";
    trace.finished_at = new Date().toISOString();

    const evidenceItems = replies.map((reply) => toEvidenceItem(reply));
    return {
      trace,
      patch: {
        conversation: {
          mode_used: "best-effort",
          reply_count_collected: evidenceItems.length,
          top_replies: evidenceItems.slice(0, 8),
          recurring_themes: extractRecurringThemes(evidenceItems.map((item) => item.text)),
          source: "browser-visible-replies",
        },
      },
      evidenceItems,
    };
  } catch (error) {
    trace.status = "error";
    trace.failures.push({
      step: "visible_replies",
      detail: error.message,
    });
    trace.finished_at = new Date().toISOString();
    return { trace, patch: null, evidenceItems: [] };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function toEvidenceItem(reply) {
  return {
    source_platform: "x",
    kind: "reply",
    url: reply.url,
    author: reply.author,
    created_at: reply.created_at,
    text: summarizeTextForEvidence(reply.text),
    metrics: parseMetricLabel(reply.metric_label),
    relevance_reason: "Visible reply ranked under the article status by X at collection time.",
  };
}

function parseMetricLabel(label) {
  const text = String(label || "").toLowerCase();
  return {
    replies: matchMetric(text, ["reply", "replies", "respuesta", "respuestas"]),
    reposts: matchMetric(text, ["repost", "reposts", "retweet", "retweets"]),
    likes: matchMetric(text, ["like", "likes", "me gusta"]),
    views: matchMetric(text, ["view", "views", "visualizacion", "visualizaciones"]),
  };
}

function matchMetric(text, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const after = text.match(new RegExp(`([\\d.,]+\\s*[kmb]?)\\s+${escaped}`));
    if (after) {
      return parseCompactNumber(after[1]);
    }
    const before = text.match(new RegExp(`${escaped}\\s+([\\d.,]+\\s*[kmb]?)`));
    if (before) {
      return parseCompactNumber(before[1]);
    }
  }
  return null;
}

function parseCompactNumber(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  const suffix = normalized.match(/[kmb]$/i)?.[0]?.toLowerCase() ?? "";
  const numberText = suffix ? normalized.slice(0, -1) : normalized;
  const decimalNormalized = numberText.includes(",") && !numberText.includes(".")
    ? numberText.replace(",", ".")
    : numberText.replace(/,/g, "");
  const base = Number(decimalNormalized);
  if (Number.isNaN(base)) {
    return null;
  }
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return Math.round(base * multiplier);
}
