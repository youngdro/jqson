// 内置文档与自查能力：让安装了 jqson 的 Agent 不看外部资料也能学会用法、看清数据结构。
//
//   help()                  总览
//   help('selectors')       某个主题
//   help('attr')            某个 API（支持模糊匹配，找不到时给出相近建议）
//   help.json(query)        同上，返回结构化数据
//   inspect(doc | data)     数据概况：标签、id、class、字段、结构、推荐选择器
//   explain(selector)       用中文解释选择器，语法错误时指出位置

import { parseSelector, SelectorError } from './selector.js';
import { JsonDoc } from './doc.js';

// ---------- API 清单 ----------
// on: module = 包导出, doc = JsonDoc 实例方法, $ = Selection 方法, cli = 命令行

const API = [
  // 包导出
  { name: 'jqson', on: 'module', sig: 'jqson(data, options?) → JsonDoc', desc: '创建文档。默认深拷贝 data 并建索引，原数据不变。options: typeKey/idKey/classKey/childrenKey 字段名，element: "auto"|"all"|fn，clone，history。', ex: "const doc = jqson(json, { element: 'auto' })" },
  { name: 'runScript', on: 'module', sig: 'runScript(doc, source, { args, policy }) → Promise<{ result, ops, version, conflicts }>', desc: '在 fork 上执行一段脚本，成功才整体合并。脚本内可用 $、doc、args，可 await。Agent 做多步修改的首选方式。', ex: "await runScript(doc, \"$('text').attr('text', args.t); return $('text').length\", { args: { t: 'Hi' } })" },
  { name: 'parallel', on: 'module', sig: 'parallel(doc, tasks, { policy, order, threads, pool }) → Promise<report[]>', desc: '并行执行任务后合并。函数任务 async (fork) => {} 在当前线程跑（适合等模型/网络）；{ script, args } 在 worker 线程跑（适合 CPU 密集）。report: { index, ok, applied, conflicts, error, result }。', ex: "await parallel(doc, [async (f) => f.$('#a').attr('x', 1), { script: \"$('image').attr('opacity', .9)\" }], { policy: 'skip' })" },
  { name: 'createPool', on: 'module', sig: 'createPool({ size }) → Promise<pool>', desc: '创建可复用的 worker 池，传给 parallel({ pool })。用完调用 pool.close()。浏览器用 Web Worker，Node 用 worker_threads。', ex: 'const pool = await createPool({ size: 4 })' },
  { name: 'help', on: 'module', sig: 'help(query?) → string；help.json(query?) → object', desc: '内置文档。query 可以是主题名（overview/model/selectors/query/mutation/transaction/parallel/script/inspect/cli/recipes）或 API 名。', ex: "console.log(help('attr'))" },
  { name: 'inspect', on: 'module', sig: 'inspect(docOrData, { depth, limit }) → object', desc: '数据概况：元素数、每个标签的数量和字段（类型、示例值）、id、class、结构大纲、推荐选择器。接手陌生 JSON 时先跑它。', ex: 'inspect(doc).tags' },
  { name: 'explain', on: 'module', sig: 'explain(selector) → { ok, selector, parts[] } | { ok:false, error, position }', desc: '用中文逐段解释选择器含义；语法错误时返回出错位置。', ex: "explain('segment#hook > text[start>=2]')" },
  { name: 'parseSelector', on: 'module', sig: 'parseSelector(source) → AST', desc: '解析选择器为结构化 AST（带缓存），一般不需要直接用。' },

  // JsonDoc
  { name: '$', on: 'doc', sig: 'doc.$(selector | node | nodes, scope?) → Selection', desc: '查询，返回 Selection（类似 jQuery 对象）。', ex: "doc.$('text[zone=price-band]')" },
  { name: 'get', on: 'doc', sig: 'doc.get(selector) → node | undefined', desc: '返回第一个匹配的原始节点。', ex: "doc.get('#hook-title').text" },
  { name: 'byId', on: 'doc', sig: 'doc.byId(id) → node | undefined', desc: '按 id 取节点，O(1)。' },
  { name: 'matches', on: 'doc', sig: 'doc.matches(node, selector) → boolean', desc: '判断节点是否匹配选择器。' },
  { name: 'size', on: 'doc', sig: 'doc.size → number', desc: '元素总数。' },
  { name: 'root', on: 'doc', sig: 'doc.root', desc: '当前文档根对象。只读，不要直接修改（会绕过索引和撤销），改动请用 Selection 方法。' },
  { name: 'toJSON', on: 'doc', sig: 'doc.toJSON() → object', desc: '导出干净的深拷贝。' },
  { name: 'pointer', on: 'doc', sig: 'doc.pointer(node) → string', desc: '节点的 JSON Pointer 路径，如 /segments/0/children/1。' },
  { name: 'parentOf', on: 'doc', sig: 'doc.parentOf(node) / childrenOf(node) / tagOf(node) / idOf(node) / classesOf(node)', desc: '节点关系与标识。' },
  { name: 'transaction', on: 'doc', sig: 'doc.transaction(fn, meta?) → { result, patch, version }', desc: '同步事务，fn 内所有修改一次提交；抛错或校验失败则全部回滚。可嵌套（并入外层）。', ex: "doc.transaction(() => { doc.$('#a').remove(); doc.$('#b').attr('x', 1) })" },
  { name: 'use', on: 'doc', sig: 'doc.use(({ doc, touched, patch, meta }) => errors[]) → unsubscribe', desc: '注册校验器。每次提交前运行，返回非空数组则回滚并抛 ValidationError（e.errors）。touched 为本次改动涉及的元素。' },
  { name: 'on', on: 'doc', sig: 'doc.on((e) => {}) → unsubscribe', desc: '监听每次提交，e: { patch, version, meta, touched }，patch 为 RFC 6902 JSON Patch。' },
  { name: 'watch', on: 'doc', sig: 'doc.watch(selector, (e) => {}) → unsubscribe', desc: '仅当匹配选择器的元素被改动时触发。' },
  { name: 'undo', on: 'doc', sig: 'doc.undo() / doc.redo() → boolean', desc: '以事务为单位撤销/重做。' },
  { name: 'applyPatch', on: 'doc', sig: 'doc.applyPatch(patch)', desc: '应用 JSON Patch（add/remove/replace/move/copy/test），整体为一个事务。' },
  { name: 'fork', on: 'doc', sig: 'doc.fork() → JsonDoc', desc: '创建独立副本，修改后用 doc.merge(fork) 合并回来。' },
  { name: 'merge', on: 'doc', sig: "doc.merge(fork | { ops, baseVersion }, { policy: 'throw'|'skip'|'force' }) → { applied, conflicts, version }", desc: '按“最近的唯一 id 祖先”锚点重放 fork 的修改，兄弟增删不会错位。冲突：同路径/前缀路径、修改已删除子树；同一数组双方追加不算冲突。' },
  { name: 'opsSince', on: 'doc', sig: 'doc.opsSince(version) → ops[]', desc: '某版本之后的内部操作（带锚点），用于自定义合并。' },
  { name: 'describe', on: 'doc', sig: 'doc.describe(options?) → object', desc: '等同 inspect(doc)。' },

  // Selection：读取与遍历
  { name: 'length', on: '$', sig: 's.length', desc: '匹配数量。' },
  { name: 'find', on: '$', sig: 's.find(selector)', desc: '在后代中查找；选择器可以 > + ~ 开头（相对当前元素）。', ex: "doc.$('#hook').find('> text')" },
  { name: 'children', on: '$', sig: 's.children(selector?)', desc: '直接子元素。' },
  { name: 'parent', on: '$', sig: 's.parent(selector?) / s.parents(selector?) / s.closest(selector)', desc: '向上查找。closest 包含自身。' },
  { name: 'siblings', on: '$', sig: 's.siblings(selector?) / s.next(selector?) / s.prev(selector?)', desc: '同级元素。' },
  { name: 'filter', on: '$', sig: 's.filter(selector | fn(node, i)) / s.not(...) / s.is(...) / s.has(selector)', desc: '筛选与判断。' },
  { name: 'eq', on: '$', sig: 's.eq(i) / s.first() / s.last() / s.slice(a, b) / s.add(target)', desc: '按结果集位置取子集，eq 支持负数。' },
  { name: 'pluck', on: '$', sig: 's.pluck(path) → any[]', desc: '取每个元素某字段（点路径）的值。', ex: "doc.$('text').pluck('style.fontSize')" },
  { name: 'json', on: '$', sig: 's.json() / s.toArray() / s.get(i) / s.paths()', desc: '取出深拷贝 / 原始节点数组 / 第 i 个节点 / JSON Pointer 路径。' },
  { name: 'each', on: '$', sig: 's.each(fn(node, i)) / s.map(fn(node, i))', desc: '遍历。在 each 里修改请用 doc.$(node).attr(...)，不要直接赋值。' },
  { name: 'hasClass', on: '$', sig: 's.hasClass(name) → boolean', desc: '是否有元素带该 class。' },

  // Selection：修改
  { name: 'attr', on: '$', sig: 's.attr(path) → value；s.attr(path, value | fn(old, node, i))；s.attr({ path: value })', desc: '读写字段，path 支持点路径；值为函数时按元素计算。一次调用是一个事务。', ex: "doc.$('text').attr('start', (v) => v + 0.5)" },
  { name: 'set', on: '$', sig: 's.set(path, value)', desc: '同 attr 写入，但值为函数时原样存入。' },
  { name: 'merge', on: '$', sig: 's.merge(obj, path?)', desc: '把 obj 浅合并到每个元素（或其某个子对象）。', ex: "doc.$('text').merge({ color: '#fff' }, 'style')" },
  { name: 'removeAttr', on: '$', sig: 's.removeAttr(path)', desc: '删除字段。' },
  { name: 'addClass', on: '$', sig: 's.addClass(names) / s.removeClass(names) / s.toggleClass(names, force?)', desc: 'class 操作，names 空格分隔。' },
  { name: 'append', on: '$', sig: 's.append(value | value[], key?) / s.prepend(...)', desc: '向每个元素加子元素。默认放进 children（或已有的子元素数组），key 指定字段名。返回原 Selection。', ex: "doc.$('#selling').append({ type: 'image', id: 'd3', src: 'c.png' })" },
  { name: 'insert', on: '$', sig: 's.insert(value, key?) → Selection', desc: '同 append，但返回新插入的元素，便于继续链式修改。' },
  { name: 'before', on: '$', sig: 's.before(value) / s.after(value)', desc: '在元素前/后插入兄弟（元素需位于数组中）。' },
  { name: 'remove', on: '$', sig: 's.remove()', desc: '删除元素（连同子树）。' },
  { name: 'replaceWith', on: '$', sig: 's.replaceWith(value)', desc: '替换元素。' },
  { name: 'empty', on: '$', sig: 's.empty()', desc: '删除所有子元素。' },
  { name: 'appendTo', on: '$', sig: 's.appendTo(target, key?)', desc: '把元素移动到 target 下。' },

  // 命令行
  { name: 'cli:help', on: 'cli', sig: 'jqson help [topic|api] [--json]', desc: '查看内置文档。' },
  { name: 'cli:inspect', on: 'cli', sig: 'jqson inspect <file.json> [--depth n] [--limit n]', desc: '输出数据概况 JSON。' },
  { name: 'cli:explain', on: 'cli', sig: 'jqson explain "<selector>" [file.json]', desc: '解释选择器；给了文件时附带匹配数和前几个路径。' },
  { name: 'cli:query', on: 'cli', sig: 'jqson query <file.json> "<selector>" [--pluck path | --paths | --count]', desc: '查询，输出一行 JSON。' },
  { name: 'cli:run', on: 'cli', sig: 'jqson run <file.json> [script.js ...] [-e code ...] [--args json] [--lint a.js,b.js] [--parallel] [--threads n] [--write | --out file] [--patch file]', desc: '执行脚本并原子提交。不加 --write/--out 不写文件，可先试跑。--lint 模块默认导出校验函数或数组。' },
  { name: 'cli:patch', on: 'cli', sig: 'jqson patch <file.json> <patch.json> [--write | --out file]', desc: '应用 JSON Patch。' },
];

