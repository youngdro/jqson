# jqson（jQuery for JSON）· Agent 使用指引

这个包自带完整文档和自查命令，不需要外部资料。遇到不确定的地方，先问包本身：

```bash
npx jqson help                 # 总览、上手三步、API 一览
npx jqson help selectors       # 主题：model selectors query mutation transaction parallel script inspect cli recipes
npx jqson help attr            # 查某个 API（拼错会给出相近建议）
npx jqson inspect data.json    # 看数据：有哪些标签、字段、id、class，结构大纲，可直接用的选择器
npx jqson explain "<sel>" data.json   # 解释选择器，返回匹配数和路径；语法错误会指出位置
```

在代码里同样可用：`import { help, inspect, explain } from 'jqson'`，`doc.describe()`，`doc.help('merge')`。

## 推荐流程

1. `inspect` 看结构，确认标签和字段名。
2. `explain` / `query --count` 确认选择器选中了想要的元素。
3. 用一段脚本完成全部修改：`jqson run data.json -e '<code>'`（先不加 `--write` 试跑，看 `changes`），或 `runScript(doc, code, { args })`。脚本原子执行，失败不留改动。
4. 有校验规则时加 `--lint rules.js`；需要并行就用 `parallel()`，各任务改不同 id 的子树。

## 规则

- 修改只用 Selection 方法（attr / set / merge / addClass / append / insert / remove / …）或 `doc.transaction`，不要直接给 `doc.root` 下的对象赋值。
- 所有 CLI 输出（除 help）都是一行 JSON；失败时 `ok:false`，带 `hint` 告诉你下一步查什么。
- shell 中 `-e` 代码用单引号包裹，避免 `$` 被展开。
