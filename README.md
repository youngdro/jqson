# jqson

**jQuery for JSON**：用 CSS 选择器和 jQuery 式的链式方法读写任意 JSON，带事务、校验、撤销、变更流，以及基于 fork/merge 的并行修改。零依赖，同一份代码在**浏览器**和 **Node** 中运行。

```bash
npm i jqson          # 全局安装可直接用命令：npm i -g jqson && jqson help
```

```js
import jqson from 'jqson';

const doc = jqson(project);                       // 深拷贝一次并建索引
doc.$('segment#hook text').attr('style.color', '#ff3b30');
doc.$('text[zone=price-band]').addClass('pulse');
doc.$('#selling').append({ type: 'image', id: 'detail-3', src: 'c.png', start: 6, duration: 2 });
doc.undo();
```

## 0. 自带文档与自查（给 Agent）

包内置了全部用法说明和数据探索命令，Agent 安装后可以自己学会怎么用，见 [AGENTS.md](AGENTS.md)。

```bash
jqson help                      # 总览与 API 一览；jqson help <主题|API名>，--json 输出结构化
jqson inspect data.json         # 标签、字段（类型与示例值）、id、class、结构大纲、推荐选择器
jqson explain "segment > text[start>=2]" data.json   # 中文解释 + 匹配数 + 路径；语法错误指出位置
```

```js
import { help, inspect, explain } from 'jqson';
help('attr');  help.json('parallel');  help.api();
inspect(doc);  doc.describe();  explain('text:has(> image)');
```

CLI 出错时返回 `hint` 字段，告诉 Agent 下一步该查什么；`help` 拼错会给出相近建议。

## 1. 模型：JSON 怎么变成“DOM”

- **元素**：带 `type` 或 `id` 的对象（`element: 'auto'`，默认）。也可设 `element: 'all'`（所有对象都是元素）或传入函数 `(obj, key, parent) => boolean`。根节点总是元素。
- **标签**：元素的 `type` 字段；没有 `type` 时用它所在的属性名（如 `zones.hero` 的标签是 `hero`）。
- **子元素**：元素下任意深度的对象/数组里遇到的下一层元素，中间的普通对象和数组会被“穿透”。所以 `{children:[...]}`、`{tracks:{main:[...]}}` 都能用。
- **id / class**：`id` 字段；`class` 字段（字符串空格分隔或数组）。字段名可通过 `typeKey / idKey / classKey / childrenKey` 修改。
- 内部用 id、tag、class 三个索引，加上每个节点的父指针，所以按 id/class 查找和向上找 `closest` 都是常数级。

## 2. 选择器

| 写法 | 含义 |
|---|---|
| `text` `#hook` `.big` `*` | 标签 / id / class / 任意 |
| `[zone]` `[zone=hero]` `[text*=糖]` `[src^=http]` `[src$=.png]` `[class~=a]` `[lang\|=zh]` `[x!=1]` | 属性存在与比较，`i` 后缀忽略大小写 |
| `[start>=2]` `[duration<1.5]` | 数值比较 |
| `[style.fontSize>40]` `[motion.preset=pulse]` | 点路径进入嵌套字段 |
| `a b` `a > b` `a + b` `a ~ b` `a, b` | 后代、子、相邻、兄弟、并集 |
| `:first-child` `:last-child` `:only-child` `:nth-child(2n+1)` `:nth-last-child(1)` | 位置 |
| `:first` `:last` `:root` `:empty` | 同 `:first-child`/`:last-child`、根、无子元素（结果集首尾用 `.first()`/`.last()`） |
| `:not(...)` `:is(...)` `:where(...)` `:has(...)` `:has(> text)` | 逻辑与关系 |
| `:key(hero)` | 按所在属性名匹配 |

选择器解析结果会缓存。`#id` 开头的复杂选择器会从 id 节点直接展开，不扫全树。

## 3. Selection API

查询：`doc.$(selector | node | nodes, scope?)`、`doc.get(sel)`（首个节点）、`doc.byId(id)`、`doc.matches(node, sel)`。

遍历：`find` `children` `parent` `parents` `closest` `siblings` `next` `prev` `filter` `not` `is` `has` `eq` `first` `last` `slice` `add`

读取：`get(i)` `toArray()` `each(fn)` `map(fn)` `json()` `paths()`（JSON Pointer）`pluck(path)` `hasClass(c)` `attr(path)`

修改（每次调用一个事务，自动更新索引）：

```js
s.attr('style.fontSize', 48)              // 点路径
s.attr('start', (old, node, i) => old + 0.5)
s.attr({ zone: 'hero', duration: 2 })
s.set(path, value) / s.merge(obj, path?) / s.removeAttr(path)
s.addClass('a b') / s.removeClass('a') / s.toggleClass('a')
s.append(value, key?) / s.prepend(value) / s.before(value) / s.after(value)
s.insert(...)  // 返回新插入的元素 Selection
s.remove() / s.replaceWith(value) / s.empty() / s.appendTo(target)
```

`append` 默认放进 `children`（或已有的子元素数组）；可用第二个参数指定字段名。

## 4. 事务、校验、撤销、监听

```js
const { patch, version } = doc.transaction(() => {
  doc.$('text').attr('style.color', '#fff');
  doc.$('#old').remove();
}, { by: 'agent' });                      // 抛错 → 全部回滚

doc.use(({ doc, touched, patch }) => errors);   // 校验器：返回非空错误数组则回滚并抛 ValidationError
doc.undo(); doc.redo();                          // 以事务为单位，history 默认 200
doc.on(e => e.patch);                            // 每次提交的 RFC 6902 JSON Patch
doc.watch('text[zone=price-band]', e => {});     // 只在匹配元素被改动时触发
doc.applyPatch(patch);                           // 回放 add/remove/replace/move/copy/test
```