// ---------- 主题 ----------

const TOPICS = {
  overview: {
    title: 'jqson：jQuery for JSON',
    body: `用 CSS 选择器查找 JSON 中的元素，用 jQuery 式方法修改；所有修改自动维护索引，可事务回滚、校验、撤销，并输出 JSON Patch。支持 fork/merge 与 worker 并行。浏览器和 Node 通用，零依赖。

上手三步：
  1. 看数据      inspect(doc)              或 jqson inspect file.json
  2. 试选择器    explain(sel); doc.$(sel)  或 jqson explain "<sel>" file.json
  3. 改          runScript(doc, code)      或 jqson run file.json -e "<code>"

  import jqson, { runScript, parallel, help, inspect, explain } from 'jqson';
  const doc = jqson(data);
  doc.$('segment#offer text').attr('text', '立即抢购').addClass('pulse');
  doc.undo();

更多主题：${'TOPICS'}
查 API：help('attr')、help('merge')；命令行 jqson help attr`,
  },
  model: {
    title: '数据模型：JSON 如何变成元素树',
    body: `- 元素：带 type 或 id 字段的对象（element: 'auto'，默认）。element: 'all' 时所有对象都是元素；也可传函数 (obj, key, parent) => boolean。根节点总是元素。
- 标签（选择器里的 text、segment）：元素的 type 字段；没有 type 时用它所在的属性名，例如 zones.hero 的标签是 hero。根的默认标签是 root。
- 子元素：元素之下任意深度的对象/数组中遇到的下一层元素，中间的普通对象和数组被“穿透”。所以 children、tracks.main[] 都能当子元素。
- id、class：id 字段；class 字段（空格分隔字符串或字符串数组）。
- 字段名可改：jqson(data, { typeKey: 'kind', idKey: 'uid', classKey: 'tags', childrenKey: 'items' })。
- 普通（非元素）对象不能被选择器选中，但可通过点路径读写：[style.fontSize>40]、attr('style.color', ...)。`,
  },
  selectors: {
    title: '选择器语法',
    body: `基础      text  #hook  .big  *
属性      [zone] [zone=hero] [zone!=hero] [src^=http] [src$=.png] [text*=糖] [class~=a] [lang|=zh]
数值      [start>=2] [duration<1.5] [style.fontSize>40]     （值为数字时按数字比较）
点路径    [style.color=#fff] [motion.preset=pulse]
忽略大小写 [name=abc i]；值含空格或特殊字符时加引号 [text="立即 抢购"]
组合      a b（后代）  a > b（子）  a + b（紧邻弟）  a ~ b（后续弟）  a, b（并集）
位置      :first-child :last-child :only-child :nth-child(2n+1) :nth-child(odd) :nth-last-child(1)
          :first / :last 等同 :first-child / :last-child（结果集的首尾请用 .first() / .last()）
结构      :root  :empty（无子元素）  :key(hero)（所在属性名为 hero）
逻辑      :not(sel)  :is(sel)  :where(sel)  :has(sel)  :has(> text)
性能      以 #id 开头最快（直接走 id 索引）；.class 和标签走索引；纯属性条件需要扫描。
调试      explain('segment#hook > text[start>=2]')`,
  },
  query: {
    title: '查询与遍历',
    body: `doc.$(sel) 返回 Selection；doc.get(sel) 返回第一个原始节点；doc.byId(id)。
遍历: find children parent parents closest siblings next prev filter not is has eq first last slice add
读取: length pluck(path) json() toArray() get(i) paths() attr(path) hasClass(c) each map

  doc.$('#hook').find('> text').pluck('text')
  doc.$('text').filter((n) => n.text.length > 10).paths()
  doc.$('image').closest('segment').pluck('id')`,
  },
  mutation: {
    title: '修改',
    body: `每个修改方法本身是一个事务，自动维护索引、记录撤销、产生 JSON Patch。不要直接给 doc.root 下的对象赋值。

  s.attr('style.fontSize', 48)                 写字段（点路径）
  s.attr('start', (old, node, i) => old + 0.5)  按元素计算
  s.attr({ zone: 'hero', duration: 2 })          一次写多个
  s.merge({ color: '#fff' }, 'style')            合并到子对象
  s.removeAttr('motion')
  s.addClass('pulse big') / removeClass / toggleClass
  s.append(child, key?) / prepend / before / after
  s.insert(child) → 新元素的 Selection
  s.remove() / replaceWith(v) / empty() / appendTo(target)`,
  },
  transaction: {
    title: '事务、校验、撤销、监听',
    body: `doc.transaction(() => { ... }, meta?)  多步修改一次提交，抛错全部回滚 → { result, patch, version }
doc.use(({ doc, touched, patch }) => errors[])   校验器，返回非空数组 → 回滚并抛 ValidationError（e.errors）
doc.undo() / doc.redo()                          以事务为单位
doc.on((e) => e.patch)                           每次提交的 RFC 6902 patch
doc.watch('text[zone=price-band]', (e) => {})    只在匹配元素被改动时触发
doc.applyPatch(patch)                            回放 patch

校验器示例见包内 examples/video-lint.js。`,
  },
  parallel: {
    title: '并行：fork / merge / parallel',
    body: `const f = doc.fork(); f.$('#a').attr('x', 1); doc.merge(f, { policy: 'throw' | 'skip' | 'force' })

await parallel(doc, [
  async (fork) => fork.$('#hook-title').attr('text', await callModel()),   // 当前线程，适合 I/O
  { script: "$('image').attr('opacity', args.o)", args: { o: 0.9 } },     // worker 线程，适合 CPU
], { policy: 'skip', order: 'task' | 'finish', threads: 4, pool })

- 合并按“最近的唯一 id 祖先”锚定，主文档里兄弟元素的增删不会让修改错位。
- 冲突：同一路径或前缀路径（改 style vs 改 style.color）；修改了对方删除的子树。双方向同一数组追加不算冲突。
- 让并行任务各改不同 id 的子树可避免冲突。
- worker 需要复制数据，大文档上主要开销在这里；等模型返回只用函数任务即可。
- 反复调用请传 pool: await createPool({ size })，用完 pool.close()。
- 脚本任务时 options.element 不能是函数。`,
  },
  script: {
    title: '脚本：给 Agent 的一次性原子修改',
    body: `await runScript(doc, source, { args })
- 脚本内可用 $（等同 doc.$）、doc、args，可以 await，可以 return 结果。
- 在 fork 上执行，全部成功才合并；任何抛错、校验失败都不会留下修改。
- 一段脚本完成多步修改，比一次次调用工具快得多。

  await runScript(doc, \`
    const t = $('segment#offer text');
    t.attr('text', args.cta).addClass('pulse');
    return t.length;
  \`, { args: { cta: '立即抢购' } });`,
  },
  inspect: {
    title: '自查：inspect 与 explain',
    body: `inspect(doc | data, { depth = 3, limit = 20 })
  → { elements, tags: { tag: { count, ids, classes, fields: { name: { types, sample } } } }, ids, classes, outline, suggestions }
  接手陌生 JSON 时先跑，确定有哪些标签、字段和可用选择器。doc.describe() 同义。

explain(selector)
  → { ok, selector, parts: [...] }，逐段解释；语法错误时 { ok: false, error, position }。

命令行：jqson inspect file.json；jqson explain "<sel>" file.json（附匹配数与路径）`,
  },
  cli: {
    title: '命令行',
    body: `jqson help [topic|api] [--json]
jqson inspect <file.json> [--depth n] [--limit n]
jqson explain "<selector>" [file.json]
jqson query   <file.json> "<selector>" [--pluck path | --paths | --count]
jqson run     <file.json> [script.js ...] [-e code ...] [--args json] [--lint a.js,b.js]
                [--parallel] [--threads n] [--write | --out file] [--patch file]
jqson patch   <file.json> <patch.json> [--write | --out file]

- 除 help 外都输出一行 JSON；失败 ok:false、退出码 1，附 errors（校验）或 conflicts（冲突）。
- run 不加 --write/--out 不会写文件，可以先试跑看 changes。
- shell 中 -e 代码建议用单引号包裹，避免 $ 被展开：-e '$("video").attr("muted", true)'`,
  },
  recipes: {
    title: '常用写法',
    body: `// 所有价格区文字放大 10%
$('text[zone=price-band]').attr('style.fontSize', (v) => Math.round(v * 1.1));
// 某段之后的元素整体后移 1 秒
$('#offer').siblings().filter((n) => n.start >= 6).attr('start', (v) => v + 1);
// 给每段第一个文字加入场动画
$('segment > text:first-child').attr('motion', { preset: 'fade-up', duration: 0.4 });
// 删除没有 src 的图片
$('image:not([src])').remove();
// 把元素移动到另一段
$('#detail-2').appendTo('#offer');
// 找出超长文案
$('text').filter((n) => n.text.length > 14).pluck('id');
// 复制一段（新 id）
$('#selling').after({ ...$('#selling').json()[0], id: 'selling-2' });`,
  },
};
TOPICS.overview.body = TOPICS.overview.body.replace('TOPICS', Object.keys(TOPICS).join(' / '));

