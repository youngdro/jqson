import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import jqson, { exec, execSchema, ExecError, ValidationError } from '../src/index.js';

const sample = () => JSON.parse(fs.readFileSync(new URL('../examples/video-project.json', import.meta.url), 'utf8'));

test('exec：简写、do 链、值运算、读取结果、新建元素', () => {
  const doc = jqson(sample());
  const { results, patch } = doc.exec([
    { $: 'text[zone=caption-band]', expect: 4, css: { fontSize: { $mul: 1.1, $round: 0 } } },
    { $: '#point-1', do: [['text', { $prefix: '【', $suffix: '】' }], ['addClass', 'hl'], ['attr', 'start', { $add: 0.5 }]] },
    { $: { type: 'image', id: 'logo', src: 'logo.png' }, insertAfter: '#hero-shot' },
    { $: '#offer', append: [[{ type: 'text', id: 'a' }, { type: 'text', id: 'b' }]] },
    { $: '#selling', children: 'text', pluck: 'text' },
    { $: '#hook-title', attr: 'style.fontSize' },
    { $: 'segment', count: true },
    { $: '#price-tag', attr: { 'fields.price': { $replace: ['39', '29'] } } },
    { $: '#selling > image', remove: true },
  ]);
  assert.equal(doc.get('#point-1').text, '【0 糖 0 脂】');
  assert.equal(doc.get('#point-1').start, 3.8);
  assert.equal(doc.get('#point-1').style.fontSize, 53);
  assert.deepEqual(doc.$('#hook').children().pluck('id'), ['hero-shot', 'logo', 'hook-title']);
  assert.deepEqual(doc.$('#offer').children().pluck('id'), ['price-tag', 'cta-text', 'a', 'b']);
  assert.deepEqual(results[4].value, ['【0 糖 0 脂】', '冰镇口感更清爽']);
  assert.equal(results[5].value, 70);
  assert.equal(results[6].value, 3);
  assert.equal(doc.get('#price-tag').fields.price, '¥29');
  assert.equal(doc.$('#selling > image').length, 0);
  assert.ok(patch.length > 10);
  doc.undo(); // 整批是一个事务
  assert.deepEqual(doc.toJSON(), sample());
});

test('exec：任何一条失败整批回滚；expect 不符、未知方法、非数字运算都报错并指出第几条', () => {
  const doc = jqson(sample());
  const check = (cmds, re, index) => {
    assert.throws(() => doc.exec(cmds), (e) => e instanceof ExecError && re.test(e.message) && e.index === index);
    assert.deepEqual(doc.toJSON(), sample());
  };
  check([{ $: '#point-1', text: 'x' }, { $: 'text', expect: 2, remove: true }], /期望匹配 2/, 1);
  check([{ $: '#point-1', text: 'x' }, { $: 'text', each: 'x' }], /不支持的方法 "each"/, 1);
  check([{ $: '#point-1', attr: ['text', { $mul: 2 }] }], /不是数字/, 0);
  check([{ $: '#point-1', attr: ['x', { $eval: 'process.exit()' }] }], /未知的值运算/, 0);
  check([{ attr: ['x', 1] }], /缺少 "\$"/, 0);
  doc.use(({ doc }) => doc.$('text').filter((i, el) => el.text.length > 14).map((i, el) => ({ message: `${el.id} 太长` })));
  assert.throws(() => doc.exec({ $: '#point-1', text: '这是一段非常非常非常非常长的文案' }), ValidationError);
  assert.equal(doc.get('#point-1').text, '0 糖 0 脂');
});

test('exec：dryRun 只预览，不修改', () => {
  const doc = jqson(sample());
  const r = exec(doc, { $: '#hook', remove: true }, { dryRun: true });
  assert.equal(r.applied, false);
  assert.deepEqual(r.patch.map((p) => p.op), ['remove']);
  assert.equal(doc.$('#hook').length, 1);
});

test('exec：方法白名单和 schema 一致；指令里不能出现函数', () => {
  const enumList = execSchema.items.properties.do.items.prefixItems[0].enum;
  assert.ok(enumList.includes('attr') && enumList.includes('pluck') && !enumList.includes('each'));
  const doc = jqson(sample());
  assert.throws(() => doc.exec({ $: 'text', filter: [{}] }), /只接受选择器字符串/);
});

test('cli: exec / schema', () => {
  const bin = new URL('../bin/jqson.js', import.meta.url).pathname;
  const file = new URL('../examples/video-project.json', import.meta.url).pathname;
  const r = JSON.parse(execFileSync('node', [bin, 'exec', file, '--ops', '[{"$":"#point-1","text":"零糖"},{"$":"text","pluck":"text"}]']));
  assert.equal(r.ok, true);
  assert.equal(r.results[1].value[1], '零糖');
  const s = JSON.parse(execFileSync('node', [bin, 'schema']));
  assert.equal(s.type, 'array');
  try {
    execFileSync('node', [bin, 'exec', file, '--ops', '{"$":"text","expect":1,"remove":true}'], { encoding: 'utf8' });
    assert.fail('should exit 1');
  } catch (e) {
    const out = JSON.parse(e.stdout);
    assert.equal(e.status, 1);
    assert.deepEqual([out.ok, out.command, out.expected, out.actual], [false, 0, 1, 4]);
  }
});
