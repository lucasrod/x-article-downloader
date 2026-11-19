#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { readAuthorAvatar } from "../core/extract.js";
import { DEFAULT_DOWNLOAD_ROOT } from "../core/output.js";

// Completa source.author_avatar en articulos descargados antes de que la
// extraccion lo guardara. Visita un status por autor via CDP.
const cdpEndpoint = process.env.X_BROWSER_CDP_ENDPOINT || "http://127.0.0.1:9222";
const root = path.resolve(process.argv[2] ?? DEFAULT_DOWNLOAD_ROOT);
const PAUSE_MS = 2500;

const byAuthor = new Map();
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(root, entry.name, "article.json");
  const document = JSON.parse(await fs.readFile(file, "utf8").catch(() => "null"));
  const handle = document?.source?.author_handle;
  if (!handle) continue;
  if (!byAuthor.has(handle)) byAuthor.set(handle, { avatar: null, files: [], statusUrl: document.source.status_url });
  const author = byAuthor.get(handle);
  author.files.push(file);
  author.avatar ??= document.source.author_avatar ?? null;
}

const pending = [...byAuthor.entries()].filter(([, author]) => !author.avatar);
console.log(`${byAuthor.size} autores, ${pending.length} sin avatar.`);

if (pending.length) {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const page = await (browser.contexts()[0] ?? await browser.newContext()).newPage();
  try {
    for (const [index, [handle, author]] of pending.entries()) {
      try {
        await page.goto(author.statusUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForSelector('article[data-testid="tweet"] [data-testid^="UserAvatar-Container"] img', { timeout: 20000 });
        author.avatar = await readAuthorAvatar(page, handle);
      } catch (error) {
        console.log(`  ${handle}: ${error.message.split("\n")[0]}`);
      }
      console.log(`[${index + 1}/${pending.length}] ${handle} ${author.avatar?.shape ?? "sin avatar"}`);
      await page.waitForTimeout(PAUSE_MS);
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Comparte el avatar entre todos los articulos del mismo autor.
let updated = 0;
for (const author of byAuthor.values()) {
  if (!author.avatar) continue;
  for (const file of author.files) {
    const document = JSON.parse(await fs.readFile(file, "utf8"));
    if (document.source.author_avatar?.url === author.avatar.url) continue;
    document.source.author_avatar = author.avatar;
    await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    updated += 1;
  }
}
console.log(`Listo: ${updated} articulos actualizados.`);
