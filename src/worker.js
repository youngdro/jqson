// worker 入口，浏览器 Web Worker 和 Node worker_threads 共用。
// 每个 worker 缓存最近一份文档；每个任务在它上面直接运行，收集操作后撤销回原状，省去重复建文档。

import { JsonDoc } from './doc.js';
import { compileScript, bindQuery, toTransferable } from './script.js';

let cached = { key: null, doc: null };

async function handle(msg) {
  try {
    if (msg.data !== undefined) {
      cached = { key: msg.dataKey, doc: new JsonDoc(msg.data, { ...msg.options, mode: 'inplace', history: Infinity }) };
    }
    if (cached.key !== msg.dataKey) throw new Error('worker document cache miss');
    const doc = cached.doc;
    const v0 = doc.version;
    const log0 = doc._log.length;
    const undo0 = doc._undo.length;
    let result;
    let ops;
    try {
      result = await compileScript(msg.script)(bindQuery(doc), doc, msg.args);
      ops = doc.opsSince(v0);
    } finally {
      while (doc._undo.length > undo0) doc.undo();
      doc._log.length = log0;
      doc._redo.length = 0;
      doc.version = v0;
    }
    return { id: msg.id, ok: true, ops, result: toTransferable(result) };
  } catch (e) {
    return { id: msg.id, ok: false, error: { message: e?.message, stack: e?.stack, name: e?.name } };
  }
}

const isBrowserWorker = typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof process === 'undefined';

if (isBrowserWorker) {
  self.onmessage = async (e) => self.postMessage(await handle(e.data));
} else {
  const mod = 'node:worker_threads';
  const { parentPort } = await import(/* webpackIgnore: true */ /* @vite-ignore */ mod);
  parentPort.on('message', async (msg) => parentPort.postMessage(await handle(msg)));
}