// ---------- help ----------

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/^(doc\.|\$\.|s\.|selection\.|\.)/, '').replace(/\(\)$/, '');
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const ON_LABEL = { module: '包导出', doc: 'JsonDoc', $: 'Selection', cli: '命令行' };

function lookup(query) {
  const q = norm(query);
  if (!q) return { kind: 'topic', topic: 'overview', ...TOPICS.overview };
  if (TOPICS[q]) return { kind: 'topic', topic: q, ...TOPICS[q] };
  const cliQ = q.startsWith('cli:') ? q : null;
  let hits = API.filter((a) => a.name.toLowerCase() === (cliQ || q) || a.name.toLowerCase() === 'cli:' + q);
  if (!hits.length) hits = API.filter((a) => a.sig.toLowerCase().includes(q));
  if (hits.length) return { kind: 'api', query, entries: hits.map(({ name, on, sig, desc, ex }) => ({ name, on: ON_LABEL[on], sig, desc, example: ex })) };
  const names = [...Object.keys(TOPICS), ...API.map((a) => a.name)];
  const suggestions = names
    .map((n) => [n, lev(q, n.toLowerCase())])
    .filter(([, d]) => d <= Math.max(2, q.length / 3))
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5)
    .map(([n]) => n)
    .filter((n, i, a) => a.indexOf(n) === i);
  return { kind: 'unknown', query, suggestions, topics: Object.keys(TOPICS) };
}

