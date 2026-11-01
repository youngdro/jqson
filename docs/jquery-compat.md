# jqson 与 jQuery API 对照

jqson 的目标是让熟悉 jQuery 的人和 Agent 不用重新学：同名方法的参数、返回值、回调形式都与 jQuery 一致。JSON 里没有对应概念的部分不提供，并给出替代写法。

图例：✅ 一致　⚠️ 保留但有差异　➕ jqson 扩展　❌ 不提供

## 通用约定

| 约定 | jQuery | jqson |
|---|---|---|
| 入口 | `$(selector, context)` | `doc.$(selector, scope)` ✅ |
| 新建元素 | `$('<div>')` | `doc.$({ type: 'image', ... })` ⚠️ 传 JSON 对象，得到游离元素 |
| 回调参数 | `function (index, element)`，`this` 为元素 | ✅ 相同 |
| setter 函数参数 | `function (index, oldValue)` | ✅ 相同（第三个参数额外给元素） |
| 函数返回 `undefined` | 不修改 | ✅ 相同 |
| getter 作用对象 | 第一个元素 | ✅ 相同 |
| 链式调用 | setter 返回 jQuery 对象 | ✅ 返回 Selection |
| 插入已有元素 | 移动；多目标时除最后一个外克隆 | ✅ 相同 |
| `parents` / `prevAll` 顺序 | 由近到远 | ✅ 相同 |
| 插件 | `$.fn.xxx` | `jqson.fn.xxx` ✅ |

## 遍历

| jQuery | jqson | 说明 |
|---|---|---|
| `find` `children` `parent` `parents` `parentsUntil` `closest` | ✅ | `find` 支持 `> text` 这类相对选择器 |
| `siblings` `next` `nextAll` `nextUntil` `prev` `prevAll` `prevUntil` | ✅ | |
| `filter` `not` `is` `has` | ✅ | 支持选择器、函数、元素、Selection |
| `eq` `first` `last` `even` `odd` `slice` | ✅ | |
| `add` `addBack` `end` | ✅ | |
| `index` | ✅ | 三种调用形式都支持 |
| `contents` | ❌ | JSON 没有文本节点，用 `children()` |
| `offsetParent` | ❌ | 无布局概念 |

## 读取

| jQuery | jqson | 说明 |
|---|---|---|
| `length` `get` `toArray` | ✅ | `get(i)` 支持负数 |
| `each` | ✅ | 返回 `false` 提前结束 |
| `map` | ⚠️ | 直接返回数组（同样展开一层、丢弃 null），也能 `.get()` |
| — | ➕ `pluck(path)` | 取字段值数组，如 `pluck('style.fontSize')` |
| — | ➕ `json()` `paths()` | 深拷贝 / JSON Pointer 路径 |

## 字段

| jQuery | jqson | 说明 |
|---|---|---|
| `attr` | ⚠️ | 读写任意字段，支持点路径 `style.color`；`attr(name, null)` 删除字段（同 jQuery）。要写入字面量 null 用 `set` |
| `removeAttr` | ✅ | 空格分隔可删多个 |
| `css` | ⚠️ | 读写 `style` 子对象（字段名可配 `styleKey`）；`font-size` 与 `fontSize` 都行；值为 `''` 时删除 |
| `text` | ⚠️ | 读：拼接匹配元素及后代的 `text` 字段（可配 `textKey`）；写：只设文字字段，不清空子元素 |
| `addClass` `removeClass` `toggleClass` `hasClass` | ✅ | 支持函数形式；`removeClass()` 无参数清空 |
| `prop` `removeProp` | ❌ | JSON 不区分 attribute 与 property，用 `attr` |
| `data` `removeData` | ❌ | 数据就是 JSON 本身，用 `attr` |
| `val` | ❌ | 无表单概念，用 `attr` |
| `html` | ❌ | 用 `json()` 读、`replaceWith` / `append` 写 |
| — | ➕ `set(path, value)` | 原样写入（null 照写，函数不求值） |
| — | ➕ `merge(obj, path?)` | 浅合并 |

## 结构

| jQuery | jqson | 说明 |
|---|---|---|
| `append` `prepend` | ⚠️ | 第二个参数是目标数组字段名（默认 `children`，不存在会创建）；多个内容用数组传入 |
| `appendTo` `prependTo` `insertBefore` `insertAfter` | ✅ | 返回插入后的元素 |
| `before` `after` | ✅ | 元素需要位于数组中 |
| `replaceWith` `replaceAll` | ✅ | 位于对象属性上的元素只能替换为一个值 |
| `remove` `empty` | ✅ | |
| `detach` | ⚠️ | 与 `remove` 相同，JSON 没有事件和数据需要保留 |
| `clone` | ✅ | 得到游离元素，可继续修改后插回 |
| `wrap` `wrapAll` `wrapInner` `unwrap` | ⚠️ | wrapper 是 JSON 对象（或选择器、元素、函数），内容放进它的 `children`；`wrapAll` 适合把多个片段编成一组 |
| — | ➕ `insert(content, key?)` | 同 `append`，返回新插入的元素 |

## 不提供的模块

| jQuery | 原因 | jqson 中怎么做 |
|---|---|---|
| 事件 `on` `off` `one` `trigger` `click` … | 数据没有用户交互 | 监听改动用 `doc.on(fn)` 或 `doc.watch(selector, fn)` |
| 动画 `animate` `show` `hide` `fade*` `slide*` `queue` | 无渲染 | 动效写进数据字段，如 `attr('motion', {...})`；以后可能对接 motion 协议 |
| 尺寸位置 `width` `height` `offset` `position` `scrollTop` | 无布局 | 用 `attr` 读写对应字段 |
| `ajax` `get` `post` `load` | 与 JSON 操作无关 | 用 `fetch` |
| `Deferred` `when` `promise` | 已有原生方案 | 用 `Promise` / `async` |
| `$.each` `$.map` `$.extend` `$.isPlainObject` … | 已有原生方案 | 用原生 JS；合并字段用 `merge` |
| `serialize` `serializeArray` | 无表单 | 用 `doc.toJSON()` |
| `noConflict` `holdReady` `ready` | 不需要 | — |

## jqson 独有

- 事务：`doc.transaction(fn)`，出错整体回滚
- 校验：`doc.use(validator)`，校验不过就不生效
- 撤销重做：`doc.undo()` / `doc.redo()`
- 变更流：`doc.on(e => e.patch)` 输出 JSON Patch，`doc.applyPatch(patch)` 回放
- 不可变快照：`mode: 'immutable'` 加 `doc.state`，结构共享
- 并行：`doc.fork()` / `doc.merge()` / `parallel()`
- 自查：`help()` / `inspect()` / `explain()`

## 从 0.2 升级的不兼容改动

- 回调参数从 `(value, node, i)` 改为 jQuery 的 `(i, value)`：`attr('x', v => v + 1)` 要写成 `attr('x', (i, v) => v + 1)`。`each` / `map` / `filter` / `is` / `not` 也改为 `(i, el)`。
- `parents()` 的顺序改为由近到远。
- `attr(name, null)` 改为删除字段，写字面量 null 用 `set`。
- `append` 等传入文档里已有的元素时改为移动，不再复制。
