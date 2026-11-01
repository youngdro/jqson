---
name: jqson
description: Use when querying or editing JSON documents (video projects, timelines, schemas, configs) with CSS selectors and jQuery-style chained methods via the jqson library or CLI.
---

# jqson：jQuery for JSON

把 JSON 当成 DOM：用 CSS 选择器找元素，用 jQuery 风格的链式方法改，改动带事务、校验、撤销和 JSON Patch，可以 fork/merge 并行。零依赖，浏览器和 Node 都能跑。

## 1. 准备

```bash
jqson help >/dev/null 2>&1 || npm i -g jqson     # 没装就装；项目内也可 npm i jqson 后用 npx jqson
```

## 2. 不确定就问包本身

包里自带全部文档，内容比本 skill 更新、更全，以它为准：

```bash
jqson help                 # 总览、上手三步、API 一览
jqson help <主题>           # model selectors query mutation transaction parallel script inspect cli recipes
jqson help <API名>          # 如 attr、merge、parallel；拼错会提示相近名字；加 --json 输出结构化
```

JS 中：`import { help } from 'jqson'; help('attr')`，或 `doc.help('merge')`。

## 3. 标准流程

1. **看数据**：`jqson inspect data.json`，得到标签、字段类型与示例值、id、class、结构大纲和可直接用的选择器。不要猜字段名。
2. **验选择器**：`jqson explain "<sel>" data.json`，看中文解释、匹配数和路径；语法错误会指出位置。
3. **一次脚本改完**：先不加 `--write` 试跑，确认 `changes` 合理后再写回。
   ```bash
   jqson run data.json -e '$("segment#offer text").attr("text", args.cta).addClass("pulse")' --args '{"cta":"立即抢购"}'
   jqson run data.json edit.js --lint rules.js --write      # 校验不过则整体不生效
   ```
   JS 中用 `await runScript(doc, code, { args })`，同样原子执行。
4. **读结果**：CLI 除 help 外都输出一行 JSON；`ok:false` 时看 `errors`（校验）、`conflicts`（冲突）和 `hint`（下一步查什么）。

## 4. 速记

- 元素 = 带 `type` 或 `id` 的对象；标签 = `type`，没有时用所在属性名；中间的普通对象/数组会被穿透。
- 选择器：`text` `#id` `.cls` `[zone=hero]` `[start>=2]` `[style.fontSize>40]` `a > b` `a b` `a + b` `a ~ b` `:has(> text)` `:not()` `:nth-child()` `:key(name)`。以 `#id` 开头最快。
- 修改：`attr(path, value | fn)` `set` `merge` `removeAttr` `addClass/removeClass/toggleClass` `append/prepend/before/after/insert` `remove/replaceWith/empty/appendTo`。写法和 jQuery 一致，path 支持点路径。
- 多步修改放进 `doc.transaction(fn)` 或一段脚本；`doc.use(validator)` 加校验；`doc.undo()` 撤销。
- 并行：`parallel(doc, tasks, { policy: 'skip' })`。等模型或网络的任务写成 `async (fork) => {}`，CPU 密集的写成 `{ script, args }` 交给 worker。让各任务改不同 id 的子树，避免冲突。

## 5. 不要

- 不要直接给 `doc.root` 下的对象赋值，否则索引和撤销会失效。改动一律走 Selection 方法或 `doc.set`。
- 在 shell 里写 `-e` 代码时用单引号包住整段，避免 `$` 被 shell 展开。
- 不要逐个元素多次调用 CLI；一段脚本完成全部修改更快，也是原子的。

## 6. 维护

本 skill 随仓库 https://github.com/youngdro/jqson 维护，路径 `skills/jqson/SKILL.md`，也随 npm 包发布。`jqson skill` 输出当前版本，可以这样装进项目：
`mkdir -p .claude/skills/jqson && jqson skill > .claude/skills/jqson/SKILL.md`