function listApi() {
  const groups = {};
  for (const a of API) (groups[ON_LABEL[a.on]] ||= []).push(a.name.replace(/^cli:/, ''));
  return groups;
}

export function help(query) {
  const r = lookup(query);
  if (r.kind === 'topic') {
    let s = `# ${r.title}\n\n${r.body}\n`;
    if (r.topic === 'overview') {
      s += '\nAPI 一览：\n';
      for (const [g, names] of Object.entries(listApi())) s += `  ${g}: ${names.join(' ')}\n`;
    }
    return s;
  }
  if (r.kind === 'api')
    return r.entries
      .map((e) => `[${e.on}] ${e.sig}\n  ${e.desc}${e.example ? `\n  例: ${e.example}` : ''}`)
      .join('\n\n') + '\n';
  return `没有找到 "${query}"。${r.suggestions.length ? `你是不是要找: ${r.suggestions.join(', ')}？` : ''}\n主题: ${r.topics.join(' / ')}\n用 help() 查看总览。\n`;
}

help.json = (query) => {
  const r = lookup(query);
  if (r.kind === 'topic' && r.topic === 'overview') return { ...r, topics: Object.keys(TOPICS), api: listApi() };
  return r;
};
help.topics = () => Object.keys(TOPICS);
help.api = () => API.map(({ name, on, sig, desc, ex }) => ({ name, on: ON_LABEL[on], sig, desc, example: ex }));

