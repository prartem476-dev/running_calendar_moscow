import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const distDir = path.resolve('dist');
const outDir = path.resolve('rustore', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((resolve) => server.listen(4182, '127.0.0.1', resolve));
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const userDataDir = path.resolve('rustore', '.tmp-chrome-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=9236',
      `--user-data-dir=${userDataDir}`,
      'http://127.0.0.1:4182/',
    ],
    { stdio: 'ignore' }
  );

  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        const res = await fetch('http://127.0.0.1:9236/json');
        targets = await res.json();
        if (targets.length > 0) break;
      } catch {
        // retry
      }
    }

    const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    };

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    // 450 x 800 * 2.4 = 1080 x 1920 (exact 9:16 Full HD)
    await send('Emulation.setDeviceMetricsOverride', {
      width: 450,
      height: 800,
      deviceScaleFactor: 2.4,
      mobile: true,
    });

    await sleep(1500);

    const evalJs = (expression) =>
      send('Runtime.evaluate', { expression, awaitPromise: true });

    const capture = async (filename) => {
      await sleep(400);
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      const outPath = path.join(outDir, filename);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log(`Saved ${filename}`);
    };

    // 1. Hero & Spotlight countdown
    await evalJs(`window.scrollTo({ top: 0, behavior: 'instant' })`);
    await capture('01-hero-and-next-race.png');

    // 2. Filters & Main Race Cards
    await evalJs(`
      (() => {
        const el = document.querySelector('.controls-section');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      })()
    `);
    await capture('02-filters-and-calendar.png');

    // 3. Top Featured Races ("⭐ Главные старты")
    await evalJs(`
      (() => {
        const btn = document.querySelector('#surface-pills button[data-surface="featured"]');
        if (btn) btn.click();
        const el = document.querySelector('.controls-section');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      })()
    `);
    await capture('03-featured-major-races.png');

    // 4. Trail & Cross Country ("🌲 Трейл / Грунт")
    await evalJs(`
      (() => {
        const btn = document.querySelector('#surface-pills button[data-surface="Трейл / Грунт"]');
        if (btn) btn.click();
        const el = document.querySelector('#events-container');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      })()
    `);
    await capture('04-trails-and-cross-country.png');

    // 5. Golden Ring ("🏛️ Золотое кольцо (БЗК)")
    await evalJs(`
      (() => {
        const btn = document.querySelector('#surface-pills button[data-surface="golden_ring"]');
        if (btn) btn.click();
        const el = document.querySelector('#events-container');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      })()
    `);
    await capture('05-golden-ring-series.png');

    // 6. 5 verst / S95 Parkruns ("🌳 5 вёрст / S95 (90 парков)")
    await evalJs(`
      (() => {
        const btn = document.querySelector('#surface-pills button[data-surface="Парковый забег"]');
        if (btn) btn.click();
        const el = document.querySelector('#events-container');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      })()
    `);
    await capture('06-parkruns-5verst-s95.png');

    ws.close();
  } finally {
    chrome.kill();
    server.close();
    await sleep(400);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
