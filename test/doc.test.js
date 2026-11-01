import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jsondom, ValidationError, ConflictError, parallel, runScript, SelectorError } from '../src/index.js';

const sample = () => JSON.parse(fs.readFileSync(new URL('../examples/video-project.json', import.meta.url), 'utf8'));

test('选择器：类型、id、class、属性、组合符、伪类', () => {
  const doc = jsondom(sample());
  const ids = (s) => doc.$(s).pluck('id');
  assert.deepEqual(ids('segment'), ['hook', 'selling', 'offer']);
  assert.deepEqual(ids('#offer > *'), ['price-tag', 'cta-text']);
  assert.deepEqual(ids('.caption.big'), ['hook-title', 'cta-text']);
  assert.deepEqual(ids('text[start>=5]'), ['point-2', 'cta-text']);
  assert.deepEqual(ids('[style.color="#ffe14d"]'), ['cta-text']);
  assert.deepEqual(ids('[motion.preset^=slide]'), ['point-1', 'point-2']);
  assert.deepEqual(ids('[text*="糖"]'), ['point-1']);
  assert.deepEqual(ids('segment:first-child, segment:last-child'), ['hook', 'offer']);
  assert.deepEqual(ids('#selling > :nth-child(odd)'), ['detail-1', 'detail-2']);
  assert.deepEqual(ids('image + text'), ['point-1', 'point-2']);
  assert.deepEqual(ids('video ~ text'), ['hook-title']);
  assert.deepEqual(ids('segment:has(> lottie)'), ['offer']);
  assert.deepEqual(ids('text:not(.big)'), ['point-1', 'point-2']);
  assert.deepEqual(ids('segment .caption:is(.big)'), ['hook-title', 'cta-text']);
  assert.deepEqual(ids(':root'), ['promo']);
  assert.deepEqual(ids('[FIELDS.price="¥39" i]'.replace('FIELDS', 'fields')), ['price-tag']);
  assert.throws(() => doc.$('text[') , SelectorError);
});

test('element: "all" 时普通 JSON 也能用属性名当标签', () => {
  const doc = jsondom({ users: [{ name: 'a', tags: ['x'] }, { name: 'b', tags: ['y'] }] }, { element: 'all' });
  assert.deepEqual(doc.$('users[tags=y]').pluck('name'), ['b']);
  assert.deepEqual(doc.$(':key(users)').length, 2);
});

test('修改：attr / class / append / before / remove / replaceWith，索引同步更新', () => {
  const doc = jsondom(sample());
  doc.$('#point-1').attr({ text: '零糖零脂', 'style.fontSize': 52 }).addClass('hl');
  assert.equal(doc.get('.hl').text, '零糖零脂');
  assert.equal(doc.get('#point-1').style.fontSize, 52);

  doc.$('#point-1').attr('id', 'p1');
  assert.equal(doc.get('#point-1'), null);
  assert.equal(doc.get('#p1').text, '零糖零脂');

  doc.$('#detail-2').before({ type: 'image', id: 'detail-1b' });
  assert.deepEqual(doc.$('#selling').children().pluck('id'), ['detail-1', 'p1', 'detail-1b', 'detail-2', 'point-2']);

  const added = doc.$('#offer').insert([{ type: 'text', id: 'n1' }, { type: 'text', id: 'n2' }]);
  assert.deepEqual(added.pluck('id'), ['n1', 'n2']);

  doc.$('#offer text').remove();
  assert.deepEqual(doc.$('#offer').children().pluck('id'), ['price-tag']);
  assert.equal(doc.$('text').length, 3);

  doc.$('#price-tag').replaceWith({ type: 'image', id: 'price-img' });
  assert.equal(doc.$('lottie').length, 0);
  assert.equal(doc.$('#price-img').length, 1);
});

test('事务：出错整体回滚，校验器拦截非法修改', () => {
  const doc = jsondom(sample());
  const before = JSON.stringify(doc.root);
  assert.throws(() =>
    doc.transaction(() => {
      doc.$('text').attr('text', 'x');
      doc.$('#selling').remove();
      throw new Error('boom');
    }),
  );
  assert.equal(JSON.stringify(doc.root), before);
  assert.equal(doc.$('#selling').length, 1);

  doc.use(({ doc }) =>
    doc.$('text').map((n) => n).filter((n) => n.text.length > 10).map((n) => ({ message: `${n.id} 文案过长` })),
  );
  assert.throws(() => doc.$('#point-1').attr('text', '这是一段明显超过十个字的长文案'), ValidationError);
  assert.equal(doc.get('#point-1').text, '0 糖 0 脂');
});