// ---------- explain ----------

const COMB = { ' ': '后代', '>': '直接子元素', '+': '紧随其后的兄弟', '~': '之后的兄弟' };
const OPS = { '=': '等于', '!=': '不等于', '^=': '以…开头', '$=': '以…结尾', '*=': '包含', '~=': '的空格分隔词包含', '|=': '等于或以…-开头', '>': '大于', '>=': '大于等于', '<': '小于', '<=': '小于等于' };

function describeCompound(c) {
  const bits = [];
  bits.push(c.tag && c.tag !== '*' ? `标签为 ${c.tag} 的元素` : '任意元素');
  for (const id of c.ids) bits.push(`id 为 "${id}"`);
  for (const cl of c.classes) bits.push(`带 class "${cl}"`);
  for (const a of c.attrs) {
    if (!a.op) bits.push(`有字段 ${a.name}`);
    else {
      const op = OPS[a.op] || a.op;
      const v = JSON.stringify(a.value);
      bits.push(op.includes('…') ? `字段 ${a.name} ${op.replace('…', v)}` : `字段 ${a.name} ${op} ${v}`);
    }
    if (a.insensitive) bits[bits.length - 1] += '（忽略大小写）';
  }
  for (const p of c.pseudos) bits.push(describePseudo(p));
  return bits.join('，');
}

