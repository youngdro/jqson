---
name: jsonjq
description: Use when querying or editing JSON documents (video projects, timelines, schemas, configs) with CSS selectors and jQuery-style chained methods via the jsonjq library or CLI.
---

# jsonjq：jQuery for JSON

把 JSON 当成 DOM：用 CSS 选择器找元素，用 jQuery 风格的链式方法改，改动带事务、校验、撤销和 JSON Patch，可以 fork/merge 并行。零依赖，浏览器和 Node 都能跑。

## 1. 准备

```bash
jsonjq help >/dev/null 2>&1 || npm i -g jsonjq     # 没装就装；项目内也可 npm i jsonjq 后用 npx jsonjq
```

## 2. 不确定就问包本身

包里自带全部文档，内容比本 skill 更新、更全，以它为准：

```bash
jsonjq help                 # 总览、上手三步、API 一览
jsonjq help <主题>           # agent model selectors query mutation modes jquery reactive transaction parallel script inspect cli recipes
jsonjq help <API名>          # 如 attr、merge、parallel；拼错会提示相近名字；加 --json 输出结构化
```

JS 中：`import { help } from 'jsonjq'; help('attr')`，或 `doc.help('merge')`。

## 3. 标准流程

1. **看数据**：`jsonjq inspect data.json`，得到标签、字段类型与示例值、id、class、结构大纲和可直接用的选择器。不要猜字段名。
2. **验选择器**：`jsonjq explain "<sel>" data.json`，看中文解释、匹配数和路径；语法错误会指出位置。
3. **用声明式指令改**（默认方式，不执行代码）：先 `--dry-run` 看补丁，合理后再 `--write`。
4. **读结果**：CLI 除 help 外都输出一行 JSON；`ok:false` 时看 `command`（第几条指令）、`errors`（校验）、`conflicts`（冲突）和 `hint`（下一步查什么）。整批失败时什么都不会改。

## 4. 三种修改方式，按这个顺序选

**① 声明式指令 exec（首选）**：纯 JSON，只能调用白名单方法，整批原子执行，`expect` 断言匹配数量防止选错。

```json
[
  { "$": "lottie#price-tag", "expect": 1, "attr": { "fields.price": "¥29", "fields.was": "¥59" } },
  { "$": "#offer > text", "expect": 1, "do": [["text", "限时 ¥29"], ["addClass", "pulse"]] },
  { "$": "text.caption", "css": { "fontSize": { "$mul": 1.1, "$round": 0 } } },
  { "$": { "type": "image", "id": "logo", "src": "logo.png" }, "insertAfter": "#hero-shot" },
  { "$": "#point-1, #point-2", "wrapAll": { "type": "group", "id": "g1" } },
  { "$": "segment", "pluck": "id" }
]
```

```bash
jsonjq exec data.json cmds.json --dry-run            # 预览
jsonjq exec data.json cmds.json --lint rules.js --write
jsonjq exec data.json --ops '[{"$":"#hook","attr":["x",1]}]'
```

- 每条指令：`"$"` 选择器（或要新建的 JSON 对象）、可选 `"expect"`、然后是 `方法: 参数`（数组 = 参数列表，`true` = 无参数，其他 = 唯一参数）或 `"do": [["方法", ...参数]]` 链式调用。
- 按旧值计算用值运算：`{"$add": n}` `{"$mul": n}` `{"$round": 位数}` `{"$prefix": s}` `{"$suffix": s}` `{"$replace": [旧, 新]}` `{"$default": v}`。
- 读取：`pluck` `count` `paths` `json`，或 `"attr": "path"`，结果在 `results[i].value`。
- 格式细节：`jsonjq help exec`、`jsonjq help agent`；工具调用的参数定义：`jsonjq schema`。

**② JSON Patch**：要和其他系统交换改动、或逐条审核时用。路径先用 `jsonjq query data.json "<sel>" --paths` 拿到，再 `jsonjq patch data.json p.json --out next.json`。

**③ 脚本 run / runScript（只在可信环境）**：exec 表达不了的循环、条件、复杂计算才用。脚本是任意 JavaScript，**没有沙箱**。
```bash
jsonjq run data.json -e '$("segment").each((i, seg) => { $(seg).find("text").attr("start", (j, v) => v + i * 0.1) })'
```
JS 中用 `await runScript(doc, code, { args })`，同样原子执行。

