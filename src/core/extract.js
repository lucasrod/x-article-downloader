import { chromium } from "playwright";
import { createArticleDocument } from "./article-schema.js";
import { extractStatusId, slugify } from "./utils.js";

export async function extractArticle(url, timeout) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 2400 },
  });

  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      await page.waitForTimeout(5000 + attempt * 1500);

      try {
        await page.locator('[data-testid="twitter-article-title"]').first().waitFor({
          state: "visible",
          timeout: 12000,
        });
      } catch {
        // Seguimos: a veces el titulo queda en DOM sin pasar por visible.
      }

      const showMoreButtons = page.locator('div[data-contents="true"] [data-testid="tweet-text-show-more-link"]');
      const buttonCount = await showMoreButtons.count();
      for (let index = 0; index < buttonCount; index += 1) {
        try {
          await showMoreButtons.nth(index).click({ timeout: 1000 });
        } catch {
          // Si el boton no responde, seguimos con la version condensada.
        }
      }

      await page.waitForTimeout(1000);

      const article = await page.evaluate(() => {
        const rootArticle = document.querySelector('article[data-testid="tweet"]');
        const titleNode = rootArticle?.querySelector('[data-testid="twitter-article-title"]');
        const contentNode = rootArticle?.querySelector('div[data-contents="true"]');

        if (!rootArticle || !titleNode || !contentNode) {
          return null;
        }

        const authorName = rootArticle.querySelector('[data-testid="User-Name"] span')?.textContent?.trim() ?? null;
        const authorHandleMatch = rootArticle
          .querySelector('a[href*="/status/"]')
          ?.getAttribute("href")
          ?.match(/^\/([^/]+)\/status\/\d+/);
        const authorHandle = authorHandleMatch ? `@${authorHandleMatch[1]}` : null;
        const blocks = Array.from(contentNode.children).map((node) => parseBlock(node)).filter(Boolean);

        return {
          sourceUrl: window.location.href,
          title: titleNode.textContent?.trim() ?? "",
          authorName,
          authorHandle,
          blocks,
        };

        function parseBlock(node) {
          if (node.matches('section [data-testid="simpleTweet"]')) {
            return null;
          }

        if (node.tagName === "SECTION") {
          if (node.querySelector('[role="separator"]')) {
            return { type: "separator" };
          }

          const codeBlock = node.querySelector('[data-testid="markdown-code-block"] code');
          if (codeBlock) {
            const language = codeBlock.className.replace("language-", "").trim() || "";
            return {
              type: "code",
              language,
              text: codeBlock.innerText.replace(/\n$/, ""),
            };
          }

          const embeddedTweet = node.querySelector('[data-testid="simpleTweet"] article[data-testid="tweet"]');
          if (embeddedTweet) {
            return parseEmbeddedTweet(embeddedTweet);
          }

          const image = node.querySelector('[data-testid="tweetPhoto"] img');
          if (image) {
            return {
              type: "image",
              alt: image.getAttribute("alt") || "Image",
              src: image.getAttribute("src") || "",
            };
          }

          return null;
        }

        if (node.tagName === "UL" || node.tagName === "OL") {
          return {
            type: "list",
            ordered: node.tagName === "OL",
            items: Array.from(node.querySelectorAll(":scope > li"))
              .map((item) => serializeInline(item))
              .filter(Boolean),
          };
        }

        const header = node.querySelector("h1, h2, h3, h4, h5, h6");
        if (header) {
          return {
            type: "heading",
            level: Number(header.tagName.slice(1)),
            text: serializeInline(header),
          };
        }

        if (node.tagName === "BLOCKQUOTE") {
          return {
            type: "blockquote",
            text: serializeInline(node),
          };
        }

        const text = serializeInline(node);
        if (!text) {
          return null;
        }

        return {
          type: "paragraph",
          text,
        };
      }

      function parseEmbeddedTweet(tweet) {
        const userNameNode = tweet.querySelector('[data-testid="User-Name"] span');
        const statusLink = tweet.querySelector('a[href*="/status/"]');
        const statusHref = statusLink?.getAttribute("href") ?? "";
        const statusMatch = statusHref.match(/^\/([^/]+)\/status\/(\d+)/);
        const time = tweet.querySelector("time");
        const textNode = tweet.querySelector('[data-testid="tweetText"]');
        const imageNodes = Array.from(tweet.querySelectorAll('[data-testid="tweetPhoto"] img'));

        return {
          type: "embedded_post",
          url: statusLink?.href ?? null,
          id: statusMatch?.[2] ?? null,
          author: {
            name: userNameNode?.textContent?.trim() ?? null,
            handle: statusMatch?.[1] ? `@${statusMatch[1]}` : null,
          },
          date_text: time?.textContent?.trim() ?? null,
          date_iso: time?.getAttribute("datetime") ?? null,
          text: textNode?.innerText?.trim() ?? tweet.innerText.trim(),
          images: imageNodes.map((img) => ({
            alt: img.getAttribute("alt") || "Image",
            src: img.getAttribute("src") || "",
          })),
        };
      }

      function serializeInline(root) {
        const pieces = [];
        walk(root);
        return normalizeWhitespace(pieces.join(""));

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            pieces.push(node.textContent ?? "");
            return;
          }

          if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }

          if (node.matches('[data-testid="tweet-text-show-more-link"]')) {
            return;
          }

          if (node.tagName === "BR") {
            pieces.push("\n");
            return;
          }

          const tag = node.tagName;
          const children = Array.from(node.childNodes);

          if (tag === "A") {
            const href = node.getAttribute("href") ?? "";
            const text = normalizeWhitespace(node.textContent ?? "");
            let absolute = href.startsWith("http")
              ? href
              : href.startsWith("//")
                ? `https:${href}`
                : new URL(href, window.location.origin).href;

            absolute = absolute.replace(/^https:\/\/x\.com\/@([^/]+)/, "https://x.com/$1");

            if (!text) {
              pieces.push(absolute);
              return;
            }

            pieces.push(`[${text}](${absolute})`);
            return;
          }

          const markers = inlineMarkers(node);
          pieces.push(markers.open);
          children.forEach(walk);
          pieces.push(markers.close);
        }
      }

      function inlineMarkers(node) {
        const style = node.getAttribute("style") || "";
        const isCode = node.tagName === "CODE" || style.includes("monospace");
        const isBold = node.tagName === "STRONG" || style.includes("font-weight: bold");
        const isItalic = node.tagName === "EM" || style.includes("font-style: italic");
        const open = `${isCode ? "`" : ""}${isBold ? "**" : ""}${isItalic ? "*" : ""}`;
        const close = `${isItalic ? "*" : ""}${isBold ? "**" : ""}${isCode ? "`" : ""}`;
        return { open, close };
      }

      function normalizeWhitespace(text) {
        return String(text || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n[ \t]+/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
        }
      });

      if (article) {
        return createArticleDocument({
          sourceUrl: article.sourceUrl,
          statusId: extractStatusId(article.sourceUrl),
          authorHandle: article.authorHandle,
          authorName: article.authorName,
          fetchedAt: new Date().toISOString(),
          title: article.title,
          slug: slugify(article.title),
          blocks: article.blocks,
        });
      }
    }

    throw new Error("No pude encontrar un Article en esa URL. Usa la URL publica del status que contiene el articulo.");
  } finally {
    await browser.close();
  }
}
