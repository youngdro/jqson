import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jqson, { applyPatchTo } from '../src/index.js';

const sample = () => JSON.parse(fs.readFileSync(new URL('../examples/video-project.json', import.meta.url), 'utf8'));

// 一个最小的“响应式代理”：记录每次写入，写入完成后同步通知观察者。
// 数组的 splice 像 Vue / MobX 一样整体执行完再通知一次。
function observable(obj, log, onChange, copyOnWrite = false) {
  const cache = new WeakMap();
  const raws = new WeakMap(); // 代理 -> 原对象；像 Vue 的 toRaw 一样，存进数据的总是原对象
  // copyOnWrite 模拟 MobX：存进去的普通对象会被换成新的副本
  const toRaw = (v) => {
    const r = raws.get(v) ?? v;
    return copyOnWrite && r && typeof r === 'object' ? structuredClone(r) : r;
  };
  const wrap = (o) => {
    if (o === null || typeof o !== 'object') return o;
    if (cache.has(o)) return cache.get(o);
    const p = new Proxy(o, {
      get: (t, k) => {
        if (Array.isArray(t) && k === 'splice') {
          // 返回的方法直接操作原数组
          return (...args) => {
            const r = t.splice(...args.map(toRaw));
            log.push(['splice']);
            onChange?.();
            return r;
          };
        }
        return wrap(Reflect.get(t, k));
      },
      set: (t, k, v) => {
        Reflect.set(t, k, toRaw(v));
        log.push(['set', typeof k === 'symbol' ? 'symbol' : k]);
        onChange?.();
        return true;
      },
      deleteProperty: (t, k) => {
        Reflect.deleteProperty(t, k);
        log.push(['delete', k]);
        onChange?.();
        return true;
      },
    });
    cache.set(o, p);
    raws.set(p, o);
    return p;
  };
  return wrap(obj);
}

test('元数据不可枚举：展开、Object.assign 不会带走；展开出的副本不会被当成文档里的元素', () => {
  const doc = jqson(sample(), { mode: 'inplace' });
  const n = doc.get('#point-1');
  assert.equal(Object.getOwnPropertySymbols({ ...n }).length, 0);
  assert.deepEqual(Object.keys(n), ['type', 'id', 'class', 'text', 'zone', 'start', 'duration', 'style', 'motion']);
  const copyDoc = jqson(sample());
  const copy = { ...copyDoc.get('#point-1'), id: 'p1-copy' };
  const fresh = copyDoc.$(copy).appendTo('#offer'); // 展开得到的对象当作新 JSON 插入
  assert.equal(fresh.attr('id'), 'p1-copy');
  assert.equal(copyDoc.get('#point-1').id, 'point-1');
});

test('inplace 作用在代理上：建文档不产生任何写通知', () => {
  const log = [];
  const state = observable(sample(), log);
  jqson(state, { mode: 'inplace' });
  assert.deepEqual(log, []);
});

test('观察者在修改中途抛错，事务仍能完整回滚', () => {
  let armed = false;
  const log = [];
  const state = observable(sample(), log, () => {
    if (armed) throw new Error('observer failed');
  });
  const doc = jqson(state, { mode: 'inplace' });
  const before = JSON.stringify(doc.root);
  armed = true;
  assert.throws(() => doc.$('#point-1').appendTo('#offer'), /observer failed/);
  assert.throws(() => doc.$('#point-1').attr('id', 'p1'), /observer failed/);
  assert.throws(() => doc.$('#hook').remove(), /observer failed/);
  armed = false;
  assert.equal(JSON.stringify(doc.root), before);
  assert.equal(doc.$('#point-1').length, 1);
  assert.equal(doc.$('#p1').length, 0);
  doc.$('#point-1').appendTo('#offer'); // 回滚后文档依然可用
  assert.deepEqual(doc.$('#offer').children().pluck('id'), ['price-tag', 'cta-text', 'point-1']);
});

test('syncTo：只把提交后的精确改动推给响应式对象，且每次提交一批', () => {
  const log = [];
  const store = observable(sample(), log);
  const doc = jqson(sample());
  const batches = [];
  const stop = doc.syncTo(store, { batch: (fn) => { batches.push(log.length); fn(); } });
  doc.$('#point-1').text('零糖').css('fontSize', 50);
  assert.equal(store.children[1].children[1].text, '零糖');
  assert.equal(store.children[1].children[1].style.fontSize, 50);
  assert.deepEqual(log, [['set', 'text'], ['set', 'fontSize']]);
  doc.$('#cta-text').appendTo('#hook');
  assert.deepEqual(store.children[0].children.map((x) => x.id), ['hero-shot', 'hook-title', 'cta-text']);
  assert.equal(batches.length, 3);
  doc.undo();
  assert.equal(batches.length, 4);
  assert.deepEqual(store, doc.toJSON());
  stop();
  doc.$('#hook').attr('x', 1);
  assert.equal(store.children[0].x, undefined);
});

test('applyPatchTo 支持全部 RFC 6902 操作', () => {
  const t = { a: [1, 2], b: { c: 1 } };
  applyPatchTo(t, [
    { op: 'add', path: '/a/-', value: 3 },
    { op: 'replace', path: '/b/c', value: 2 },
    { op: 'copy', from: '/b', path: '/d' },
    { op: 'move', from: '/a/0', path: '/e' },
    { op: 'remove', path: '/b' },
    { op: 'test', path: '/d/c', value: 2 },
  ]);
  assert.deepEqual(t, { a: [2, 3], d: { c: 2 }, e: 1 });
});

test('像 MobX 那样赋值时替换对象：jqson 会改用实际存进去的对象', () => {
  const log = [];
  const raw = sample();
  const state = observable(raw, log, null, true);
  const batches = [];
  const doc = jqson(state, { mode: 'inplace', batch: (run) => { batches.push(1); return run(); } });
  const added = doc.$('#offer').insert({ type: 'text', id: 'n1', text: 'a' });
  added.attr('text', 'b').css('color', 'red');
  assert.equal(raw.children[2].children[2].text, 'b');
  assert.equal(raw.children[2].children[2].style.color, 'red');
  doc.$('#n1').appendTo('#hook');
  doc.$('#n1').attr('text', 'c');
  assert.equal(raw.children[0].children[2].text, 'c');
  assert.equal(batches.length, 5);
  doc.undo();
  assert.equal(raw.children[0].children[2].text, 'b');
});