function describeList(list) {
  return list.map((cx) => describeComplex(cx)).join('；或 ');
}

function describeComplex(cx) {
  let s = '';
  cx.forEach((step, i) => {
    if (i === 0) s = (step.comb ? `（相对当前元素的${COMB[step.comb]}）` : '') + describeCompound(step.compound);
    else s += ` → 在其${COMB[step.comb]}中找 ${describeCompound(step.compound)}`;
  });
  return s;
}

function describePseudo({ name, arg }) {
  switch (name) {
    case 'first':
    case 'first-child': return '是父元素下第一个子元素';
    case 'last':
    case 'last-child': return '是父元素下最后一个子元素';
    case 'only-child': return '是父元素唯一的子元素';
    case 'nth-child': return `在兄弟中位置满足 ${arg.a}n+${arg.b}（从 1 计）`;
    case 'nth-last-child': return `倒数位置满足 ${arg.a}n+${arg.b}`;
    case 'root': return '是根节点';
    case 'empty': return '没有子元素';
    case 'key': return `位于属性 "${arg}" 下`;
    case 'not': return `不是 [${describeList(arg)}]`;
    case 'is':
    case 'where': return `是 [${describeList(arg)}] 之一`;
    case 'has': return `包含 [${describeList(arg)}]`;
    default: return `:${name}`;
  }
}

