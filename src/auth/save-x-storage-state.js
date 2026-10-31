#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://x.com/home";
const outputPath = path.resolve(process.argv[3] ?? "tmp/.auth/x-storage-state.json");
const profileDir = path.resolve(process.argv[4] ?? "tmp/.auth/x-profile");
const timeoutMs = Number(process.env.X_LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 1200 },
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  console.log("Inicia sesion en X en la ventana de Chromium.");
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
  await context.close();
}
