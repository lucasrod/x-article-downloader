import { chromium } from "playwright";
import { normalize } from "../web/library.js";

// X junto Bookmarks y Likes bajo /i/history; /i/bookmarks redirige a esa pestaña.
const BOOKMARKS_URL = "https://x.com/i/bookmarks";
const SCROLL_PAUSE_MS = 1500;
const MAX_IDLE_ROUNDS = 5;
// Los bookmarks nuevos aparecen arriba: al cruzar varios ya revisados seguidos,
// lo que sigue tambien se reviso en una sincronizacion anterior.
const SEEN_STOP_RUN = 3;

// Recorre los bookmarks de la sesion abierta en el navegador (via CDP), del mas
// reciente al mas viejo, y reporta cada Article que todavia no esta en la biblioteca.
// Con isSeen se detiene al llegar a los bookmarks revisados antes.
export async function scanBookmarkArticles({
  cdpEndpoint,
  isKnown,
  isSeen = null,
  limit = null,
  shouldStop = () => false,
  onProgress = () => {},
}) {
  if (!cdpEndpoint) {
    throw new Error(
      "Para leer tus bookmarks hace falta tu navegador con sesion de X abierto por CDP. "
      + "Levanta la web con X_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222.",
    );
  }

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  const seen = new Set();
  const titles = new Set();
  const found = [];
  const ids = [];
  let seenRun = 0;
  let reachedSeen = false;
  let scanned = 0;
  let known = 0;
  let duplicates = 0;

  try {
    await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (/\/login|\/i\/flow/.test(page.url())) {
      throw new Error("El navegador conectado no tiene sesion de X. Inicia sesion en esa ventana y volve a sincronizar.");
    }
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 30000 });

    let idle = 0;
    while (idle < MAX_IDLE_ROUNDS && !reachedSeen && !shouldStop() && (limit == null || found.length < limit)) {
      const batch = await page.evaluate(readVisibleTweets);
      let added = 0;

      for (const tweet of batch) {
        if (!tweet.href || seen.has(tweet.href)) continue;
        seen.add(tweet.href);
        added += 1;
        const statusId = tweet.href.match(/\/status\/(\d+)/)?.[1] ?? null;
        if (isSeen && statusId && isSeen(statusId)) {
          seenRun += 1;
          if (seenRun >= SEEN_STOP_RUN) {
            reachedSeen = true;
            break;
          }
          continue;
        }
        seenRun = 0;
        scanned += 1;
        if (statusId) ids.push(statusId);
        if (!tweet.isArticle) continue;

        const titleKey = normalize(tweet.title ?? "");
        if (isKnown({ statusId, titleKey })) {
          known += 1;
        } else if (titleKey && titles.has(titleKey)) {
          duplicates += 1;
        } else if (limit == null || found.length < limit) {
          titles.add(titleKey);
          found.push({
            url: `https://x.com${tweet.href}`,
            status_id: statusId,
            title: tweet.title,
            author: tweet.author,
          });
        }
      }

      onProgress({ scanned, known, duplicates, found: [...found] });
      idle = added === 0 ? idle + 1 : 0;
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(SCROLL_PAUSE_MS);
    }

    return { scanned, known, duplicates, found, ids, reachedSeen, complete: idle >= MAX_IDLE_ROUNDS };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function readVisibleTweets() {
  return [...document.querySelectorAll('[data-testid="tweet"]')].map((tweet) => {
    const href = [...tweet.querySelectorAll('a[href*="/status/"]')]
      .find((link) => link.querySelector("time"))
      ?.getAttribute("href");
    const lines = tweet.innerText.split("\n").map((line) => line.trim());
    const articleIndex = lines.indexOf("Article");
    const isArticle = Boolean(tweet.querySelector('[data-testid="article-cover-image"]')) || articleIndex !== -1;
    const author = lines.find((line) => line.startsWith("@")) ?? null;
    return {
      href,
      isArticle,
      title: isArticle && articleIndex !== -1 ? lines[articleIndex + 1] ?? null : null,
      author,
    };
  });
}
