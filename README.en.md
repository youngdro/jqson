# jqson

[中文](README.md) | English

**jQuery for JSON**: read and write any JSON with CSS selectors and jQuery-style chained methods, with transactions, validation, undo, a change stream, and parallel edits based on fork/merge. Zero dependencies; the same code runs in the **browser** and in **Node**.

```bash
npm i jqson          # or install globally for the CLI: npm i -g jqson && jqson help
```

```js
import jqson from 'jqson';

const doc = jqson(project);                       // deep-copies once and builds indexes
doc.$('segment#hook text').attr('style.color', '#ff3b30');
doc.$('text[zone=price-band]').addClass('pulse');
doc.$('#selling').append({ type: 'image', id: 'detail-3', src: 'c.png', start: 6, duration: 2 });
doc.undo();
```

The built-in help, error messages and the Agent skill are written in Chinese. The API, selectors and CLI output are language-neutral.

## 0. Built-in docs and self-discovery (for Agents)

The package ships its full usage docs and data-exploration commands, so an Agent can learn it after installing. See [AGENTS.md](AGENTS.md).

```bash
jqson help                      # overview and API list; jqson help <topic|API>, --json for structured output
jqson inspect data.json         # tags, fields (types and sample values), ids, classes, outline, suggested selectors
jqson explain "segment > text[start>=2]" data.json   # explanation + match count + paths; syntax errors show the position
```

```js
import { help, inspect, explain } from 'jqson';
help('attr');  help.json('parallel');  help.api();
inspect(doc);  doc.describe();  explain('text:has(> image)');
```

The repo and the npm package include an Agent skill (`skills/jqson/SKILL.md`) maintained with the code. To install it into a Claude Code project:

```bash
mkdir -p .claude/skills/jqson && jqson skill > .claude/skills/jqson/SKILL.md
```

CLI errors include a `hint` field that tells the Agent what to check next; misspelled `help` names get suggestions.

## 1. Model: how JSON becomes a "DOM"

- **Element**: an object with a `type` or `id` (`element: 'auto'`, the default). You can also set `element: 'all'` (every object is an element) or pass a function `(obj, key, parent) => boolean`. The root is always an element.
- **Tag**: the element's `type`; without one, the property name that holds it (the tag of `zones.hero` is `hero`).
- **Children**: the next level of elements found at any depth inside an element's objects and arrays. Plain objects and arrays in between are passed through, so both `{children:[...]}` and `{tracks:{main:[...]}}` work.
- **id / class**: the `id` field, and the `class` field (a space-separated string or an array). Rename them with `typeKey / idKey / classKey / childrenKey`.
- Internally there are id, tag and class indexes plus a parent pointer per node, so lookups by id or class and `closest` are constant-time.

## 2. Selectors

| Syntax | Meaning |
|---|---|
| `text` `#hook` `.big` `*` | tag / id / class / any |
| `[zone]` `[zone=hero]` `[text*=sale]` `[src^=http]` `[src$=.png]` `[class~=a]` `[lang\|=zh]` `[x!=1]` | attribute presence and comparison; an `i` suffix ignores case |
| `[start>=2]` `[duration<1.5]` | numeric comparison |
| `[style.fontSize>40]` `[motion.preset=pulse]` | dot paths into nested fields |
| `a b` `a > b` `a + b` `a ~ b` `a, b` | descendant, child, adjacent, sibling, union |
| `:first-child` `:last-child` `:only-child` `:nth-child(2n+1)` `:nth-last-child(1)` | position |
| `:first` `:last` `:root` `:empty` | same as `:first-child`/`:last-child`, root, no child elements (use `.first()`/`.last()` for the ends of a result set) |
| `:not(...)` `:is(...)` `:where(...)` `:has(...)` `:has(> text)` | logic and relations |
| `:key(hero)` | match by the owning property name |

Parsed selectors are cached. Complex selectors starting with `#id` expand from that node instead of scanning the whole tree.

## 3. Selection API (aligned with jQuery)

