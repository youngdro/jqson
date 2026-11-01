// 性能基准：node bench/bench.js [段数] [每段元素数]
import { jqson, parallel } from '../src/index.js';

const SEGMENTS = Number(process.argv[2] || 200);
const PER = Number(process.argv[3] || 500);

function make() {
  const presets = ['pop-in', 'slide-up', 'pulse', 'bounce'];
  return {
    type: 'project',
    id: 'p',
    children: Array.from({ length: SEGMENTS }, (_, s) => ({
      type: 'segment',
      id: `s${s}`,
      children: Array.from({ length: PER }, (_, i) => ({
        type: i % 3 === 0 ? 'image' : 'text',
        id: `s${s}-e${i}`,
        class: i % 5 === 0 ? 'caption big' : 'caption',
        start: s * 10 + i * 0.02,
        duration: 1,
        style: { color: '#fff', fontSize: 40 + (i % 20) },
        motion: { preset: presets[i % 4] },
      })),
    })),
  };
}

function time(label, fn, runs = 5) {
  fn();
  const t0 = performance.now();
  let r;
  for (let i = 0; i < runs; i++) r = fn();
  const ms = (performance.now() - t0) / runs;
  console.log(`${label.padEnd(46)} ${ms.toFixed(2).padStart(9)} ms`);
  return r;
}

const data = make();
let doc;
time('建文档（深拷贝 + 建索引）', () => (doc = jqson(data)), 3);
console.log(`元素数 ${doc.size.toLocaleString()}\n`);

time('#s150-e321（id 索引）', () => doc.$('#s150-e321').length);
time('.big（class 索引）', () => doc.$('.big').length);
time('text[style.fontSize>55]（全量扫描）', () => doc.$('text[style.fontSize>55]').length);
time('#s42 > .caption[motion.preset=pulse]', () => doc.$('#s42 > .caption[motion.preset=pulse]').length);
time('segment:has(> .big[start>1990])', () => doc.$('segment:has(> .big[start>1990])').length, 2);
time('原生 JS 遍历做同样的筛选（对照）', () => {
  let n = 0;
  for (const s of doc.root.children) for (const c of s.children) if (c.type === 'text' && c.style.fontSize > 55) n++;
  return n;
});
console.log('');

const big = doc.$('.big');
time(`批量改属性 ${big.length.toLocaleString()} 个（单事务）`, () => big.attr('style.color', (i, c) => (c === '#fff' ? '#000' : '#fff')), 3);
time('追加 1,000 个元素到一个段', () => doc.$('#s7').append(Array.from({ length: 1000 }, (_, i) => ({ type: 'text', id: `n${doc.version}-${i}` }))), 3);
time('撤销上一次', () => doc.undo(), 1);

const f = time('fork（深拷贝 + 建索引）', () => doc.fork(), 2);
f.$('#s3 .caption').attr('motion.preset', 'typewriter');
time('merge 一个改了 500 个元素的 fork', () => doc.merge(f, { policy: 'force' }), 1);

const tasks = Array.from({ length: 8 }, (_, k) => ({
  script: `const segs = $('segment').filter((i) => i % 8 === args.k);
for (const s of segs) $(s).find('text[style.fontSize>50]').attr('style.fontSize', (i, v) => v - 4);
return segs.length;`,
  args: { k },
}));
const t0 = performance.now();
const reports = await parallel(doc, tasks, { threads: 4 });
console.log(`${'8 个脚本任务 · 4 个 worker 线程（含传输与合并）'.padEnd(46)} ${(performance.now() - t0).toFixed(2).padStart(9)} ms  合并成功 ${reports.filter((r) => r.applied).length}/8`);