`examples/video-lint.js` 是一个视频工程校验器：区域存在、时长 > 0、各区域文案字数上限、同区域文字时间不重叠。

## 5. 并行：fork / merge / parallel

```js
const a = doc.fork();   // 独立副本，各自修改
a.$('#hook-title').attr('text', '夏日必备');
doc.merge(a, { policy: 'throw' | 'skip' | 'force' });
```

合并时，每个操作按**最近的带唯一 id 的祖先**做锚点重放，所以主文档里别人插入/删除了兄弟元素，下标偏移不会让修改落错位置。

冲突规则：

- 同一路径、或一方路径是另一方的前缀（改 `style` vs 改 `style.color`）→ 冲突
- 双方都往同一数组**追加** → 不冲突，按顺序追加
- 一方删除了某子树，另一方改其中内容 → 冲突
- `throw` 抛 `ConflictError`（含冲突列表），`skip` 跳过整个冲突任务，`force` 覆盖

`parallel(doc, tasks, opts)` 同时跑多个任务，结束后依次合并：

```js
import { parallel, createPool } from 'jqson';

const reports = await parallel(doc, [
  // 函数任务：当前线程、各自 fork，适合等模型/网络（I/O 并发）
  async (fork) => fork.$('#hook-title').attr('text', await llm('改写标题')),
  // 脚本任务：在 worker 线程里执行，适合吃 CPU 的批量改写
  { script: "$('text').attr('style.fontSize', v => Math.round(v * 1.1))" },
  { script: "$('image').attr('opacity', args.o)", args: { o: 0.9 } },
], { policy: 'skip', order: 'task' | 'finish', threads: 4 });
// reports[i] = { index, ok, applied, conflicts, error, result }
```

- 浏览器用 `Web Worker`（module worker），Node 用 `worker_threads`，入口都是 `src/worker.js`。
- 反复调用时传入 `pool: await createPool({ size })` 复用线程；worker 会缓存同一版本的文档，只传一次数据。
- 脚本任务的 `doc.options.element` 不能是函数（无法跨线程）。

## 6. 脚本运行器（给 Agent 用）

```js
import { runScript } from 'jqson';
await runScript(doc, `
  const t = $('segment#offer text');
  t.attr('text', args.cta).addClass('pulse');
  return t.length;
`, { args: { cta: '立即抢购' } });   // 在 fork 上运行，成功才整体合并（原子）
```

脚本中可用 `$`、`doc`、`args`，可以 `await`。Agent 只需写一段短代码，比逐个调工具快得多，且失败零副作用。

## 7. 命令行

```bash
jqson help [主题|API] [--json]
jqson inspect examples/video-project.json
jqson explain "segment > text" examples/video-project.json
jqson query examples/video-project.json "text[zone=caption-band]" --pluck text
jqson run   project.json edit.js -e "$('video').attr('muted', true)" --lint examples/video-lint.js --write
jqson run   project.json a.js b.js --parallel --threads 4 --patch out.patch.json
jqson patch project.json out.patch.json --out next.json
```

输出始终是一行 JSON（`ok`、`count`/`values`、`changes`、`conflicts`、`ms`）；失败时退出码 1，带 `errors`（校验）或 `conflicts`（冲突）。

## 8. 在浏览器里用

```html
<script type="module">
  import jqson, { parallel } from './jqson/src/index.js';
</script>
```

源码是纯 ESM。打包器（Vite/webpack 5/Rollup）能识别 `new URL('./worker.js', import.meta.url)`，会自动打出 worker 文件。Node 专用模块只在 Node 分支里动态导入，浏览器不会加载。已在 Chromium 中验证：查询、修改、Web Worker 并行脚本、函数任务、合并与撤销。

## 9. 性能（Node 22，单机）

| 操作 | 2,000 元素 | 100,000 元素 |
|---|---|---|
| 建文档（深拷贝 + 建索引） | 7.8 ms | 317 ms |
| `#id` 查询 | 0.02 ms | 0.04 ms |
| `.class` 查询 | 0.4 ms | 18 ms |
| `text[style.fontSize>55]`（全量扫描） | 1.3 ms | 25 ms |
| `#s42 > .caption[motion.preset=pulse]` | <0.01 ms | 0.6 ms |
| 单事务批量改属性 | 400 个 1.9 ms | 20,000 个 86 ms |
| fork | 6 ms | 354 ms |
| 合并改了 500 个元素的 fork | 42 ms | 470 ms |
| 8 个 worker 脚本任务（4 线程，含传输与合并） | 171 ms | 3.8 s |

说明：

- 带索引的查询（id、class、`#id` 开头）很快；属性扫描约为手写 JS 循环的 8–10 倍开销，换来的是可读的选择器和自动索引。
- 大文档上 fork 和 worker 并行的主要成本是**复制数据**（深拷贝或跨线程结构化克隆）。商品视频工程一般几百到几千个元素，这个规模上并行开销在百毫秒级。
- 等模型返回这类 I/O 任务用函数任务就够了，不用 worker；只有 CPU 密集的批量改写才值得进 worker。

运行：`npm test`（16 个用例），`npm run bench [段数] [每段元素数]`。

## 10. 文件

```
src/selector.js   选择器解析
src/doc.js        JsonDoc、Selection、事务、索引、撤销、fork/merge、冲突检测
src/parallel.js   parallel()、createPool()
src/script.js     runScript()、compileScript()
src/worker.js     浏览器与 Node 共用的 worker 入口
src/help.js       内置文档 help()、数据概况 inspect()、选择器解释 explain()
bin/jqson.js    命令行
examples/         视频工程示例与校验器
```