Method names, arguments and callbacks follow jQuery: callbacks are `function (index, element)` with `this` set to the element; getters return the first element's value; setters return the Selection for chaining. The full comparison is in [docs/jquery-compat.md](docs/jquery-compat.md).

Query: `doc.$(selector | node | nodes, scope?)`, `doc.get(sel)` (first node), `doc.byId(id)`, `doc.matches(node, sel)`.

Traversal: `find` `children` `parent` `parents` `parentsUntil` `closest` `siblings` `next` `nextAll` `nextUntil` `prev` `prevAll` `prevUntil` `filter` `not` `is` `has` `eq` `first` `last` `even` `odd` `slice` `add` `addBack` `end` `index`

Reading: `length` `get(i)` `toArray()` `each(fn)` `map(fn)` `attr(path)` `css(name)` `text()` `hasClass(c)`, plus the extensions `pluck(path)` `json()` `paths()`

Writing (each call is one transaction and updates the indexes):

```js
s.attr('style.fontSize', 48)                  // dot path
s.attr('start', (i, old) => old + 0.5)        // like jQuery: (index, oldValue), this = element
s.attr({ zone: 'hero', duration: 2 })
s.attr('motion', null)                        // null removes the field; use s.set to write a literal null
s.css('font-size', 48) / s.css({ color: '#fff' })   // read/write the style sub-object
s.text('New copy')
s.addClass('a b') / s.removeClass() / s.toggleClass('a', true)
s.append(content, key?) / s.prepend / s.before / s.after
s.appendTo(target) / s.prependTo / s.insertBefore / s.insertAfter
s.remove(sel?) / s.empty() / s.replaceWith(v) / s.replaceAll(target)
s.clone().attr('id', 'b').insertAfter('#a')   // copy, change, insert
doc.$({ type: 'image', id: 'logo' }).appendTo('#hero')   // create an element
s.wrapAll({ type: 'group', id: 'g1' }) / s.wrap / s.wrapInner / s.unwrap()
s.set(path, value) / s.merge(obj, path?) / s.insert(content)   // jqson extensions
```

- `append` puts content into `children` (created if missing); the second argument names another array field.
- Appending an element that is already in the document **moves** it; with several targets the earlier ones get clones (as in jQuery).
- Plugins: `jqson.fn.shift = function (dt) { return this.attr('start', (i, v) => v + dt) }`.

## 3.1 Three modes

```js
jqson(data)                          // mode: 'copy' (default): one deep copy, the input is untouched
jqson(data, { mode: 'inplace' })     // edits the object you pass; only one copy of the data; afterwards change it only through jqson
jqson(data, { mode: 'immutable' })   // copy + structurally shared immutable snapshots
```

In `immutable` mode `doc.state` starts as the `data` you passed. After each commit only the objects on the changed paths get new references; everything else is shared with the previous snapshot. This suits frameworks that compare by reference, such as React and Vue:

```js
const doc = jqson(project, { mode: 'immutable' });
doc.on((e) => setState(e.state));    // e.state is doc.state
doc.$('#point-1').text('Sugar free'); // only #point-1, #selling and the root are new objects
```

`doc.snapshot()` / `doc.state` work in every mode; with `freeze: true` the new objects are frozen.

## 3.2 With Vue, MobX and other reactive data

The recommended setup lets jqson own its data and pushes each commit to the reactive object field by field as a JSON Patch:

```js
const doc = jqson(toRaw(state));                // Vue; for MobX use toJS(store)
doc.syncTo(state);                              // Vue
doc.syncTo(store, { batch: runInAction });      // MobX: one reaction per commit, no strict-mode warnings
```

Only fields that really changed trigger updates, observers never see a transaction's intermediate state, and jqson's reads do not go through the proxy.

You can also work directly on the reactive object with `inplace`: `jqson(state, { mode: 'inplace' })`, plus `batch: runInAction` for MobX. This mode writes no internal fields onto your objects (metadata lives in WeakMaps), so building the document triggers no updates. It also handles MobX and Valtio replacing an object with a proxied copy on assignment, and a transaction rolls back completely when an observer throws. The cost is that every read goes through the proxy, so it is slower than `syncTo`.

