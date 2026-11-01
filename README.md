# jsonjq

中文 | [English](README.en.md)

**jQuery for JSON**：用 CSS 选择器和 jQuery 式的链式方法读写任意 JSON，带事务、校验、撤销、变更流，以及基于 fork/merge 的并行修改。零依赖，同一份代码在**浏览器**和 **Node** 中运行。

```bash
npm i jsonjq          # 全局安装可直接用命令：npm i -g jsonjq && jsonjq help
```

```js
import jsonjq from 'jsonjq';

const doc = jsonjq(project);                       // 深拷贝一次并建索引
doc.$('segment#hook text').attr('style.color', '#ff3b30');
doc.$('text[zone=price-band]').addClass('pulse');
doc.$('#selling').append({ type: 'image', id: 'detail-3', src: 'c.png', start: 6, duration: 2 });
doc.undo();
```

## 0. 自带文档与自查（给 Agent）

包内置了全部用法说明和数据探索命令，Agent 安装后可以自己学会怎么用，见 [AGENTS.md](AGENTS.md)。

```bash
jsonjq help                      # 总览与 API 一览；jsonjq help <主题|API名>，--json 输出结构化
jsonjq inspect data.json         # 标签、字段（类型与示例值）、id、class、结构大纲、推荐选择器
jsonjq explain "segment > text[start>=2]" data.json   # 中文解释 + 匹配数 + 路径；语法错误指出位置
```

```js
import { help, inspect, explain } from 'jsonjq';
help('attr');  help.json('parallel');  help.api();
inspect(doc);  doc.describe();  explain('text:has(> image)');
```

仓库和 npm 包都附带一份 Agent skill（`skills/jsonjq/SKILL.md`），与代码一起维护。装进 Claude Code 项目：

