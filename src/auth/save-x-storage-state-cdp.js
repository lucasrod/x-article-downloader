#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://x.com/home";
const outputPath = path.resolve(process.argv[3] ?? "tmp/.auth/x-storage-state.json");
const cdpEndpoint = process.env.X_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const timeoutMs = Number(process.env.X_LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);

await fs.mkdir(path.dirname(outputPath), { recursive: true });

const browser = await chromium.connectOverCDP(cdpEndpoint);

try {
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  console.log(`Conectado a Chrome via CDP en ${cdpEndpoint}.`);
  console.log("Inicia sesion en esa ventana de Chrome si X todavia no esta logueado.");
  console.log(`Guardare el storage en ${outputPath} cuando detecte auth_token.`);

  const deadline = Date.now() + timeoutMs;
  let saved = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies("https://x.com");
    if (cookies.some((cookie) => cookie.name === "auth_token")) {
      await context.storageState({ path: outputPath });
      console.log(`Storage guardado en ${outputPath}`);
      saved = true;
      break;
    }

    await page.waitForTimeout(2000);
  }

  if (!saved) {
    throw new Error("No detecte login en X antes del timeout.");
  }
} finally {
  await browser.close();
}