Tested with @vue/reactivity 3.5 and MobX 6.13. See `jqson help reactive`.

## 4. Transactions, validation, undo, listeners

```js
const { patch, version } = doc.transaction(() => {
  doc.$('text').attr('style.color', '#fff');
  doc.$('#old').remove();
}, { by: 'agent' });                      // a throw rolls everything back

doc.use(({ doc, touched, patch }) => errors);   // validator: a non-empty array rolls back and throws ValidationError
doc.undo(); doc.redo();                          // per transaction; history defaults to 200
doc.on(e => e.patch);                            // RFC 6902 JSON Patch for each commit
doc.watch('text[zone=price-band]', e => {});     // fires only when matching elements change
doc.applyPatch(patch);                           // replays add/remove/replace/move/copy/test
```

`examples/video-lint.js` is a validator for video projects: zones exist, durations > 0, per-zone copy length limits, no overlapping text timing within a zone.

## 5. Parallel: fork / merge / parallel

```js
const a = doc.fork();   // independent copy, edited separately
a.$('#hook-title').attr('text', 'Summer must-have');
doc.merge(a, { policy: 'throw' | 'skip' | 'force' });
```

On merge, each operation is replayed relative to its **nearest ancestor with a unique id**, so siblings that others inserted or removed in the main document do not shift the edit to the wrong place.

Conflict rules:

- Same path, or one path is a prefix of the other (changing `style` vs `style.color`) → conflict
- Both sides **append** to the same array → no conflict, appended in order
- One side removed a subtree the other side changed → conflict
- `throw` throws a `ConflictError` with the conflict list, `skip` skips the whole conflicting task, `force` overwrites

`parallel(doc, tasks, opts)` runs several tasks at once and merges them in turn afterwards:

```js
import { parallel, createPool } from 'jqson';

const reports = await parallel(doc, [
  // function task: current thread, its own fork; good for waiting on models or the network (I/O concurrency)
  async (fork) => fork.$('#hook-title').attr('text', await llm('rewrite the title')),
  // script task: runs in a worker thread; good for CPU-heavy bulk rewrites
  { script: "$('text').css('fontSize', (i, v) => Math.round(v * 1.1))" },
  { script: "$('image').attr('opacity', args.o)", args: { o: 0.9 } },
], { policy: 'skip', order: 'task' | 'finish', threads: 4 });
// reports[i] = { index, ok, applied, conflicts, error, result }
```

- Browsers use a module `Web Worker`, Node uses `worker_threads`; both start from `src/worker.js`.
- For repeated calls pass `pool: await createPool({ size })` to reuse threads; workers cache the document per version, so data is sent once.
- For script tasks, `doc.options.element` cannot be a function (it cannot cross threads).

## 6. Three ways for an Agent to make changes

Ordered by safety. **Use declarative commands whenever they can express the change**; use JSON Patch to exchange changes with other systems; use scripts only when neither works and the code comes from a trusted source. All three are atomic, all can run validators, and a failure leaves no changes.

| Approach | Runs code | Flexibility | Best for |
|---|---|---|---|
| Declarative `exec` | No: pure JSON, method allowlist | Covers most edits | The default; tool calling (function calling) |
| JSON Patch `patch` | No | Path-based edits only | Exchanging changes with other systems, line-by-line review |
| Script `run` / `runScript` | **Yes, no sandbox** | Any logic | Complex computation in a trusted environment |

### 6.1 Declarative commands: exec (recommended)

Each command selects elements with `"$"`, asserts the count with `"expect"`, then names the methods to call and their arguments (arguments must be JSON):

