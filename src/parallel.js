// 并行执行：浏览器用 Web Worker，Node 用 worker_threads，API 相同。
//
// 任务有两种：
//   - 函数 async (fork) => {...}：在当前线程运行，适合等待网络 I/O 的任务（比如并发调用模型）。
//   - { script, args }：脚本字符串，在 worker 里运行，适合吃 CPU 的批量改写。
// 每个任务都在自己的 fork 上修改，结束后按锚点合并回主文档，冲突按 policy 处理。

import { JsonDoc, ConflictError } from './doc.js';
import { runScript } from './script.js';

// 用变量而不是字面量，打包器就不会去解析 Node 专用模块
const NODE_WORKER_MODULE = 'node:worker_threads';
const WORKER_FILE = './worker.js';
const MODULE_URL = import.meta.url;
const WORKER_LOAD_HINT =
  'worker error: worker 线程加载或运行失败。用 Vite 开发服务器时，需在 vite.config 中设置 optimizeDeps: { exclude: [\'jqson\'] }，见 README“在打包器中使用”';
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

export function defaultThreads() {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) return navigator.hardwareConcurrency;
  return 4;
}

/**
 * 并行运行任务并合并结果。
 * @returns {Promise<Array<{index, ok, applied, conflicts, error, result}>>}
 */
export async function parallel(doc, tasks, { policy = 'throw', order = 'task', threads, pool } = {}) {
  const scripted = tasks.some((t) => typeof t !== 'function');
  let ownPool = null;
  if (scripted && !pool) ownPool = pool = await createPool({ size: threads });
  const baseVersion = doc.version;
  // inplace 模式下 root 可能是代理对象，无法跨线程传递，先导出纯 JSON
  const snapshot = scripted ? (order === 'finish' || doc.options.mode === 'inplace' ? doc.toJSON() : doc.root) : null;

  const run = (task, index) => {
    if (typeof task === 'function') {
      const fork = doc.fork();
      return Promise.resolve()
        .then(() => task(fork, index))
        .then((result) => ({ index, ok: true, ops: fork.opsSince(0), result }));
    }
    return pool
      .run({ data: snapshot, dataKey: `${doc.key}@${baseVersion}`, options: serializableOptions(doc.options), script: task.script, args: task.args })
      .then((r) => ({ index, ...r }));
  };

  const reports = new Array(tasks.length);
  const mergeOne = (r) => {
    if (!r.ok) {
      reports[r.index] = { index: r.index, ok: false, applied: false, conflicts: [], error: r.error };
      return;
    }
    try {
      const m = doc.merge({ ops: r.ops, baseVersion }, { policy });
      reports[r.index] = { index: r.index, ok: true, applied: m.applied, conflicts: m.conflicts, result: r.result };
    } catch (e) {
      reports[r.index] = { index: r.index, ok: false, applied: false, conflicts: e instanceof ConflictError ? e.conflicts : [], error: e };
      if (policy === 'throw') throw e;
    }
  };

  try {
    const pending = tasks.map((t, i) =>
      run(t, i).catch((error) => ({ index: i, ok: false, error })),
    );
    if (order === 'finish') {
      await Promise.all(pending.map((p) => p.then(mergeOne)));
    } else {
      const results = await Promise.all(pending);
      for (const r of results) mergeOne(r);
    }
  } finally {
    if (ownPool) ownPool.close();
  }
  return reports;
}

function serializableOptions(o) {
  if (typeof o.element === 'function') throw new Error('script tasks need options.element to be "auto" or "all"');
  const { batch, ...rest } = o;
  return { ...rest, mode: 'inplace', clone: false };
}

/** 创建 worker 池。worker 会缓存最近一次收到的文档快照，同一版本只传一次。 */
export async function createPool({ size } = {}) {
  size = Math.max(1, size || defaultThreads());
  let NodeWorker = null;
  if (isNode) NodeWorker = (await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WORKER_MODULE)).Worker;

  const workers = [];
  const idle = [];
  const queue = [];
  let seq = 0;

  for (let i = 0; i < size; i++) {
    // 浏览器分支必须写成 new Worker(new URL('./worker.js', import.meta.url), ...) 这一字面形式，
    // Vite / webpack 5 / Rollup 才能识别并把 worker 及其依赖单独打包
    const w = NodeWorker
      ? new NodeWorker(new URL(WORKER_FILE, MODULE_URL))
      : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const slot = { w, cachedKey: null, job: null };
    const onMessage = (msg) => {
      const job = slot.job;
      slot.job = null;
      idle.push(slot);
      pump();
      if (!job) return;
      if (msg.ok) job.resolve(msg);
      else {
        const err = new Error(msg.error?.message || 'worker task failed');
        err.stack = msg.error?.stack || err.stack;
        err.name = msg.error?.name || err.name;
        job.resolve({ ok: false, error: err });
      }
    };
    const onError = (e) => {
      const job = slot.job;
      slot.job = null;
      if (job) job.resolve({ ok: false, error: e instanceof Error ? e : new Error(e?.message || WORKER_LOAD_HINT) });
    };
    if (NodeWorker) {
      w.on('message', onMessage);
      w.on('error', onError);
    } else {
      w.onmessage = (e) => onMessage(e.data);
      w.onerror = onError;
    }
    workers.push(slot);
    idle.push(slot);
  }

  function pump() {
    while (idle.length && queue.length) {
      const slot = idle.pop();
      const job = queue.shift();
      slot.job = job;
      const msg = { id: ++seq, script: job.script, args: job.args, options: job.options, dataKey: job.dataKey };
      if (slot.cachedKey !== job.dataKey) {
        msg.data = job.data;
        slot.cachedKey = job.dataKey;
      }
      slot.w.postMessage(msg);
    }
  }

  return {
    size,
    run(job) {
      return new Promise((resolve) => {
        queue.push({ ...job, resolve });
        pump();
      });
    },
    close() {
      for (const s of workers) s.w.terminate();
    },
  };
}

export { runScript, JsonDoc };
