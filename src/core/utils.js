import crypto from "node:crypto";

const STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "com",
  "con",
  "de",
  "del",
  "el",
  "en",
  "for",
  "from",
  "how",
  "https",
  "i",
  "in",
  "is",
  "it",
  "la",
  "las",
  "los",
  "of",
  "on",
  "para",
  "por",
  "que",
  "rt",
  "the",
  "this",
  "to",
  "un",
  "una",
  "with",
  "x",
]);

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "article";
}

export function extractStatusId(url) {
  return String(url).match(/\/status\/(\d+)/)?.[1] ?? null;
}

export function computeContentHash(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function pickEnv(name) {
  if (!name) {
    return null;
  }
  return process.env[name] ?? null;
}

export function summarizeTextForEvidence(text, maxLength = 500) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function inferViralStage(metrics = {}) {
  const likes = metrics.likes ?? 0;
  const replies = metrics.replies ?? 0;
  const quotes = metrics.quotes ?? 0;
  const impressions = metrics.impressions ?? 0;
  const score = likes + replies * 2 + quotes * 3 + Math.floor(impressions / 1000);

  if (score >= 5000) {
    return "breakout";
  }
  if (score >= 1000) {
    return "strong";
  }
  if (score >= 250) {
    return "emerging";
  }
  if (score > 0) {
    return "early";
  }
  return "unknown";
}

export function inferEngagementVelocityBucket(createdAt, metrics = {}) {
  if (!createdAt) {
    return "unknown";
  }

  const ageHours = Math.max((Date.now() - new Date(createdAt).getTime()) / 3600000, 1);
  const volume = (metrics.likes ?? 0) + (metrics.replies ?? 0) * 2 + (metrics.quotes ?? 0) * 3;
  const velocity = volume / ageHours;

  if (velocity >= 100) {
    return "very-high";
  }
  if (velocity >= 25) {
    return "high";
  }
  if (velocity >= 5) {
    return "moderate";
  }
  if (velocity > 0) {
    return "low";
  }
  return "unknown";
}

export function extractRecurringThemes(texts, limit = 5) {
  const counts = new Map();

  for (const text of texts) {
    const words = String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9@#_ -]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word));

    const uniqueWords = new Set(words);
    for (const word of uniqueWords) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([theme, mentions]) => ({ theme, mentions }));
}

export function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