```json
[
  { "$": "lottie[zone=price-band]", "expect": 1, "attr": ["fields.price", "$29"] },
  { "$": "text.caption", "css": { "fontSize": { "$mul": 1.1, "$round": 0 } } },
  { "$": "#point-1", "do": [["text", { "$suffix": "!" }], ["addClass", "hl"]] },
  { "$": { "type": "image", "id": "logo", "src": "logo.png" }, "insertAfter": "#hero-shot" },
  { "$": "#point-1, #point-2", "wrapAll": { "type": "group", "id": "g1" } },
  { "$": "#selling > image", "remove": true },
  { "$": "segment", "pluck": "id" }
]
```

- Shorthand: the key is the method name and the value its arguments. An array is the argument list, `true` means no arguments, any other value is the single argument. To pass one array as the only argument, write `[[...]]`.
- Chaining: `"do": [["find", "> text"], ["attr", "start", 1], ["addClass", "a"]]` runs in order.
- Computing from the old value: value operators `{"$add": n}` `{"$mul": n}` `{"$round": digits}` `{"$prefix": s}` `{"$suffix": s}` `{"$replace": [old, new]}` `{"$default": v}`, which can be combined.
- Reading: `pluck` `count` `paths` `json` `index` `is` `hasClass`, and read-only calls such as `"attr": "path"` or `"text": []`; results go to `results[i].value`.
- Not allowed: methods that need functions (`each`, `map`), unknown methods and unknown `$` operators. Each fails with the index of the offending command.

```bash
jqson exec project.json cmds.json --dry-run          # preview the patch first
jqson exec project.json cmds.json --lint rules.js --write
echo '[{"$":"#hook","attr":["x",1]}]' | jqson exec project.json -
jqson schema                                          # JSON Schema, ready to use as a tool's parameter definition
```

```js
const { results, patch } = doc.exec(commands, { dryRun: true });
import { execSchema } from 'jqson';   // tool definition to give the model
```

**Example: reprice a product video and highlight the selling points**

```json
[
  { "$": "lottie#price-tag", "expect": 1, "attr": { "fields.price": "$29", "fields.was": "$59" } },
  { "$": "#offer > text", "expect": 1, "do": [["text", "Today only $29"], ["addClass", "pulse"]] },
  { "$": "#selling > text", "expect": 2, "css": { "color": "#ffe14d" }, "attr": ["motion.preset", "pop-in"] },
  { "$": "#offer > *", "attr": ["start", { "$add": 0.5 }] }
]
```

**Example: add a transition at the start of each segment and group related points**

```json
[
  { "$": "segment", "expect": 3, "prepend": { "type": "lottie", "src": "presets/wipe.json", "start": 0, "duration": 0.3 } },
  { "$": "#detail-1, #point-1", "wrapAll": { "type": "group", "id": "sp-1" } }
]
```

### 6.2 JSON Patch

Standard RFC 6902. Get the paths with `jqson query <file> <sel> --paths`, then write the patch:

```bash
jqson query project.json "#point-1" --paths      # → ["/children/1/children/1"]
jqson patch project.json changes.json --out next.json
```

```json
[{ "op": "replace", "path": "/children/1/children/1/text", "value": "Sugar free" }]
```

Every commit's changes are also available from `doc.on(e => e.patch)` or `--patch out.json`, for review, replay or syncing to other systems.

### 6.3 Scripts (trusted environments only)

```js
import { runScript } from 'jqson';
await runScript(doc, `
  for (const seg of $('segment')) {
    const texts = $(seg).find('text');
    texts.attr('start', (i, v) => +(v + i * 0.1).toFixed(2));
  }
  return $('text').length;
`, { args: {} });   // runs on a fork and merges only if it all succeeds (atomic)
```

Scripts can use `$`, `doc` and `args`, and can `await`. Use them for loops, conditions and complex computation.

> **Security note**: `runScript`, the script tasks of `parallel`, and `jqson run` execute arbitrary JavaScript with **no sandbox**. The code has the same permissions as the current process (or worker) and can read and write files and use the network. Only run code you trust, such as scripts your own Agent generates in a controlled environment; never run code taken directly from user input or third parties. When you need isolation, run it in a container, a restricted child process or a browser iframe.

## 7. Command line

