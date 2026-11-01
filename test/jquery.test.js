import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jsonjq, { parallel } from '../src/index.js';

const sample = () => JSON.parse(fs.readFileSync(new URL('../examples/video-project.json', import.meta.url), 'utf8'));
const ids = (s) => s.pluck('id');

test('mode: copy 不动原数据，inplace 直接修改原对象', () => {
  const data = sample();
  jsonjq(data).$('#point-1').attr('text', 'x');
  assert.equal(data.children[1].children[1].text, '0 糖 0 脂');

  const live = sample();
  const doc = jsonjq(live, { mode: 'inplace' });
  doc.$('#point-1').attr('text', 'x');
  assert.equal(live.children[1].children[1].text, 'x');
  assert.equal(doc.root, live);
  assert.equal(jsonjq(sample(), { clone: false }).options.mode, 'inplace'); // 旧选项兼容
  assert.throws(() => jsonjq({}, { mode: 'nope' }), TypeError);
});

test('mode: immutable 结构共享快照', () => {
  const data = sample();
  const doc = jsonjq(data, { mode: 'immutable' });
  const s0 = doc.state;
  assert.equal(s0, data); // 初始快照就是输入本身

  let fromEvent;
  doc.on((e) => (fromEvent = e.state));
  doc.$('#point-1').attr('text', '零糖');
  const s1 = doc.state;
  assert.equal(fromEvent, s1);
  assert.notEqual(s1, s0);
  assert.equal(s0.children[1].children[1].text, '0 糖 0 脂'); // 旧快照不变
  assert.equal(s1.children[1].children[1].text, '零糖');
  assert.notEqual(s1.children[1], s0.children[1]); // 改动路径换新
  assert.equal(s1.children[0], s0.children[0]); // 其余共享
  assert.equal(s1.children[2], s0.children[2]);
  assert.equal(s1.children[1].children[0], s0.children[1].children[0]);
  assert.equal(doc.state, s1); // 无改动时引用不变

  doc.undo();
  const s2 = doc.state;
  assert.equal(s2.children[1].children[1].text, '0 糖 0 脂');
  assert.equal(s2.children[0], s0.children[0]);
  assert.equal(Object.getOwnPropertySymbols(s2).length, 0); // 快照是干净的 JSON

  const frozen = jsonjq(sample(), { mode: 'immutable', freeze: true });
  frozen.$('#hook').attr('x', 1);
  assert.ok(Object.isFrozen(frozen.state));
});