```bash
mkdir -p .claude/skills/jsonjq && jsonjq skill > .claude/skills/jsonjq/SKILL.md
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

## 3. Selection API（与 jQuery 对齐）

方法名、参数和回调形式都与 jQuery 一致：回调是 `function (index, element)`，`this` 指向元素；读取方法返回第一个元素的值；写入方法返回 Selection 可链式调用。完整对照与取舍见 [docs/jquery-compat.md](docs/jquery-compat.md)。

查询：`doc.$(selector | node | nodes, scope?)`、`doc.get(sel)`（首个节点）、`doc.byId(id)`、`doc.matches(node, sel)`。

遍历：`find` `children` `parent` `parents` `parentsUntil` `closest` `siblings` `next` `nextAll` `nextUntil` `prev` `prevAll` `prevUntil` `filter` `not` `is` `has` `eq` `first` `last` `even` `odd` `slice` `add` `addBack` `end` `index`

读取：`length` `get(i)` `toArray()` `each(fn)` `map(fn)` `attr(path)` `css(name)` `text()` `hasClass(c)`，扩展 `pluck(path)` `json()` `paths()`

修改（每次调用一个事务，自动更新索引）：

```js
s.attr('style.fontSize', 48)                  // 点路径
s.attr('start', (i, old) => old + 0.5)        // 同 jQuery：(index, oldValue)，this 为元素
s.attr({ zone: 'hero', duration: 2 })
s.attr('motion', null)                        // null 删除字段；写字面量 null 用 s.set
s.css('font-size', 48) / s.css({ color: '#fff' })   // 读写 style 子对象
s.text('新文案')
s.addClass('a b') / s.removeClass() / s.toggleClass('a', true)
s.append(content, key?) / s.prepend / s.before / s.after
s.appendTo(target) / s.prependTo / s.insertBefore / s.insertAfter
s.remove(sel?) / s.empty() / s.replaceWith(v) / s.replaceAll(target)
s.clone().attr('id', 'b').insertAfter('#a')   // 复制、改、插回
doc.$({ type: 'image', id: 'logo' }).appendTo('#hero')   // 新建元素
s.wrapAll({ type: 'group', id: 'g1' }) / s.wrap / s.wrapInner / s.unwrap()
s.set(path, value) / s.merge(obj, path?) / s.insert(content)   // jsonjq 扩展
```

- `append` 默认放进 `children`（不存在会创建），第二个参数可指定其他数组字段。
- 把文档里已有的元素 append 到别处是**移动**；多个目标时前面的得到复制品（同 jQuery）。
- 插件：`jsonjq.fn.shift = function (dt) { return this.attr('start', (i, v) => v + dt) }`。

## 3.1 三种模式

```js
jsonjq(data)                          // mode: 'copy'（默认）：深拷贝一次，原数据不受影响
jsonjq(data, { mode: 'inplace' })     // 直接修改传入的对象，只有一份数据；之后只能通过 jsonjq 改它
jsonjq(data, { mode: 'immutable' })   // copy + 结构共享的不可变快照
```

`immutable` 模式下 `doc.state` 初始就是传入的 `data`；每次提交后只有改动路径上的对象换新引用，其余与上一个快照共享，适合 React / Vue 等按引用比较的框架：

```js
const doc = jsonjq(project, { mode: 'immutable' });
doc.on((e) => setState(e.state));    // e.state 即 doc.state
doc.$('#point-1').text('零糖');       // 只有 #point-1、#selling、根 是新对象
```

`doc.snapshot()` / `doc.state` 在任何模式下都能用；`freeze: true` 时新对象会被冻结。

## 3.2 配合 Vue / MobX 等响应式数据

推荐让 jsonjq 持有自己的数据，每次提交后用 JSON Patch 逐字段推给响应式对象：

```js
const doc = jsonjq(toRaw(state));                // Vue；MobX 用 toJS(store)
doc.syncTo(state);                              // Vue
doc.syncTo(store, { batch: runInAction });      // MobX：一次提交只触发一次反应，严格模式也不报警
```

只有真正改动的字段触发更新，观察者看不到事务中间状态，jsonjq 的读取也不经过代理。

也可以用 `inplace` 直接作用在响应式对象上：`jsonjq(state, { mode: 'inplace' })`，MobX 再加 `batch: runInAction`。这个模式不往对象上写任何内部字段（元数据放在 WeakMap），建文档不会触发更新；MobX、Valtio 赋值时把对象换成代理副本的情况也已处理；观察者抛错时事务会完整回滚。代价是所有读取都经过代理，比 `syncTo` 慢。

已用 @vue/reactivity 3.5 和 MobX 6.13 实测。详见 `jsonjq help reactive`。

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
import { parallel, createPool } from 'jsonjq';

const reports = await parallel(doc, [
  // 函数任务：当前线程、各自 fork，适合等模型/网络（I/O 并发）
  async (fork) => fork.$('#hook-title').attr('text', await llm('改写标题')),
  // 脚本任务：在 worker 线程里执行，适合吃 CPU 的批量改写
  { script: "$('text').css('fontSize', (i, v) => Math.round(v * 1.1))" },
  { script: "$('image').attr('opacity', args.o)", args: { o: 0.9 } },
], { policy: 'skip', order: 'task' | 'finish', threads: 4 });
// reports[i] = { index, ok, applied, conflicts, error, result }
```

- 浏览器用 `Web Worker`（module worker），Node 用 `worker_threads`，入口都是 `src/worker.js`。
- 反复调用时传入 `pool: await createPool({ size })` 复用线程；worker 会缓存同一版本的文档，只传一次数据。
- 脚本任务的 `doc.options.element` 不能是函数（无法跨线程）。

## 6. 给 Agent 的三种用法

按安全性排序。**能用声明式指令表达就用它**；要和别的系统交换改动用 JSON Patch；只有前两种表达不了、且代码来源可信时才用脚本。三种方式都整体原子执行，都可以加校验器，失败都不会留下改动。

| 方式 | 执行代码 | 灵活度 | 适合 |
|---|---|---|---|
| 声明式指令 `exec` | 否，纯 JSON，方法白名单 | 覆盖绝大多数编辑 | 默认选择；工具调用（function calling） |
| JSON Patch `patch` | 否 | 只能按路径改 | 与其他系统交换改动、逐条审核 |
| 脚本 `run` / `runScript` | **是，没有沙箱** | 任意逻辑 | 可信环境里的复杂计算 |

### 6.1 声明式指令 exec（推荐）

每条指令用 `"$"` 选中元素，`"expect"` 断言数量，再写要调用的方法和参数（参数只能是 JSON）：

