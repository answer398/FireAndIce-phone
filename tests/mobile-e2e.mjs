import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/+/, '').replace(/\//g, '\\');
const server = spawn(process.execPath, ['src/index.js'], { cwd: new URL('../server', import.meta.url), stdio: 'ignore', windowsHide: true });
const base = 'http://127.0.0.1:8080';

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(`${base}/healthz`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not start');
}

async function runDevice(browser, portraitViewport, landscapeViewport, label) {
  const hostContext = await browser.newContext({ viewport: portraitViewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const guestContext = await browser.newContext({ viewport: portraitViewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  await host.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await guest.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await host.getByRole('button', { name: '童话', exact: true }).click();
  await host.getByRole('button', { name: '创建房间', exact: true }).click();
  await host.locator('#lbp-room-code').waitFor({ state: 'visible', timeoutMs: 15000 });
  const code = await host.locator('#lbp-room-code').innerText();
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error(`${label}: invalid room code ${code}`);
  await guest.goto(`${base}/?room=${code}`, { waitUntil: 'domcontentloaded' });
  await guest.locator('#lbp-game-picked').waitFor({ state: 'visible', timeoutMs: 15000 });
  if (!(await guest.locator('#lbp-game-picked').innerText()).includes('童话')) throw new Error(`${label}: game selection not mirrored`);
  await host.locator('#lbp-ready').click();
  await guest.locator('#lbp-ready').click();
  await host.locator('#lbp-enter').click();
  await guest.locator('#lbp-enter').click();
  await host.waitForURL(`${base}/games/6-fairy-tales/?room=${code}`, { timeoutMs: 30000 });
  await guest.waitForURL(`${base}/games/6-fairy-tales/?room=${code}`, { timeoutMs: 30000 });
  await host.locator('#fb-rotate').waitFor({ state: 'visible', timeoutMs: 15000 });
  await guest.locator('#fb-rotate').waitFor({ state: 'visible', timeoutMs: 15000 });
  await host.setViewportSize(landscapeViewport);
  await guest.setViewportSize(landscapeViewport);
  await host.locator('#fb-rotate').waitFor({ state: 'hidden', timeoutMs: 5000 });
  await guest.locator('#fb-rotate').waitFor({ state: 'hidden', timeoutMs: 5000 });
  await host.locator('#container canvas').waitFor({ state: 'attached', timeoutMs: 30000 });
  await guest.locator('#container canvas').waitFor({ state: 'attached', timeoutMs: 30000 });
  const pads = guest.locator('.tc-btn');
  if (await pads.count() !== 3) throw new Error(`${label}: expected three local controls`);
  await Promise.all([pads.nth(0).click(), pads.nth(1).click(), pads.nth(2).click()]);
  await guestContext.setOffline(true);
  await guest.waitForTimeout(500);
  await guestContext.setOffline(false);
  await guest.waitForTimeout(1500);
  await hostContext.close();
  await guestContext.close();
  console.log(`ok ${label}: room ${code}, ready, game, multi-input, reconnect`);
}

await waitForServer();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? 'C:/Users/answer/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe' });
try {
  await runDevice(browser, { width: 390, height: 844 }, { width: 844, height: 390 }, 'iPhone class');
  await runDevice(browser, { width: 412, height: 915 }, { width: 915, height: 412 }, 'Android class');
} finally {
  await browser.close();
  server.kill();
}
