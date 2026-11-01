import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import jsonjq, { help, inspect, explain } from '../src/index.js';

const data = JSON.parse(fs.readFileSync(new URL('../examples/video-project.json', import.meta.url)));

test('help: overview, topics, api lookup, fuzzy suggestions', () => {
  assert.match(help(), /上手三步/);
  for (const t of help.topics()) assert.match(help(t), /^# /);
  assert.match(help('attr'), /s\.attr\(path\)/);
  assert.match(help('doc.merge'), /policy/);
  assert.equal(help.json('merge').entries.length, 2);
  assert.deepEqual(help.json('mrege').suggestions, ['merge']);
  assert.ok(help.api().every((a) => a.name && a.sig && a.desc));
});

test('help covers every public Selection and JsonDoc method', () => {
  const doc = jsonjq(data);
  const text = help.api().map((a) => a.sig).join('\n');
  const methods = (proto) => Object.getOwnPropertyNames(proto).filter((m) => !m.startsWith('_') && m !== 'constructor');
  const missing = [...methods(Object.getPrototypeOf(doc.$('text'))), ...methods(Object.getPrototypeOf(doc))]
    .filter((m) => !new RegExp(`(^|[^\\w$])${m.replace('$', '\\$')}\\(|\\.${m.replace('$', '\\$')}\\b`).test(text));
  assert.deepEqual(missing, []);
});

test('explain: describes selectors and locates syntax errors', () => {
  const r = explain('segment#hook > text[start>=2]:not(.x)');
  assert.ok(r.ok);
  assert.match(r.parts[0], /id 为 "hook".*直接子元素.*start 大于等于 2/);
  const bad = explain('text[start>');
  assert.equal(bad.ok, false);
  assert.equal(bad.position, 11);
  assert.ok(explain('[start>1]').hints.length > 0);
});

test('inspect: tags, fields, outline, working suggestions', () => {
  const doc = jsonjq(data);
  const r = doc.describe();
  assert.equal(r.elements, doc.size);
  assert.equal(r.tags.text.count, 4);
  assert.equal(r.tags.text.fields['style.fontSize'].types, 'number');
  assert.deepEqual(r.tags.segment.childKeys, ['children']);
  assert.ok(r.outline[0].startsWith('project#promo'));
  for (const s of r.suggestions) assert.ok(doc.$(s).length > 0, s);
  assert.equal(inspect(data).elements, r.elements); // 原始数据也可以
});

test('cli: help / inspect / explain', () => {
  const bin = new URL('../bin/jsonjq.js', import.meta.url).pathname;
  const file = new URL('../examples/video-project.json', import.meta.url).pathname;
  assert.match(execFileSync('node', [bin, 'help', 'run'], { encoding: 'utf8' }), /jsonjq run/);
  assert.equal(JSON.parse(execFileSync('node', [bin, 'inspect', file])).tags.image.count, 2);
  assert.equal(JSON.parse(execFileSync('node', [bin, 'explain', 'segment > text', file])).count, 4);
  assert.match(execFileSync('node', [bin, 'skill'], { encoding: 'utf8' }), /^---\nname: jsonjq\n/);
});

test('skill: every API and CLI command it mentions exists', () => {
  const md = fs.readFileSync(new URL('../skills/jsonjq/SKILL.md', import.meta.url), 'utf8');
  const names = new Set(help.api().map((a) => a.name.replace(/^cli:/, '')));
  const code = [...md.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]).join('\n');
  for (const [, cmd] of code.matchAll(/\bjsonjq (\w+)/g)) assert.ok(names.has(cmd), `jsonjq ${cmd}`);
  for (const m of ['attr', 'set', 'merge', 'removeAttr', 'addClass', 'append', 'insert', 'remove', 'appendTo', 'transaction', 'use', 'undo', 'parallel', 'runScript'])
    if (md.includes(m)) assert.ok(names.has(m), m);
});

test('help 里的 recipes 都能直接运行', async () => {
  const { runScript } = await import('../src/index.js');
  const doc = jsonjq(data);
  const body = help.json('recipes').body;
  await runScript(doc, body);
  assert.equal(doc.$('#g1').length, 0); // 编组后又解组
  assert.equal(doc.$('#selling-2').length, 1);
  assert.equal(doc.get('#cta-text').start, 8.6);
});

test("help('agent') 里的 exec 示例能直接执行", () => {
  const body = help.json('agent').body;
  const ops = JSON.parse(body.slice(body.indexOf("--ops '") + 7, body.indexOf("'", body.indexOf("--ops '") + 7)));
  const doc = jsonjq(data);
  const r = doc.exec(ops, { dryRun: true });
  assert.ok(r.patch.length > 0);
});