```json
[
  { "$": "lottie[zone=price-band]", "expect": 1, "attr": ["fields.price", "¥29"] },
  { "$": "text.caption", "css": { "fontSize": { "$mul": 1.1, "$round": 0 } } },
  { "$": "#point-1", "do": [["text", { "$suffix": "！" }], ["addClass", "hl"]] },
  { "$": { "type": "image", "id": "logo", "src": "logo.png" }, "insertAfter": "#hero-shot" },
  { "$": "#point-1, #point-2", "wrapAll": { "type": "group", "id": "g1" } },
  { "$": "#selling > image", "remove": true },
  { "$": "segment", "pluck": "id" }
]
```

- 简写：键是方法名，值是参数。数组表示参数列表，`true` 表示无参数，其他值表示唯一参数；要传一个数组作为唯一参数，写成 `[[...]]`。
- 链式：`"do": [["find", "> text"], ["attr", "start", 1], ["addClass", "a"]]`，按顺序执行。
- 按旧值计算：值运算 `{"$add": n}` `{"$mul": n}` `{"$round": 位数}` `{"$prefix": s}` `{"$suffix": s}` `{"$replace": [旧, 新]}` `{"$default": v}`，可以组合。
- 读取：`pluck` `count` `paths` `json` `index` `is` `hasClass`，以及 `"attr": "path"`、`"text": []` 这类只读调用，结果放在 `results[i].value`。
- 不允许：`each` / `map` 等需要函数的方法、未知方法、未知的 `$` 运算，都会报错并指出第几条。

```bash
jsonjq exec project.json cmds.json --dry-run          # 先预览补丁
jsonjq exec project.json cmds.json --lint rules.js --write
echo '[{"$":"#hook","attr":["x",1]}]' | jsonjq exec project.json -
jsonjq schema                                          # JSON Schema，直接作为工具调用的参数定义
```

```js
const { results, patch } = doc.exec(commands, { dryRun: true });
import { execSchema } from 'jsonjq';   // 交给模型的工具定义
```

**案例：商品视频批量改价并突出卖点**

```json
[
  { "$": "lottie#price-tag", "expect": 1, "attr": { "fields.price": "¥29", "fields.was": "¥59" } },
  { "$": "#offer > text", "expect": 1, "do": [["text", "限时 ¥29"], ["addClass", "pulse"]] },
  { "$": "#selling > text", "expect": 2, "css": { "color": "#ffe14d" }, "attr": ["motion.preset", "pop-in"] },
  { "$": "#offer > *", "attr": ["start", { "$add": 0.5 }] }
]
```

**案例：给每段开头加转场，并把重复的卖点编组**

```json
[
  { "$": "segment", "expect": 3, "prepend": { "type": "lottie", "src": "presets/wipe.json", "start": 0, "duration": 0.3 } },
  { "$": "#detail-1, #point-1", "wrapAll": { "type": "group", "id": "sp-1" } }
]
```

### 6.2 JSON Patch

标准 RFC 6902 格式。先用 `jsonjq query <file> <sel> --paths` 拿到路径，再生成补丁：

```bash
jsonjq query project.json "#point-1" --paths      # → ["/children/1/children/1"]
jsonjq patch project.json changes.json --out next.json
```

```json
[{ "op": "replace", "path": "/children/1/children/1/text", "value": "零糖" }]
```

每次提交的改动也能通过 `doc.on(e => e.patch)` 或 `--patch out.json` 拿到，用来审核、回放或同步给其他系统。

### 6.3 脚本（仅限可信环境）

```js
import { runScript } from 'jsonjq';
await runScript(doc, `
  for (const seg of $('segment')) {
    const texts = $(seg).find('text');
    texts.attr('start', (i, v) => +(v + i * 0.1).toFixed(2));
  }
  return $('text').length;
`, { args: {} });   // 在 fork 上运行，成功才整体合并（原子）
```

脚本中可用 `$`、`doc`、`args`，可以 `await`，适合需要循环、条件判断、复杂计算的场景。

> **安全提示**：`runScript`、`parallel` 的脚本任务和命令行 `jsonjq run` 执行的是任意 JavaScript，**没有沙箱**，权限与当前进程（或 worker）相同，可以读写文件、访问网络。只运行你信任的代码，例如你自己的 Agent 在受控环境中生成的脚本；不要直接执行来自用户输入或第三方的代码。需要隔离时，把它放进容器、受限的子进程或浏览器 iframe 中运行。