test('回调参数与 jQuery 一致：(index, value)，this 指向元素', () => {
  const doc = jsonjq(sample());
  const seen = [];
  doc.$('text').each(function (i, el) {
    seen.push([i, el.id, this === el]);
    if (i === 1) return false;
  });
  assert.deepEqual(seen, [[0, 'hook-title', true], [1, 'point-1', true]]);
  assert.deepEqual(doc.$('text').map((i, el) => (i % 2 ? null : el.id)), ['hook-title', 'point-2']);
  assert.deepEqual(doc.$('text').map((i, el) => [i, i]).get(), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual(ids(doc.$('text').filter((i) => i > 1)), ['point-2', 'cta-text']);
  doc.$('text').attr('start', function (i, old) {
    return this.id === 'hook-title' ? old + i + 10 : undefined;
  });
  assert.equal(doc.get('#hook-title').start, 10.2);
  doc.$('#hook-title').attr('motion', null); // null 删除字段，同 jQuery
  assert.equal('motion' in doc.get('#hook-title'), false);
});

test('遍历：nextAll / prevAll / *Until / parentsUntil / addBack / end / index / even / odd', () => {
  const doc = jsonjq(sample());
  assert.deepEqual(ids(doc.$('#detail-1').nextAll()), ['point-1', 'detail-2', 'point-2']);
  assert.deepEqual(ids(doc.$('#point-2').prevAll('image')), ['detail-2', 'detail-1']); // 由近到远
  assert.deepEqual(ids(doc.$('#detail-1').nextUntil('#point-2')), ['point-1', 'detail-2']);
  assert.deepEqual(ids(doc.$('#point-2').prevUntil('#detail-1')), ['detail-2', 'point-1']);
  assert.deepEqual(ids(doc.$('#point-1').parents()), ['selling', 'promo']); // 由近到远
  assert.deepEqual(ids(doc.$('#point-1').parentsUntil(':root')), ['selling']);
  assert.deepEqual(ids(doc.$('#selling').children('text').addBack()), ['selling', 'point-1', 'point-2']);
  assert.deepEqual(ids(doc.$('#selling').children().first().end()), ['detail-1', 'point-1', 'detail-2', 'point-2']);
  assert.equal(doc.$('#point-2').index(), 3);
  assert.equal(doc.$('#point-2').index('text'), 2);
  assert.equal(doc.$('text').index(doc.get('#cta-text')), 3);
  assert.deepEqual(ids(doc.$('text').even()), ['hook-title', 'point-2']);
  assert.deepEqual(ids(doc.$('text').odd()), ['point-1', 'cta-text']);
  assert.ok(doc.$('#selling').has(doc.get('#point-1')).length === 1);
  assert.deepEqual(ids(doc.$('#point-1').closest(doc.get('#selling'))), ['selling']);
});

test('css / text / class 函数形式 / removeClass()', () => {
  const doc = jsonjq(sample());
  const t = doc.$('#hook-title');
  assert.equal(t.css('font-size'), 64);
  t.css({ fontSize: 70, 'letter-spacing': 2 }).css('color', (i, c) => c.toUpperCase());
  assert.deepEqual(t.css(['fontSize', 'letterSpacing', 'color']), { fontSize: 70, letterSpacing: 2, color: '#FFFFFF' });
  t.css('letterSpacing', '');
  assert.equal('letterSpacing' in doc.get('#hook-title').style, false);
  assert.equal(doc.$('#selling').text(), '0 糖 0 脂冰镇口感更清爽');
  doc.$('#selling text').text((i, old) => `${i}:${old}`);
  assert.equal(doc.get('#point-2').text, '1:冰镇口感更清爽');
  doc.$('text').addClass((i, cur) => (i === 0 ? 'first' : ''));
  assert.ok(doc.$('#hook-title').hasClass('first'));
  doc.$('#hook-title').removeClass();
  assert.equal(doc.get('#hook-title').class, '');
  doc.$('#point-1').toggleClass('a', true).toggleClass('a', true);
  assert.equal(doc.get('#point-1').class, 'caption a');
});

test('插入已有元素是移动；多个目标时前面的是复制', () => {
  const doc = jsonjq(sample());
  doc.$('#offer').append(doc.$('#point-1'));
  assert.deepEqual(ids(doc.$('#offer').children()), ['price-tag', 'cta-text', 'point-1']);
  assert.equal(doc.$('#point-1').length, 1);
  doc.$('#point-1').insertBefore('#price-tag');
  assert.deepEqual(ids(doc.$('#offer').children()), ['point-1', 'price-tag', 'cta-text']);
  doc.$('#cta-text').prependTo('#offer');
  assert.deepEqual(ids(doc.$('#offer').children()), ['cta-text', 'point-1', 'price-tag']);
  doc.$('#cta-text').insertAfter('#price-tag');
  assert.deepEqual(ids(doc.$('#offer').children()), ['point-1', 'price-tag', 'cta-text']);
  doc.$('segment').append(doc.$('#cta-text'));
  assert.equal(doc.$('[id=cta-text]').length, 3);
  assert.equal(doc.$('#offer').children().last().attr('id'), 'cta-text');
  assert.throws(() => doc.$('#offer').appendTo(doc.$('#offer')), /into itself/);
  doc.undo();
  assert.equal(doc.$('[id=cta-text]').length, 1);
});

test('clone / $(json) 游离元素，可修改后插回', () => {
  const doc = jsonjq(sample());
  const copies = doc.$('#hook-title').clone().attr('id', 'hook-2').addClass('copy').appendTo('#offer');
  assert.deepEqual(ids(copies), ['hook-2']);
  assert.equal(copies.doc, doc);
  assert.equal(doc.get('#hook-title').class, 'caption big'); // 原件不变
  assert.ok(doc.$('#hook-2').hasClass('copy'));
  const fresh = doc.$({ type: 'image', id: 'logo' }).attr('src', 'logo.png').insertAfter('#hero-shot');
  assert.equal(fresh.attr('src'), 'logo.png');
  assert.equal(doc.$('#hero-shot').next().attr('id'), 'logo');
  assert.equal(doc.$('#nope').length, 0);
});

test('replaceWith / replaceAll / remove(selector) / wrap / wrapAll / wrapInner / unwrap', () => {
  const doc = jsonjq(sample());
  doc.$('#selling > *').remove('image');
  assert.deepEqual(ids(doc.$('#selling').children()), ['point-1', 'point-2']);

  doc.$('#point-1, #point-2').wrapAll({ type: 'group', id: 'g' });
  assert.deepEqual(ids(doc.$('#selling').children()), ['g']);
  assert.deepEqual(ids(doc.$('#g').children()), ['point-1', 'point-2']);
  doc.$('#point-1').unwrap();
  assert.deepEqual(ids(doc.$('#selling').children()), ['point-1', 'point-2']);

  doc.$('#point-1').wrap({ type: 'group', class: 'w' });
  assert.deepEqual(doc.$('#selling > group > text').pluck('id'), ['point-1']);
  doc.$('#offer').wrapInner({ type: 'group', id: 'inner' });
  assert.deepEqual(ids(doc.$('#inner').children()), ['price-tag', 'cta-text']);

  doc.$('#price-tag').replaceWith({ type: 'image', id: 'price-img' });
  assert.deepEqual(ids(doc.$('#inner').children()), ['price-img', 'cta-text']);
  doc.$({ type: 'text', id: 'new-cta' }).replaceAll('#cta-text');
  assert.deepEqual(ids(doc.$('#inner').children()), ['price-img', 'new-cta']);

  // 全部操作一路撤销回原样
  while (doc.undo());
  assert.deepEqual(doc.toJSON(), sample());
});

test('jsonjq.fn 插件扩展', () => {
  jsonjq.fn.shift = function (dt) {
    return this.attr('start', (i, v) => v + dt);
  };
  const doc = jsonjq(sample());
  doc.$('#offer > *').shift(1);
  assert.deepEqual(doc.$('#offer > *').pluck('start'), [8.4, 8.6]);
  delete jsonjq.fn.shift;
});

test('immutable 模式下并行合并后快照仍共享未改动部分', async () => {
  const doc = jsonjq(sample(), { mode: 'immutable' });
  const s0 = doc.state;
  await parallel(doc, [async (f) => f.$('#cta-text').attr('text', 'A'), { script: "$('#point-1').attr('text', 'B')" }]);
  const s1 = doc.state;
  assert.equal(s1.children[0], s0.children[0]);
  assert.equal(s1.children[2].children[1].text, 'A');
  assert.equal(s1.children[1].children[1].text, 'B');
});