export function explain(selector) {
  try {
    const list = parseSelector(selector);
    const parts = list.map((cx) => describeComplex(cx));
    const hints = [];
    if (list.some((cx) => !cx[0].compound.ids.length && cx.every((s) => !s.compound.ids.length && !s.compound.classes.length && (!s.compound.tag || s.compound.tag === '*'))))
      hints.push('没有 id/class/标签条件，需要扫描全部元素；数据很大时可加上标签或 #id 起点。');
    return { ok: true, selector, parts, hints };
  } catch (e) {
    if (e instanceof SelectorError)
      return { ok: false, selector, error: e.message, position: e.position, pointer: `${selector}\n${' '.repeat(Math.max(0, e.position))}^`, help: "help('selectors')" };
    throw e;
  }
}

// ---------- inspect ----------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function short(v) {
  return typeof v === 'string' && v.length > 40 ? v.slice(0, 37) + '...' : v;
}

function collectFields(obj, prefix, out, depth) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const f = (out[p] ||= { types: new Set(), samples: new Set() });
    f.types.add(typeOf(v));
    if (v !== null && typeof v !== 'object' && f.samples.size < 4) f.samples.add(short(v));
    if (v && typeof v === 'object' && !Array.isArray(v) && depth > 0) collectFields(v, p, out, depth - 1);
  }
}

