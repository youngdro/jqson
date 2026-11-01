// 把 jqson 的改动同步到外部的响应式数据（Vue reactive、MobX observable、Valtio proxy 等）。
//
// 推荐做法：jqson 持有自己的数据（默认 copy 模式），UI 使用的响应式对象只通过 JSON Patch 接收改动。
// 这样响应式系统只在事务提交后收到一批精确到字段的修改，不会看到事务中间状态，
// 也不会被 jqson 的内部元数据或读取开销干扰。

import { cloneJson } from './doc.js';

const unesc = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');

function locate(root, path) {
  const segs = path.split('/').slice(1).map(unesc);
  const key = segs.pop();
  let c = root;
  for (const s of segs) {
    c = c[Array.isArray(c) ? Number(s) : s];
    if (c === null || typeof c !== 'object') throw new Error(`Path not found: ${path}`);
  }
  return { c, key };
}

function read(root, path) {
  if (path === '') return root;
  const { c, key } = locate(root, path);
  return c[Array.isArray(c) ? Number(key) : key];
}

/** 把 JSON Patch（RFC 6902）原地应用到任意对象上，逐字段修改，适合代理对象。 */
export function applyPatchTo(target, patch) {
  for (const op of patch) {
    if (op.op === 'test') {
      if (JSON.stringify(read(target, op.path)) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`);
      continue;
    }
    if (op.op === 'move' || op.op === 'copy') {
      const v = cloneJson(read(target, op.from));
      if (op.op === 'move') applyPatchTo(target, [{ op: 'remove', path: op.from }]);
      applyPatchTo(target, [{ op: 'add', path: op.path, value: v }]);
      continue;
    }
    if (op.path === '') throw new Error('Cannot replace the root of the target');
    const { c, key } = locate(target, op.path);
    const value = cloneJson(op.value);
    if (Array.isArray(c)) {
      const i = key === '-' ? c.length : Number(key);
      if (op.op === 'add') c.splice(i, 0, value);
      else if (op.op === 'remove') c.splice(i, 1);
      else c[i] = value;
    } else if (op.op === 'remove') delete c[key];
    else c[key] = value;
  }
  return target;
}

/**
 * 每次提交后把改动应用到 target。返回取消函数。
 * batch：把一次提交包起来执行，例如 MobX 的 runInAction，避免严格模式警告并只触发一次反应。
 */
export function syncTo(doc, target, { batch } = {}) {
  return doc.on((e) => {
    const run = () => applyPatchTo(target, e.patch);
    if (batch) batch(run);
    else run();
  });
}
