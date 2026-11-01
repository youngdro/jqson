#!/usr/bin/env node
// jqson 命令行：给 Agent 用的“一次脚本、原子提交”入口。
//
//   jqson help    [topic|api] [--json]
//   jqson skill   [--json]          输出随包附带的 Agent skill（SKILL.md）
//   jqson inspect <file.json> [--depth n] [--limit n]
//   jqson explain "<selector>" [file.json]
//   jqson query <file.json> <selector> [--pluck path] [--paths] [--count]
//   jqson run   <file.json> <script.js ...> [-e code] [--args json] [--lint lint.js]
//                 [--parallel] [--threads n] [--write | --out file] [--patch file]
//   jqson patch <file.json> <patch.json> [--write | --out file]
//
// 所有命令向 stdout 输出一行 JSON，便于 Agent 解析；失败时 ok 为 false，退出码 1。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { jqson, runScript, parallel, help, inspect, explain, ValidationError, ConflictError, SelectorError } from '../src/index.js';

const argv = process.argv.slice(2);
const cmd = argv.shift();

function flags(list) {
  const pos = [];
  const f = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-e') (f.e ||= []).push(list[++i]);
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = list[i + 1];
      if (['write', 'paths', 'count', 'parallel', 'pretty', 'json'].includes(k)) f[k] = true;
      else f[k] = next, i++;
    } else pos.push(a);
  }
  return { pos, f };
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, obj.pretty ? 2 : 0) + '\n');
  process.exit(code);
}

function fail(e) {
  const r = { ok: false, error: e.message, name: e.name };
  if (e instanceof ValidationError) r.errors = e.errors;
  if (e instanceof ConflictError) r.conflicts = e.conflicts;
  r.hint = e instanceof SelectorError
    ? `jqson explain "${e.selector}"；jqson help selectors`
    : e instanceof ValidationError
      ? '修改未生效。按 errors 调整后重试'
      : e instanceof ConflictError
        ? '与其他修改冲突，未生效。jqson help parallel'
        : 'jqson help 查看用法';
  out(r, 1);
}

function load(file) {
  return jqson(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function save(doc, file, f) {
  const target = f.write ? file : f.out;
  if (target) fs.writeFileSync(target, JSON.stringify(doc.root, null, 2) + '\n');
  return target || null;
}

async function loadValidators(doc, spec) {
  if (!spec) return;
  for (const p of spec.split(',')) {
    const mod = await import(pathToFileURL(path.resolve(p)).href);
    const v = mod.default ?? mod.validators;
    for (const fn of Array.isArray(v) ? v : [v]) doc.use(fn);
  }
}

const COMMANDS = ['help', 'skill', 'inspect', 'explain', 'query', 'run', 'patch'];

try {
  const { pos, f } = flags(argv);
  const t0 = performance.now();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const q = pos.join(' ');
    if (f.json) out(help.json(q));
    process.stdout.write(help(q));
    process.exit(0);
  } else if (cmd === 'skill') {
    const file = new URL('../skills/jqson/SKILL.md', import.meta.url);
    if (f.json) out({ ok: true, path: file.pathname });
    process.stdout.write(fs.readFileSync(file, 'utf8'));
    process.exit(0);
  } else if (cmd === 'inspect') {
    const [file] = pos;
    if (!file) throw new Error('用法: jqson inspect <file.json> [--depth n] [--limit n]');
    const r = inspect(load(file), { depth: f.depth ? Number(f.depth) : undefined, limit: f.limit ? Number(f.limit) : undefined });
    out({ ok: true, ...r, ms: +(performance.now() - t0).toFixed(2) });
  } else if (cmd === 'explain') {
    const [sel, file] = pos;
    if (!sel) throw new Error('用法: jqson explain "<selector>" [file.json]');
    const r = explain(sel);
    if (r.ok && file) {
      const s = load(file).$(sel);
      r.count = s.length;
      r.paths = s.paths().slice(0, 10);
    }
    out(r, r.ok ? 0 : 1);
  } else if (cmd === 'query') {
    const [file, sel] = pos;
    const doc = load(file);
    const s = doc.$(sel);
    const r = { ok: true, count: s.length };
    if (!f.count) {
      if (f.pluck) r.values = s.pluck(f.pluck);
      else if (f.paths) r.paths = s.paths();
      else r.nodes = s.json();
    }
    r.ms = +(performance.now() - t0).toFixed(2);
    out(r);
  } else if (cmd === 'run') {
    const [file, ...scripts] = pos;
    const sources = [...scripts.map((p) => fs.readFileSync(p, 'utf8')), ...(f.e || [])];
    if (!sources.length) throw new Error('run 需要至少一个脚本文件或 -e 代码');
    const doc = load(file);
    await loadValidators(doc, f.lint);
    const args = f.args ? JSON.parse(f.args) : undefined;
    const patch = [];
    doc.on((e) => patch.push(...e.patch));
    let results;
    let conflicts = [];
    if (f.parallel && sources.length > 1) {
      const reports = await parallel(doc, sources.map((script) => ({ script, args })), {
        policy: 'skip',
        threads: f.threads ? Number(f.threads) : undefined,
      });
      results = reports.map((r) => ({ ok: r.ok, applied: r.applied, result: r.result, error: r.error?.message, conflicts: r.conflicts }));
      conflicts = reports.flatMap((r) => r.conflicts || []);
    } else {
      // 多个脚本依次运行，整体原子：任何一个失败，全部不生效
      const fork = doc.fork();
      results = [];
      for (const src of sources) results.push({ ok: true, result: (await runScript(fork, src, { args })).result });
      doc.merge(fork);
    }
    if (f.patch) fs.writeFileSync(f.patch, JSON.stringify(patch, null, 2) + '\n');
    const saved = save(doc, file, f);
    out({ ok: true, version: doc.version, changes: patch.length, results, conflicts, saved, ms: +(performance.now() - t0).toFixed(2) });
  } else if (cmd === 'patch') {
    const [file, patchFile] = pos;
    const doc = load(file);
    doc.applyPatch(JSON.parse(fs.readFileSync(patchFile, 'utf8')));
    out({ ok: true, saved: save(doc, file, f), ms: +(performance.now() - t0).toFixed(2) });
  } else {
    const near = COMMANDS.filter((c) => c[0] === cmd[0] || c.includes(cmd));
    out({ ok: false, error: `未知命令 "${cmd}"`, commands: COMMANDS, ...(near.length ? { didYouMean: near } : {}), hint: 'jqson help' }, 1);
  }
} catch (e) {
  fail(e);
}
