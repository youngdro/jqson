// 在 Chromium 里跑 index.html 中的冒烟测试：npm run test:browser
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, url.pathname === '/' ? 'test/browser/index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const { port } = server.address();

const browser = await chromium.launch();
let failed = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.__results, null, { timeout: 30000 });
  const results = await page.evaluate(() => window.__results);
  for (const r of results) {
    console.log(`${r.ok ? 'ok    ' : 'FAIL  '} ${r.name}${r.ok ? '' : ' ' + JSON.stringify(r.detail ?? '')}`);
    if (!r.ok) failed++;
  }
  for (const e of errors) {
    console.log('pageerror', e);
    failed++;
  }
  console.log(`${results.length - failed}/${results.length} passed in Chromium`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
