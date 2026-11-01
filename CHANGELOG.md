# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。1.0 之前，次版本号（0.x）的升级可能包含不兼容改动，会在下面标出。

## 0.4.0 - 2026-11-01

首个发布到 npm 的版本。

- 新增声明式指令 `exec`（`doc.exec(commands)` / `jqson exec`）：纯 JSON、方法白名单、整批原子、`expect` 断言匹配数、值运算 `$add` `$mul` 等、`--dry-run` 预览；`execSchema` / `jqson schema` 给工具调用用
- README、skill、AGENTS.md 把给 Agent 的推荐方式改为 exec → JSON Patch → 脚本，并附案例
- 新增 TypeScript 类型声明 `types/index.d.ts`
- 新增 GitHub Actions：Node 18 / 20 / 22 单元测试、Chromium 冒烟测试（含 Web Worker 并行）、类型检查
- 新增英文 README（`README.en.md`）
- 文档写明 `runScript` / `jqson run` 执行任意 JS、没有沙箱
- 修复：经 Vite / webpack 打包后 worker 无法加载（Vite 不会打出 worker 文件，webpack 因 `node:worker_threads` 报错）。现在 Vite build、Vite dev（需 `optimizeDeps.exclude: ['jqson']`）和 webpack 5 都能直接使用，新增 `npm run test:bundlers` 在 Chromium 中实测
- worker 加载失败时的报错改为给出排查提示
- 性能：全文属性扫描改用缓存的文档顺序表，约快 2 倍；大结果集按文档顺序排序改为 O(N) 过滤或数字排序；属性匹配不再每次创建闭包。10 万元素时 `text[style.fontSize>55]` 由约 25 ms 降到约 13 ms，合并 500 处改动由约 470 ms 降到约 316 ms

## 0.3.1 - 2026-11-01

- `inplace` 模式的元数据改放在 WeakMap 中，不再往调用方的对象上写任何字段，可以直接作用在 Vue reactive / MobX observable 上，建文档不会触发更新
- 修改原语先完成登记再改数据，回滚时容忍观察者抛错，事务能完整回滚
- MobX / Valtio 在赋值时替换对象的情况：写入后读回实际存入的对象重新登记
- 新增 `batch` 选项（例如 MobX 的 `runInAction`），每个事务包进一次批处理
- 新增 `syncTo(store)` / `applyPatchTo(target, patch)`，把提交后的 JSON Patch 逐字段推给响应式数据
- 修复：用展开运算符复制出来的节点会被误认为文档中的元素

## 0.3.0 - 2026-11-01

**不兼容改动**

- 回调参数改为与 jQuery 一致的 `(index, value)`，`this` 指向元素：`attr('x', v => v + 1)` 需改为 `attr('x', (i, v) => v + 1)`；`each` / `map` / `filter` / `is` / `not` 同样改为 `(i, el)`
- `parents()` 改为由近到远排序
- `attr(name, null)` 改为删除字段，写入字面量 null 请用 `set`
- `append` 等传入文档中已有的元素时改为移动，不再复制
- `map` 改为返回数组（数组结果展开一层，丢弃 null），可再调用 `.get()`

**新增**

- 三种模式：`copy`（默认）/ `inplace` / `immutable`（结构共享快照 `doc.state`、提交事件 `e.state`）
- 遍历：`parentsUntil` `nextAll` `nextUntil` `prevAll` `prevUntil` `even` `odd` `addBack` `end` `index`
- 字段：`css` `text`，`removeClass()` 无参数清空
- 结构：`prependTo` `insertBefore` `insertAfter` `replaceAll` `detach` `clone` `wrap` `wrapAll` `wrapInner` `unwrap`；`doc.$({...})` 新建游离元素
- 插件扩展点 `jqson.fn`
- `docs/jquery-compat.md` jQuery 对照表；`help('modes')`、`help('jquery')`

## 0.2.0 - 2026-11-01

- 包名改为 `jqson`（原名 jsondom），命令行改为 `jqson`
- 内置自查：`help()` / `inspect()` / `explain()`，命令行 `jqson help | inspect | explain`
- 随包附带 Agent skill（`skills/jqson/SKILL.md`，`jqson skill` 输出）与 `AGENTS.md`

## 0.1.0 - 2026-10-31

- 首个版本：CSS 选择器查询、链式修改、事务回滚、校验器、撤销重做、JSON Patch 变更流、fork / merge、`parallel()`（Web Worker / worker_threads）、`runScript`、命令行
