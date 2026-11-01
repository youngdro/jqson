# jqson（jQuery for JSON）· Agent 使用指引

这个包自带完整文档和自查命令，不需要外部资料。遇到不确定的地方，先问包本身：

```bash
npx jqson help                 # 总览、上手三步、API 一览
npx jqson help selectors       # 主题：model selectors query mutation transaction parallel script inspect cli recipes
npx jqson help attr            # 查某个 API（拼错会给出相近建议）
npx jqson inspect data.json    # 看数据：有哪些标签、字段、id、class，结构大纲，可直接用的选择器
npx jqson explain "<sel>" data.json   # 解释选择器，返回匹配数和路径；语法错误会指出位置
```

随包附带一份 Agent skill：`jqson skill` 输出内容，源文件在 `skills/jqson/SKILL.md`。

在代码里同样可用：`import { help, inspect, explain } from 'jqson'`，`doc.describe()`，`doc.help('merge')`。

## 推荐流程

1. `inspect` 看结构，确认标签和字段名。
2. `explain` / `query --count` 确认选择器选中了想要的元素。
3. 用一批声明式指令完成全部修改（不执行代码，首选）：`jqson exec data.json cmds.json --dry-run` 预览，确认后 `--write`；代码里 `doc.exec(commands)`。格式见 `jqson help exec`，工具调用参数定义见 `jqson schema`。
   exec 表达不了时再用 JSON Patch（`jqson patch`），最后才是脚本（`jqson run` / `runScript`，没有沙箱，只在可信环境用）。
4. 有校验规则时加 `--lint rules.js`；需要并行就用 `parallel()`，各任务改不同 id 的子树。

## 规则

- 写法与 jQuery 一致：回调参数是 `(i, value)` / `(i, el)`，`this` 为元素。差异与不提供的部分见 `jqson help jquery`。
- 修改只用 Selection 方法（attr / set / merge / addClass / append / insert / remove / …）或 `doc.transaction`，不要直接给 `doc.root` 下的对象赋值。
- 所有 CLI 输出（除 help）都是一行 JSON；失败时 `ok:false`，带 `hint` 告诉你下一步查什么。
- shell 中 `-e` 代码用单引号包裹，避免 `$` 被展开。
