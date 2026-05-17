import { compact, extractRecurringThemes, inferEngagementVelocityBucket, inferViralStage, summarizeTextForEvidence } from "../core/utils.js";

const API_BASE = "https://api.x.com/2";

export async function collectXApiSignals(document, options) {
  const token = options.bearerToken;
  const trace = {
    provider: "x-api",
    started_at: new Date().toISOString(),
    status: "skipped",
    steps: [],
    failures: [],
  };

  if (!token) {
    trace.failures.push({
      step: "auth",
      detail: `Falta bearer token en ${options.bearerTokenEnv}`,
    });
    trace.finished_at = new Date().toISOString();
    return { trace, patch: null, evidenceItems: [] };
  }

  const statusId = document.source.status_id;
  if (!statusId) {
    trace.failures.push({
      step: "root_post",
      detail: "No hay status_id en el documento.",
    });
    trace.finished_at = new Date().toISOString();
    return { trace, patch: null, evidenceItems: [] };
  }

  try {
    const root = await fetchJson(`${API_BASE}/tweets/${statusId}?tweet.fields=created_at,public_metrics,conversation_id,author_id&expansions=author_id&user.fields=username,name,verified`, token);
    trace.steps.push("root_post");

    const rootTweet = root.data ?? null;
    const rootUser = mapIncludesUsers(root.includes).get(rootTweet?.author_id) ?? null;
    const metrics = rootTweet?.public_metrics ?? {};
    const evidenceItems = [];

    const patch = {
      root_post: {
        url: document.source.status_url,
        id: statusId,
        author: {
          handle: rootUser?.username ? `@${rootUser.username}` : document.source.author_handle,
          name: rootUser?.name ?? document.source.author_name,
          verified: rootUser?.verified ?? null,
        },
        created_at: rootTweet?.created_at ?? null,
      },
      metrics: {
        likes: metrics.like_count ?? null,
        replies: metrics.reply_count ?? null,
        reposts: metrics.retweet_count ?? null,
        quotes: metrics.quote_count ?? null,
        bookmarks: metrics.bookmark_count ?? null,
        impressions: metrics.impression_count ?? null,
      },
      conversation: {
        mode_used: options.repliesMode,
        reply_count_collected: 0,
        top_replies: [],
        recurring_themes: [],
        source: options.repliesMode === "api" ? "x-api" : options.repliesMode,
      },
      quotes: {
        mode_used: options.quotesMode,
        quote_count_collected: 0,
        top_quote_posts: [],
        recurring_themes: [],
        source: options.quotesMode === "api" ? "x-api" : options.quotesMode,
      },
      awareness: {
        provider: "x-api",
        summary: "Metricas recuperadas desde X API.",
        viral_stage: inferViralStage({
          likes: metrics.like_count,
          replies: metrics.reply_count,
          quotes: metrics.quote_count,
          impressions: metrics.impression_count,
        }),
        engagement_velocity_bucket: inferEngagementVelocityBucket(rootTweet?.created_at, {
          likes: metrics.like_count,
          replies: metrics.reply_count,
          quotes: metrics.quote_count,
        }),
        sentiment_mix: "unknown",
        skepticism_themes: [],
        implementation_interest_themes: [],
        notable_amplifiers: [],
      },
    };

    if (options.repliesMode === "api") {
      try {
        const query = encodeURIComponent(`conversation_id:${rootTweet?.conversation_id ?? statusId} -is:retweet`);
        const replies = await fetchJson(
          `${API_BASE}/tweets/search/recent?query=${query}&tweet.fields=created_at,public_metrics,author_id,conversation_id&expansions=author_id&user.fields=username,name,verified&max_results=10`,
          token,
        );
        trace.steps.push("replies");
        const users = mapIncludesUsers(replies.includes);
        const replyItems = (replies.data ?? [])
          .filter((item) => item.id !== statusId)
          .map((item) => toEvidenceItem(item, users.get(item.author_id), "reply"));

        patch.conversation.reply_count_collected = replyItems.length;
        patch.conversation.top_replies = replyItems.slice(0, 5);
        patch.conversation.recurring_themes = extractRecurringThemes(replyItems.map((item) => item.text));
        evidenceItems.push(...replyItems);
      } catch (error) {
        trace.failures.push({
          step: "replies",
          detail: error.message,
        });
      }
    }

    if (options.quotesMode === "api") {
      try {
        const quotes = await fetchJson(
          `${API_BASE}/tweets/${statusId}/quote_tweets?tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name,verified&max_results=10`,
          token,
        );
        trace.steps.push("quotes");
        const users = mapIncludesUsers(quotes.includes);
        const quoteItems = (quotes.data ?? []).map((item) => toEvidenceItem(item, users.get(item.author_id), "quote"));

        patch.quotes.quote_count_collected = quoteItems.length;
        patch.quotes.top_quote_posts = quoteItems.slice(0, 5);
        patch.quotes.recurring_themes = extractRecurringThemes(quoteItems.map((item) => item.text));
        evidenceItems.push(...quoteItems);
      } catch (error) {
        trace.failures.push({
          step: "quotes",
          detail: error.message,
        });
      }
    }

    trace.status = "ok";
    trace.finished_at = new Date().toISOString();
    return { trace, patch, evidenceItems };
  } catch (error) {
    trace.status = "error";
    trace.failures.push({
      step: "root_post",
      detail: error.message,
    });
    trace.finished_at = new Date().toISOString();
    return { trace, patch: null, evidenceItems: [] };
  }
}

function mapIncludesUsers(includes) {
  return new Map((includes?.users ?? []).map((user) => [user.id, user]));
}

function toEvidenceItem(tweet, user, kind) {
  const metrics = tweet.public_metrics ?? {};
  return compact({
    source_platform: "x",
    kind,
    url: user?.username ? `https://x.com/${user.username}/status/${tweet.id}` : null,
    author: {
      name: user?.name ?? null,
      handle: user?.username ? `@${user.username}` : null,
      verified: user?.verified ?? null,
    },
    created_at: tweet.created_at ?? null,
    text: summarizeTextForEvidence(tweet.text),
    metrics: {
      likes: metrics.like_count ?? null,
      replies: metrics.reply_count ?? null,
      reposts: metrics.retweet_count ?? null,
      quotes: metrics.quote_count ?? null,
      impressions: metrics.impression_count ?? null,
    },
    relevance_reason: kind === "quote" ? "Quote post about the article root post." : "Reply in the root conversation.",
  });
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "user-agent": "x-article-downloader/0.2.0",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`X API ${response.status}: ${body.slice(0, 400)}`);
  }

  return response.json();
}
