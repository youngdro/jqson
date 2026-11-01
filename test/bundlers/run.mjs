// 实测 jqson 的 worker 在 Vite（build 与 dev server）和 webpack 5 中能被正确打包并运行。
// 用法：npm run test:bundlers（需要网络安装 vite / webpack，以及 Playwright 的 Chromium）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqson-bundlers-'));
const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

const tgz = execSync(`npm pack --silent --pack-destination ${JSON.stringify(dir)}`, { cwd: repo }).toString().trim().split('\n').pop();
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'jqson-bundlers', private: true, type: 'module' }));
sh(`npm i --silent --no-audit --no-fund vite@5.4.11 webpack@5.97.1 webpack-cli@5.1.4 ./${tgz}`);
fs.mkdirSync(path.join(dir, 'src'));
fs.copyFileSync(path.join(here, 'app.js'), path.join(dir, 'src/main.js'));
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script type="module" src="/src/main.js"></script>');
fs.writeFileSync(
  path.join(dir, 'vite.config.js'),
  "export default { build: { outDir: 'dist-vite', target: 'es2022' }, worker: { format: 'es' }, optimizeDeps: { exclude: ['@jqson/jqson'] } };",
);
fs.writeFileSync(
  path.join(dir, 'webpack.config.cjs'),
  `module.exports = { mode: 'production', entry: './src/main.js', experiments: { topLevelAwait: true },
  output: { path: require('path').resolve(__dirname, 'dist-webpack'), filename: 'main.js' } };`,
);

sh('npx vite build --logLevel warn');
const webpackOut = sh('npx webpack --config webpack.config.cjs');
if (/WARNING|ERROR/.test(webpackOut)) throw new Error('webpack 有警告或错误：\n' + webpackOut);
fs.writeFileSync(path.join(dir, 'dist-webpack/index.html'), '<!doctype html><script src="main.js"></script>');

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();

function serve(root) {
  const types = { '.js': 'text/javascript', '.html': 'text/html' };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const file = path.join(root, p === '/' ? 'index.html' : p);
    if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

async function check(name, url) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__result, null, { timeout: 20000 });
  const r = await page.evaluate(() => window.__result);
  await page.close();
  const ok = JSON.stringify(r.applied) === '[true,true]' && JSON.stringify(r.starts) === '[11,12]' && r.mark === 'ok';
  console.log(`${ok ? 'ok    ' : 'FAIL  '} ${name}${ok ? '' : ' ' + JSON.stringify(r)}`);
  return ok;
}

let failed = 0;
try {
  for (const out of ['dist-vite', 'dist-webpack']) {
    const server = await serve(path.join(dir, out));
    if (!(await check(out.replace('dist-', '') + ' build', `http://127.0.0.1:${server.address().port}/`))) failed++;
    server.close();
  }
  const { createServer } = await import(pathToFileURL(path.join(dir, 'node_modules/vite/dist/node/index.js')).href);
  const vite = await createServer({ root: dir, logLevel: 'error', server: { port: 0 } });
  await vite.listen();
  if (!(await check('vite dev server', vite.resolvedUrls.local[0]))) failed++;
  await vite.close();
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failed) process.exit(1);
