// 运行一段 Agent 写的脚本。脚本里可以用：
//   $(selector)   查询，返回 Selection
//   doc           JsonDoc 实例
//   args          调用方传入的参数
// 脚本可以是 async。它在 doc 的 fork 上执行，结束后整体合并回 doc：要么全部生效，要么一个都不生效。

import { JsonDoc } from './doc.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function compileScript(source) {
  return new AsyncFunction('$', 'doc', 'args', `"use strict";\n${source}`);
}

/**
 * 在 fork 上运行脚本并合并。
 * @returns {Promise<{ result, patch, version, ops }>}
 */
export async function runScript(doc, source, { args, policy = 'throw', atomic = true } = {}) {
  const fn = typeof source === 'function' ? source : compileScript(source);
  if (!atomic) {
    const before = doc.version;
    const result = await fn(bindQuery(doc), doc, args);
    return { result, ops: doc.opsSince(before), version: doc.version };
  }
  const fork = doc.fork();
  const result = await fn(bindQuery(fork), fork, args);
  const ops = fork.opsSince(0);
  const m = doc.merge(fork, { policy });
  return { result, ops, version: m.version, conflicts: m.conflicts };
}

export function bindQuery(doc) {
  const $ = (target, scope) => doc.$(target, scope);
  $.doc = doc;
  return $;
}

export function toTransferable(v) {
  if (v === undefined) return undefined;
  try {
    structuredClone(v);
    return v;
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}