只读查询：`jsonjq query data.json "<sel>" --pluck text`（或 `--paths` / `--count`）。

## 5. 速记

- 元素 = 带 `type` 或 `id` 的对象；标签 = `type`，没有时用所在属性名；中间的普通对象/数组会被穿透。
- 选择器：`text` `#id` `.cls` `[zone=hero]` `[start>=2]` `[style.fontSize>40]` `a > b` `a b` `a + b` `a ~ b` `:has(> text)` `:not()` `:nth-child()` `:key(name)`。以 `#id` 开头最快。
- **按 jQuery 的习惯写**：方法名、参数、回调都与 jQuery 一致。回调是 `(i, value)` 或 `(i, el)`，`this` 为元素：`attr('start', (i, v) => v + 1)`、`filter((i, el) => el.text.length > 14)`。
- 修改：`attr` `css` `text` `removeAttr` `addClass/removeClass/toggleClass`；`append/prepend/before/after` `appendTo/prependTo/insertBefore/insertAfter` `remove/empty/replaceWith/replaceAll` `clone` `wrap/wrapAll/wrapInner/unwrap`。path 支持点路径，`attr(path, null)` 删除字段。
- 文档里已有的元素 append 到别处是移动；新建元素用 `doc.$({ type: 'image', ... }).appendTo('#seg')`，复制用 `.clone().attr('id', 'x').insertAfter(...)`。
- jQuery 里与 DOM 绑定的 `html` `val` `prop` `data`、事件、动画、尺寸都没有，用 `attr` / `doc.watch` 代替；对照表 `jsonjq help jquery`。
- 模式：默认 `copy` 深拷贝；`mode: 'inplace'` 直接改传入对象；`mode: 'immutable'` 提供结构共享快照 `doc.state`（给 React 等框架用）。`jsonjq help modes`。
- 配合 Vue / MobX：推荐 `doc.syncTo(store, { batch: runInAction })` 把提交后的改动逐字段推过去；也可 `mode: 'inplace'` 直接作用在 observable 上。`jsonjq help reactive`。
- 代码里：`doc.exec(commands, { dryRun })`；多步修改也可放进 `doc.transaction(fn)`；`doc.use(validator)` 加校验；`doc.undo()` 撤销。
- 并行：`parallel(doc, tasks, { policy: 'skip' })`。等模型或网络的任务写成 `async (fork) => {}`，CPU 密集的写成 `{ script, args }` 交给 worker。让各任务改不同 id 的子树，避免冲突。
- 合并按最近的唯一 id 祖先锚定，兄弟增删不会错位。冲突 = 同路径或前缀路径、修改了对方删除的子树；同一数组双方追加不算冲突。多次并行时传 `pool: await createPool({ size })` 复用线程。
- 规模参考：2000 元素时查询约 1ms、8 个 worker 任务约 170ms；10 万元素时 fork 约 0.35s，并行主要耗在数据复制。

## 6. 不要

- 不要直接给 `doc.root` 下的对象赋值，否则索引和撤销会失效。改动一律走 Selection 方法（如 `doc.$(sel).set(...)`）或 `doc.applyPatch`。
- 在 shell 里写 `-e` 代码时用单引号包住整段，避免 `$` 被 shell 展开。
- 不要用 `jsonjq run` / `runScript` 执行来自用户输入或第三方的代码：脚本没有沙箱，权限与当前进程相同。
- 用 worker 跑脚本任务时，`element` 选项不能是函数。
- 不要逐个元素多次调用 CLI；把改动写成一批 exec 指令一次提交，更快，也是原子的。
- 能用 exec 表达时不要改用脚本。

## 7. 维护

本 skill 随仓库 https://github.com/youngdro/jqson 维护，路径 `skills/jsonjq/SKILL.md`，也随 npm 包发布。`jsonjq skill` 输出当前版本，可以这样装进项目：
`mkdir -p .claude/skills/jsonjq && jsonjq skill > .claude/skills/jsonjq/SKILL.md`