```bash
jqson help [topic|API] [--json]
jqson inspect examples/video-project.json
jqson explain "segment > text" examples/video-project.json
jqson query examples/video-project.json "text[zone=caption-band]" --pluck text
jqson exec  project.json cmds.json [--ops json] [--dry-run] [--lint rules.js] [--write | --out file] [--patch file]
jqson schema
jqson run   project.json edit.js -e "$('video').attr('muted', true)" --lint examples/video-lint.js --write
jqson run   project.json a.js b.js --parallel --threads 4 --patch out.patch.json
jqson patch project.json out.patch.json --out next.json
```

Output is always one line of JSON (`ok`, `count`/`values`, `changes`, `conflicts`, `ms`). On failure the exit code is 1, with `errors` (validation), `conflicts`, or `command` (the index of the failing exec command), plus a `hint` saying what to check next.

## 8. In the browser and with bundlers

```html
<script type="module">
  import jqson, { parallel } from './jqson/src/index.js';
</script>
```

The source is plain ESM. Node-only modules are imported dynamically in the Node branch only, so browsers never load them. Workers are created with `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, which bundlers emit as a separate file with its dependencies:

- **Vite**: `vite build` needs no configuration. The dev server pre-bundles dependencies and then cannot find the worker file, so exclude jqson:
  ```js
  // vite.config.js
  export default { optimizeDeps: { exclude: ['jqson'] } };
  ```
- **webpack 5**: no configuration needed. If your entry uses top-level await, enable `experiments.topLevelAwait` (on by default since webpack 5.83).

All three setups (Vite build, Vite dev, webpack 5 build) are tested running parallel script tasks in Chromium; reproduce with `npm run test:bundlers`. Features that do not use workers (queries, edits, exec, transactions, function tasks) are unaffected by how you bundle.

## 9. Performance (Node 22, one machine)

| Operation | 2,000 elements | 100,000 elements |
|---|---|---|
| Build document (deep copy + indexes) | 8 ms | 280 ms |
| `#id` query | 0.03 ms | 0.04 ms |
| `.class` query | 0.6 ms | 15 ms |
| `text[style.fontSize>55]` (full scan) | 1.4 ms | 13 ms |
| `#s42 > .caption[motion.preset=pulse]` | <0.01 ms | 0.5 ms |
| Bulk attribute change in one transaction | 400 in 2 ms | 20,000 in 75 ms |
| fork | 5 ms | 280 ms |
| Merge a fork that changed 500 elements | 26 ms | 316 ms |
| 8 worker script tasks (4 threads, incl. transfer and merge) | 155 ms | 3.7 s |

Notes:

- Indexed queries (id, class, starting with `#id`) are fast. Attribute scans cost about 6–7× a hand-written JS loop, in exchange for readable selectors and automatic indexes.
- On large documents the main cost of fork and worker parallelism is **copying data** (deep copy or structured clone across threads). Product video projects usually have hundreds to a few thousand elements, where parallel overhead is around a hundred milliseconds.
- For I/O tasks such as waiting on a model, function tasks are enough and need no worker. Only CPU-heavy bulk rewrites are worth sending to workers.

Run: `npm test`, `npm run test:browser`, `npm run test:bundlers`, `npm run typecheck`, `npm run bench [segments] [elements per segment]`.

## 10. Files

```
src/selector.js   selector parser
src/doc.js        JsonDoc, Selection, transactions, indexes, undo, fork/merge, conflict detection
src/parallel.js   parallel(), createPool()
src/script.js     runScript(), compileScript()
src/worker.js     worker entry shared by browsers and Node
src/help.js       built-in docs help(), data overview inspect(), selector explanation explain()
src/exec.js       exec(): declarative commands and JSON Schema
src/sync.js       syncTo(), applyPatchTo(): sync to Vue / MobX and other reactive data
bin/jqson.js      command line
types/            TypeScript declarations
skills/jqson/     the Agent skill shipped with the package
examples/         example video project and validator
docs/             jQuery comparison and other docs
```

## License

MIT