test('撤销 / 重做 / JSON Patch 往返', () => {
  const doc = jsondom(sample());
  const other = jsondom(sample());
  const patches = [];
  doc.on((e) => patches.push(...e.patch));
  doc.$('.caption').attr('style.color', '#111');
  doc.$('#hook').remove();
  doc.$('#offer').append({ type: 'text', id: 'x' });
  other.applyPatch(patches);
  assert.deepEqual(other.toJSON(), doc.toJSON());

  const snap = doc.toJSON();
  doc.undo();
  doc.undo();
  assert.equal(doc.$('#hook').length, 1);
  doc.redo();
  doc.redo();
  assert.deepEqual(doc.toJSON(), snap);
});

test('watch：只在相关子树变化时回调', () => {
  const doc = jsondom(sample());
  const hits = [];
  doc.watch('segment', (sel) => hits.push(sel.pluck('id')));
  doc.$('#point-2').attr('text', 'y');
  doc.$('#cta-text').attr('text', 'z');
  assert.deepEqual(hits, [['selling'], ['offer']]);
});

test('fork / merge：按 id 锚点重放，不受兄弟下标变化影响', () => {
  const doc = jsondom(sample());
  const a = doc.fork();
  a.$('#point-2').attr('text', 'A 改的');
  // 主文档在同一数组前面插入元素，point-2 的下标变了
  doc.$('#selling').prepend({ type: 'image', id: 'front' });
  doc.merge(a);
  assert.equal(doc.get('#point-2').text, 'A 改的');
  assert.deepEqual(doc.$('#selling').children().pluck('id')[0], 'front');
});

test('fork / merge：同一字段冲突，追加与追加不冲突，删除子树与内部修改冲突', () => {
  const doc = jsondom(sample());
  const a = doc.fork();
  const b = doc.fork();
  a.$('#point-1').attr('text', 'A');
  b.$('#point-1').attr('text', 'B');
  doc.merge(a);
  assert.throws(() => doc.merge(b), ConflictError);
  assert.equal(doc.merge(b, { policy: 'skip' }).applied, false);

  const c = doc.fork();
  const d = doc.fork();
  c.$('#offer').append({ type: 'text', id: 'c1' });
  d.$('#offer').append({ type: 'text', id: 'd1' });
  doc.merge(c);
  doc.merge(d);
  assert.deepEqual(doc.$('#offer').children().pluck('id'), ['price-tag', 'cta-text', 'c1', 'd1']);

  const e = doc.fork();
  const f = doc.fork();
  e.$('#hook').remove();
  f.$('#hook-title').attr('text', 'F');
  doc.merge(e);
  assert.throws(() => doc.merge(f), ConflictError);
});

test('parallel：异步任务各自 fork，并发后合并', async () => {
  const doc = jsondom(sample());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reports = await parallel(doc, [
    async (f) => {
      await sleep(20);
      f.$('#hook .caption').attr('motion.preset', 'bounce');
    },
    async (f) => {
      await sleep(5);
      f.$('#selling .caption').attr('motion.preset', 'typewriter');
    },
    async (f) => {
      f.$('#offer').append({ type: 'text', id: 'extra' });
    },
  ]);
  assert.ok(reports.every((r) => r.ok && r.applied));
  assert.deepEqual(doc.$('.caption').pluck('motion.preset'), ['bounce', 'typewriter', 'typewriter', 'pulse']);
  assert.equal(doc.$('#extra').length, 1);
});

test('parallel：脚本任务在 worker 线程里运行', async () => {
  const doc = jsondom(sample());
  const reports = await parallel(
    doc,
    [
      { script: `$('#hook text').attr('style.fontSize', s => s + args.d); return $('text').length`, args: { d: 8 } },
      { script: `$('#selling text').attr('style.fontSize', s => s + args.d)`, args: { d: 4 } },
      { script: `$('#offer').append({ type: 'text', id: 'w' })` },
    ],
    { threads: 2 },
  );
  assert.ok(reports.every((r) => r.ok && r.applied), JSON.stringify(reports.map((r) => r.error?.message)));
  assert.equal(reports[0].result, 4);
  assert.deepEqual(doc.$('text').pluck('style.fontSize'), [72, 52, 52, 56, undefined]);
});

test('runScript：脚本整体原子提交', async () => {
  const doc = jsondom(sample());
  await assert.rejects(runScript(doc, `$('text').attr('text', 'x'); throw new Error('no')`));
  assert.equal(doc.get('#point-1').text, '0 糖 0 脂');
  const r = await runScript(doc, `$('text').attr('text', t => t + '!'); return $('text').length`);
  assert.equal(r.result, 4);
  assert.equal(doc.get('#point-1').text, '0 糖 0 脂!');
  assert.equal(doc.version, 1);
});