export function inspect(target, { depth = 3, limit = 20 } = {}) {
  const doc = target instanceof JsonDoc ? target : new JsonDoc(target, { clone: false, history: 0 });
  const { typeKey, idKey, classKey } = doc.options;
  const tags = {};
  const ids = [];
  const classes = {};
  let elements = 0;
  doc._walk(doc.root, (n) => {
    elements++;
    const tag = doc.tagOf(n);
    const t = (tags[tag] ||= { count: 0, ids: [], classes: new Set(), fields: {}, parents: new Set(), keys: new Set() });
    t.count++;
    const id = doc.idOf(n);
    if (id !== null) {
      if (t.ids.length < 8) t.ids.push(id);
      if (ids.length < limit) ids.push(id);
    }
    for (const c of doc.classesOf(n)) {
      t.classes.add(c);
      classes[c] = (classes[c] || 0) + 1;
    }
    const p = doc.parentOf(n);
    if (p) t.parents.add(doc.tagOf(p));
    if (t.count <= 200) {
      const own = {};
      for (const [k, v] of Object.entries(n)) {
        // 子元素容器不作为字段展示
        if (v && typeof v === 'object' && containsElement(doc, v)) {
          t.keys.add(k);
          continue;
        }
        own[k] = v;
      }
      collectFields(own, '', t.fields, 1);
    }
  });

  const tagOut = {};
  for (const [tag, t] of Object.entries(tags).sort((a, b) => b[1].count - a[1].count)) {
    const fields = {};
    for (const [k, f] of Object.entries(t.fields)) {
      if (k === typeKey || k === idKey || k === classKey) continue;
      fields[k] = { types: [...f.types].join('|'), sample: [...f.samples] };
    }
    tagOut[tag] = {
      count: t.count,
      ...(t.ids.length ? { ids: t.ids } : {}),
      ...(t.classes.size ? { classes: [...t.classes].slice(0, 12) } : {}),
      ...(t.parents.size ? { parents: [...t.parents] } : {}),
      ...(t.keys.size ? { childKeys: [...t.keys] } : {}),
      fields,
    };
  }

  const outline = [];
  const walk = (n, d, ind) => {
    if (outline.length >= limit * 3) return;
    const id = doc.idOf(n);
    const cl = doc.classesOf(n);
    const kids = doc.childrenOf(n);
    outline.push(`${ind}${doc.tagOf(n)}${id !== null ? '#' + id : ''}${cl.length ? '.' + cl.join('.') : ''}${kids.length ? ` (${kids.length})` : ''}  ${doc.pointer(n) || '/'}`);
    if (d >= depth) return;
    const shown = kids.slice(0, 6);
    for (const k of shown) walk(k, d + 1, ind + '  ');
    if (kids.length > shown.length) outline.push(`${ind}  … 另有 ${kids.length - shown.length} 个`);
  };
  walk(doc.root, 0, '');

  const suggestions = [];
  const tagNames = Object.keys(tagOut).filter((t) => t !== 'root');
  for (const tag of tagNames.slice(0, 4)) {
    const t = tagOut[tag];
    suggestions.push(tag);
    if (t.ids?.length) suggestions.push(`#${t.ids[0]}`);
    const numField = Object.entries(t.fields).find(([, f]) => f.types === 'number');
    if (numField) suggestions.push(`${tag}[${numField[0]}>=${numField[1].sample[0]}]`);
    const strField = Object.entries(t.fields).find(([, f]) => f.types === 'string' && f.sample.length);
    if (strField) suggestions.push(`${tag}[${strField[0]}=${JSON.stringify(strField[1].sample[0])}]`);
    if (t.parents?.length && t.parents[0] !== 'root') suggestions.push(`${t.parents[0]} > ${tag}`);
  }
  const topClass = Object.entries(classes).sort((a, b) => b[1] - a[1])[0];
  if (topClass) suggestions.push(`.${topClass[0]}`);

  return {
    elements,
    options: { typeKey, idKey, classKey, element: typeof doc.options.element === 'function' ? 'function' : doc.options.element },
    tags: tagOut,
    ids,
    classes,
    outline,
    suggestions: [...new Set(suggestions)].slice(0, 12),
    next: "用 explain(sel) 检查选择器，doc.$(sel).length 看匹配数，help('mutation') 看修改方法。",
  };
}

function containsElement(doc, v) {
  if (doc._isEl.has(v)) return true;
  if (Array.isArray(v)) return v.some((x) => x && typeof x === 'object' && containsElement(doc, x));
  for (const x of Object.values(v)) if (x && typeof x === 'object' && containsElement(doc, x)) return true;
  return false;
}