## 7. 命令行

```bash
jsonjq help [主题|API] [--json]
jsonjq inspect examples/video-project.json
jsonjq explain "segment > text" examples/video-project.json
jsonjq query examples/video-project.json "text[zone=caption-band]" --pluck text
jsonjq exec  project.json cmds.json [--ops json] [--dry-run] [--lint rules.js] [--write | --out file] [--patch file]
jsonjq schema
jsonjq run   project.json edit.js -e "$('video').attr('muted', true)" --lint examples/video-lint.js --write
jsonjq run   project.json a.js b.js --parallel --threads 4 --patch out.patch.json
jsonjq patch project.json out.patch.json --out next.json
```

输出始终是一行 JSON（`ok`、`count`/`values`、`changes`、`conflicts`、`ms`）；失败时退出码 1，带 `errors`（校验）、`conflicts`（冲突）或 `command`（exec 中出错的指令序号），以及 `hint`（下一步查什么）。

## 8. 在浏览器和打包器里用

```html
<script type="module">
  import jsonjq, { parallel } from './jsonjq/src/index.js';
</script>
```

源码是纯 ESM，Node 专用模块只在 Node 分支里动态导入，浏览器不会加载。worker 用 `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` 创建，打包器会把它和依赖单独打成一个文件：

- **Vite**：`vite build` 不用配置。开发服务器会预构建依赖，导致找不到 worker 文件，需要排除：
  ```js
  // vite.config.js
  export default { optimizeDeps: { exclude: ['jsonjq'] } };
  ```
- **webpack 5**：不用配置。入口里用了顶层 await 的话打开 `experiments.topLevelAwait`（webpack 5.83 起默认开启）。

以上三种情况（Vite build、Vite dev、webpack 5 build）都在 Chromium 中实测过并行脚本任务，`npm run test:bundlers` 可复现。不用 worker 的功能（查询、修改、exec、事务、函数任务）不受打包方式影响。

## 9. 性能（Node 22，单机）

| 操作 | 2,000 元素 | 100,000 元素 |
|---|---|---|
| 建文档（深拷贝 + 建索引） | 8 ms | 280 ms |
| `#id` 查询 | 0.03 ms | 0.04 ms |
| `.class` 查询 | 0.6 ms | 15 ms |
| `text[style.fontSize>55]`（全量扫描） | 1.4 ms | 13 ms |
| `#s42 > .caption[motion.preset=pulse]` | <0.01 ms | 0.5 ms |
| 单事务批量改属性 | 400 个 2 ms | 20,000 个 75 ms |
| fork | 5 ms | 280 ms |
| 合并改了 500 个元素的 fork | 26 ms | 316 ms |
| 8 个 worker 脚本任务（4 线程，含传输与合并） | 155 ms | 3.7 s |

说明：

- 带索引的查询（id、class、`#id` 开头）很快；属性扫描约为手写 JS 循环的 6–7 倍开销，换来的是可读的选择器和自动索引。
- 大文档上 fork 和 worker 并行的主要成本是**复制数据**（深拷贝或跨线程结构化克隆）。商品视频工程一般几百到几千个元素，这个规模上并行开销在百毫秒级。
- 等模型返回这类 I/O 任务用函数任务就够了，不用 worker；只有 CPU 密集的批量改写才值得进 worker。

运行：`npm test`、`npm run test:browser`、`npm run test:bundlers`、`npm run typecheck`、`npm run bench [段数] [每段元素数]`。

## 10. 文件

```
src/selector.js   选择器解析
src/doc.js        JsonDoc、Selection、事务、索引、撤销、fork/merge、冲突检测
src/parallel.js   parallel()、createPool()
src/script.js     runScript()、compileScript()
src/worker.js     浏览器与 Node 共用的 worker 入口
src/help.js       内置文档 help()、数据概况 inspect()、选择器解释 explain()
src/exec.js       exec()：声明式指令与 JSON Schema
src/sync.js       syncTo()、applyPatchTo()：同步到 Vue / MobX 等响应式数据
bin/jsonjq.js      命令行
types/            TypeScript 类型声明
skills/jsonjq/     随包附带的 Agent skill
examples/         视频工程示例与校验器
docs/             jQuery 对照表等文档
```

## 许可

MIT
