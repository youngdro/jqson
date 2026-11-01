// JsonDoc：把一份 JSON 当作 DOM 来查询和修改。
//
// - 元素：带 type 或 id 字段的对象（可配置），根对象总是元素。
//   元素之间的嵌套关系穿透普通对象和数组：{type:'track', clips:[{type:'clip'}]} 中 clip 是 track 的子元素。
// - 查询：CSS 选择器，id/type/class 三个索引加速。
// - 修改：所有写操作走同一组原语，自动维护索引、记录 JSON Patch、支持事务回滚和撤销/重做。
// - 并行：fork 出副本独立修改，merge 时按 id 锚点重放并做冲突检测。

import { parseSelector, parseRelativeSelector, nthMatches } from './selector.js';

const isObj = (v) => v !== null && typeof v === 'object';
// 纯 JSON 的深拷贝，比 structuredClone 快数倍
export function cloneJson(v) {
  if (!isObj(v)) return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneJson(v[i]);
    return out;
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneJson(v[k]);
  return out;
}
const copy = cloneJson;
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const unesc = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');

const DEFAULTS = {
  typeKey: 'type',
  idKey: 'id',
  classKey: 'class',
  childrenKey: 'children',
  styleKey: 'style', // css() 读写的字段
  textKey: 'text', // text() 读写的字段
  element: 'auto', // 'auto' | 'all' | (obj, key) => boolean
  // mode：
  //   'copy'      默认。构造时深拷贝输入，原数据不受影响
  //   'inplace'   直接接管并修改传入的对象（省一次拷贝；之后不要绕过 jqson 修改它）
  //   'immutable' 同 copy，另外 doc.state / snapshot() 提供结构共享的不可变快照，
  //               每次提交只有改动路径上的对象换新引用，适合 React 等按引用比较的框架
  history: 200, // 撤销栈深度，0 关闭
  freeze: false, // snapshot() 产出的新对象是否 Object.freeze
  batch: null, // (run) => run() 的包装，例如 MobX 的 runInAction；inplace 作用在 observable 上时使用
};
const MODES = ['copy', 'inplace', 'immutable'];

export class ValidationError extends Error {
  constructor(errors) {
    super(`Validation failed: ${errors.map((e) => e.message || String(e)).join('; ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export class ConflictError extends Error {
  constructor(conflicts) {
    super(`Merge conflict on ${conflicts.length} change(s): ${conflicts.slice(0, 3).map((c) => c.path).join(', ')}`);
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}

let docSeq = 0;

export class JsonDoc {
  constructor(data, options = {}) {
    if (!isObj(data) || Array.isArray(data)) throw new TypeError('JsonDoc root must be a JSON object');
    const mode = options.mode ?? (options.clone === false ? 'inplace' : 'copy');
    if (!MODES.includes(mode)) throw new TypeError(`mode must be one of ${MODES.join(' | ')}`);
    this.options = { ...DEFAULTS, ...options, mode, clone: mode !== 'inplace' };
    this.key = `doc${++docSeq}-${Math.random().toString(36).slice(2, 8)}`;
    this.version = 0;

    // 内部元数据：父指针、元素登记、快照对应对象。
    // - copy / immutable：对象是 jqson 自己创建的，元数据直接挂在私有 Symbol 属性上，最快
    // - inplace：对象属于调用方（可能是 Vue / MobX 代理或冻结对象），元数据放在 WeakMap 里，
    //   不往对象上写任何东西，也不经过代理的拦截器
    if (mode === 'inplace') {
      const up = new WeakMap();
      const el = new WeakMap();
      const pub = new WeakMap();
      this._up = { get: (x) => up.get(x), set: (x, v) => void up.set(x, v), has: (x) => up.get(x) !== undefined, delete: (x) => void up.delete(x) };
      this._isEl = { has: (x) => isObj(x) && el.has(x), add: () => {}, delete: (x) => void el.delete(x) };
      this._elKeys = { get: (x) => el.get(x), set: (x, v) => void el.set(x, v), delete: (x) => void el.delete(x) };
      this._pub = { get: (x) => pub.get(x), set: (x, v) => void pub.set(x, v) };
    } else {
      const UP = Symbol('up'); // 对象/数组 -> { owner, key }，数组成员 key 为 null
      const EL = Symbol('el'); // 元素 -> 已登记的 { tag, id, classes }
      const PUB = Symbol('pub'); // 对象/数组 -> 它在不可变快照中的对应对象（失效时为 undefined）
      this._up = { get: (x) => x[UP], set: (x, v) => (x[UP] = v), has: (x) => x[UP] !== undefined, delete: (x) => (x[UP] = undefined) };
      this._isEl = { has: (x) => isObj(x) && x[EL] !== undefined, add: () => {}, delete: (x) => (x[EL] = undefined) };
      this._elKeys = { get: (x) => x[EL], set: (x, v) => (x[EL] = v), delete: (x) => (x[EL] = undefined) };
      this._pub = { get: (x) => x[PUB], set: (x, v) => (x[PUB] = v) };
    }
    this._byId = new Map();
    this._byTag = new Map();
    this._byClass = new Map();
    this._count = 0;
    this._struct = 0; // 结构版本，用于子元素和文档顺序缓存
    this._kids = new WeakMap();
    this._orderCache = null;

    this._tx = null;
    this._log = []; // 已提交的事务：{ version, ops }
    this._undo = [];
    this._redo = [];
    this._listeners = new Set();
    this._watchers = [];
    this._validators = [];
    this._base = null; // fork 来源

    this._seed = mode === 'immutable'; // 不可变模式：初始快照直接复用输入对象
    this.root = this._adopt(data, null, null, this.options.clone, true);
    this._seed = false;
  }

  // ---------- 不可变快照 ----------

  /**
   * 结构共享的不可变快照：未改动的子树复用上一次快照的对象，改动路径上的对象换新引用。
   * immutable 模式下初始快照就是传入的原对象。任何模式都可以调用。
   */
  snapshot() {
    const pub = this._pub;
    const freeze = this.options.freeze;
    const build = (v) => {
      if (!isObj(v)) return v;
      const hit = pub.get(v);
      if (hit !== undefined) return hit;
      let out;
      if (Array.isArray(v)) {
        out = new Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = build(v[i]);
      } else {
        out = {};
        for (const k of Object.keys(v)) out[k] = build(v[k]);
      }
      if (freeze) Object.freeze(out);
      pub.set(v, out);
      return out;
    };
    return build(this.root);
  }

  /** 当前不可变快照，等同 snapshot() */
  get state() {
    return this.snapshot();
  }

  // 容器内容变化：沿父链让快照失效（遇到已失效的祖先即停止，祖先必然也已失效）
  _dirty(x) {
    const pub = this._pub;
    while (x && pub.get(x) !== undefined) {
      pub.set(x, undefined);
      x = this._up.get(x)?.owner;
    }
  }

  // ---------- 查询 ----------

  /** 选择元素：选择器字符串、元素对象、元素数组或 Selection */
  // 传入不在文档里的 JSON 对象（或其数组）时，得到可修改后再插入文档的游离元素，类似 jQuery 的 $('<div>')
  $(target, scope) {
    if (target instanceof Selection) return target.doc === this ? new Selection(this, target.nodes) : this._fragment(target.nodes);
    if (Array.isArray(target)) {
      const els = target.filter((n) => this._isEl.has(n));
      if (els.length || !target.length || target.some((n) => isObj(n) && this._up.has(n))) return new Selection(this, els);
      return this._fragment(target);
    }
    if (isObj(target)) {
      if (this._isEl.has(target) && this._attached(target)) return new Selection(this, [target]);
      if (this._attached(target)) return new Selection(this, []);
      return this._fragment([target]);
    }
    return new Selection(this, this._query(String(target), scope ? this.$(scope).nodes : null, false));
  }

  // 元素确实挂在文档里（排除用展开运算符复制出来、带着元数据的对象）
  _attached(n) {
    if (n === this.root) return true;
    const m = this._up.get(n);
    if (!m) return false;
    return m.key === null ? m.owner.includes(n) : m.owner[m.key] === n;
  }

  // 游离元素：放在一个临时文档里，修改照常可用；appendTo 等会把它们复制进宿主文档
  _fragment(values) {
    const host = this._host || this;
    const ck = this.options.childrenKey;
    const frag = new JsonDoc({ [ck]: values.filter(isObj) }, { ...this.options, mode: 'copy', history: 0, batch: null });
    frag._host = host;
    for (const n of frag.root[ck]) {
      if (!frag._isEl.has(n)) {
        frag._count++;
        frag._index(n);
      }
    }
    frag._struct++;
    return new Selection(frag, frag.root[ck].slice());
  }

  /** 第一个匹配元素（原始对象，只读使用） */
  get(selector) {
    return this._query(selector, null, false, true)[0] ?? null;
  }

  byId(id) {
    const hit = this._byId.get(String(id));
    if (hit === undefined) return null;
    return Array.isArray(hit) ? hit[0] : hit;
  }

  _idList(id) {
    const hit = this._byId.get(String(id));
    if (hit === undefined) return [];
    return Array.isArray(hit) ? hit : [hit];
  }

  matches(node, selector) {
    if (!this._isEl.has(node)) return false;
    return parseSelector(selector).some((cx) => this._matchComplex(node, cx, cx.length - 1, null));
  }

  get size() {
    return this._count;
  }

  toJSON() {
    return cloneJson(this.root);
  }

  /** JSON Pointer（RFC 6901）路径 */
  pointer(node) {
    const segs = [];
    let x = node;
    while (x !== this.root) {
      const m = this._up.get(x);
      if (!m) throw new Error('Node is not attached to this document');
      segs.push(esc(m.key === null ? m.owner.indexOf(x) : m.key));
      x = m.owner;
    }
    return segs.length ? '/' + segs.reverse().join('/') : '';
  }

  parentOf(node) {
    let o = this._up.get(node)?.owner;
    while (o && !this._isEl.has(o)) o = this._up.get(o)?.owner;
    return o || null;
  }

  childrenOf(node) {
    return this._kidsInfo(node).list;
  }

  tagOf(node) {
    const t = node[this.options.typeKey];
    if (typeof t === 'string') return t;
    if (node === this.root) return 'root';
    return this._ownerKey(node) ?? '';
  }

  idOf(node) {
    const v = node[this.options.idKey];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  }

  classesOf(node) {
    const v = node[this.options.classKey];
    if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
    return [];
  }

  // ---------- 事务、事件、校验 ----------

  /**
   * 同步事务：fn 内所有修改要么全部提交，要么全部回滚。
   * 嵌套调用会并入外层事务。返回 { result, patch, version }。
   */
  transaction(fn, meta = {}) {
    if (this._tx) return { result: fn(this), patch: null, version: this.version };
    // options.batch：把整个事务包进外部的批处理，例如 MobX 的 runInAction，观察者只在提交后反应一次
    const batch = this.options.batch;
    if (batch && !this._inBatch) {
      this._inBatch = true;
      try {
        return batch(() => this.transaction(fn, meta));
      } finally {
        this._inBatch = false;
      }
    }
    const tx = (this._tx = { ops: [], inv: [], touched: new Set() });
    let result;
    try {
      result = fn(this);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
        throw new Error('transaction() 只接受同步函数；异步任务请用 doc.fork() 或 parallel()');
      }
      if (tx.ops.length && this._validators.length) {
        const ctx = { doc: this, patch: tx.ops.map(publicOp), ops: tx.ops, touched: [...tx.touched] };
        const errors = [];
        for (const v of this._validators) {
          const r = v(ctx);
          if (r && r.length) errors.push(...r);
        }
        if (errors.length) throw new ValidationError(errors);
      }
    } catch (e) {
      this._rollback(tx);
      this._tx = null;
      throw e;
    }
    this._tx = null;
    if (!tx.ops.length) return { result, patch: [], version: this.version };

    const version = ++this.version;
    this._log.push({ version, ops: tx.ops });
    if (this.options.history && !meta.skipHistory) {
      this._undo.push(tx.inv);
      if (this._undo.length > this.options.history) this._undo.shift();
      if (!meta.keepRedo) this._redo.length = 0;
    }
    const patch = tx.ops.map(publicOp);
    const event = { version, patch, ops: tx.ops, touched: [...tx.touched].filter((n) => this._up.has(n) || n === this.root), meta };
    Object.defineProperty(event, 'state', { get: () => this.snapshot() }); // 结构共享快照，按需计算
    for (const fn of this._listeners) fn(event);
    if (this._watchers.length) this._notifyWatchers(event);
    return { result, patch, version };
  }

  /** 订阅每次提交。返回取消函数。 */
  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 当匹配选择器的元素或其后代发生变化时回调（用于增量渲染）。 */
  watch(selector, fn) {
    const w = { selector, fn };
    this._watchers.push(w);
    return () => (this._watchers = this._watchers.filter((x) => x !== w));
  }

  /** 注册校验器：(ctx) => 错误数组。任何错误都会让事务回滚。 */
  use(validator) {
    this._validators.push(validator);
    return () => (this._validators = this._validators.filter((x) => x !== validator));
  }

  undo() {
    return this._history(this._undo, this._redo);
  }

  redo() {
    return this._history(this._redo, this._undo);
  }

  _history(from, to) {
    const inv = from.pop();
    if (!inv) return false;
    let back;
    try {
      const { patch } = this.transaction(() => {
        this._replay(inv);
        back = this._tx.inv.slice();
      }, { skipHistory: true });
      to.push(back);
      return patch;
    } catch (e) {
      from.push(inv);
      throw e;
    }
  }

  /** 应用 JSON Patch（RFC 6902），支持 add/remove/replace/move/copy/test。 */
  applyPatch(patch) {
    return this.transaction(() => {
      for (const op of patch) this._applyOp(op, false);
    });
  }

  // ---------- 并行：fork / merge ----------

  /** 复制出一份独立文档。修改 fork 不影响原文档，之后用 merge 合回。 */
  fork() {
    const f = new JsonDoc(this.root, { ...this.options, mode: 'copy', batch: null });
    f._base = { doc: this, version: this.version };
    return f;
  }

  /** 自 version 之后提交的全部操作（带锚点元数据）。 */
  opsSince(version) {
    const out = [];
    for (const e of this._log) if (e.version > version) out.push(...e.ops);
    return out;
  }

  /**
   * 合并一个 fork，或一组带元数据的操作 { ops, baseVersion }。
   * 操作按 id 锚点重放，所以别人插入或删除兄弟元素导致的下标变化不会错位。
   * policy：'throw'（默认，冲突抛 ConflictError）| 'skip'（冲突则不合并）| 'force'（忽略冲突）
   */
  merge(source, { policy = 'throw' } = {}) {
    let ops, baseVersion;
    if (source instanceof JsonDoc) {
      ops = source.opsSince(0);
      baseVersion = source._base?.version ?? 0;
    } else {
      ops = source.ops;
      baseVersion = source.baseVersion ?? 0;
    }
    if (!ops.length) return { applied: true, conflicts: [], version: this.version };
    const conflicts = baseVersion >= this.version ? [] : this._conflicts(ops, baseVersion);
    if (conflicts.length && policy !== 'force') {
      if (policy === 'skip') return { applied: false, conflicts, version: this.version };
      throw new ConflictError(conflicts);
    }
    const { version } = this.transaction(() => {
      for (const op of ops) this._applyOp(op, true);
    }, { kind: 'merge' });
    return { applied: true, conflicts, version };
  }

  // 冲突索引：按需追赶日志，记录每个路径键最近被哪个版本触及，merge 时只需查表
  _conflicts(ops, baseVersion) {
    const ix = (this._cix ||= { v: 0, full: new Map(), below: new Map(), killed: new Map(), anchored: new Map() });
    for (const e of this._log) {
      if (e.version <= ix.v) continue;
      for (const op of e.ops) {
        const t = touch(op);
        const r = { v: e.version, path: t.path };
        if (!t.append) ix.full.set(t.key, r);
        for (const p of t.prefixes) ix.below.set(p, r);
        for (const k of t.killed) ix.killed.set(k, r);
        if (t.id !== null) ix.anchored.set(t.id, r);
      }
      ix.v = e.version;
    }
    const after = (r) => (r !== undefined && r.v > baseVersion ? r : undefined);
    const out = [];
    for (const op of ops) {
      const o = touch(op);
      let hit;
      for (const p of o.prefixes) if ((hit = after(ix.full.get(p)))) break;
      if (!hit && !o.append) hit = after(ix.below.get(o.key));
      if (!hit && o.id !== null) hit = after(ix.killed.get(o.id));
      if (!hit) for (const k of o.killed) if ((hit = after(ix.anchored.get(k)))) break;
      if (hit) out.push({ path: o.path, theirs: hit.path });
    }
    return out;
  }

  // ---------- 内部：登记与索引 ----------

  _isElement(obj, key, isRoot) {
    if (isRoot) return true;
    const e = this.options.element;
    if (e === 'all') return true;
    if (typeof e === 'function') return !!e(obj, key);
    const t = obj[this.options.typeKey];
    const id = obj[this.options.idKey];
    return typeof t === 'string' || typeof id === 'string' || typeof id === 'number';
  }

  // 登记一棵子树（clone 为 true 时同时深拷贝），返回实际挂进文档的值
  _adopt(value, owner, key, clone, isRoot = false) {
    if (!isObj(value)) return value;
    if (!clone && (this._up.has(value) || value === this.root)) {
      throw new Error('The same object cannot appear twice in a JsonDoc');
    }
    this._struct++;
    return this._adoptRec(value, owner, key, clone, isRoot);
  }

  _adoptRec(v, owner, key, clone, isRoot) {
    const arr = Array.isArray(v);
    const out = clone ? (arr ? new Array(v.length) : {}) : v;
    if (owner) this._up.set(out, { owner, key });
    if (this._seed) this._pub.set(out, v);
    if (arr) {
      for (let i = 0; i < v.length; i++) {
        const c = v[i];
        if (isObj(c)) {
          const a = this._adoptRec(c, out, null, clone, false);
          if (clone) out[i] = a;
        } else if (clone) out[i] = c;
      }
      return out;
    }
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const c = v[k];
      if (isObj(c)) {
        const a = this._adoptRec(c, out, k, clone, false);
        if (clone) out[k] = a;
      } else if (clone) out[k] = c;
    }
    if (this._isElement(out, key, isRoot)) {
      this._count++;
      this._index(out);
    }
    return out;
  }

  _unregister(value) {
    if (!isObj(value)) return;
    this._struct++;
    const stack = [value];
    while (stack.length) {
      const v = stack.pop();
      this._up.delete(v);
      if (this._isEl.has(v)) {
        this._unindex(v);
        this._isEl.delete(v);
        this._count--;
      }
      for (const c of Array.isArray(v) ? v : Object.values(v)) if (isObj(c)) stack.push(c);
    }
  }

  _ownerKey(node) {
    const m = this._up.get(node);
    if (!m) return null;
    if (m.key !== null) return m.key;
    return this._up.get(m.owner)?.key ?? null;
  }

  _index(n) {
    const rec = { tag: this.tagOf(n), id: this.idOf(n), classes: this.classesOf(n) };
    this._elKeys.set(n, rec);
    addTo(this._byTag, rec.tag, n);
    if (rec.id !== null) {
      const hit = this._byId.get(rec.id);
      if (hit === undefined) this._byId.set(rec.id, n);
      else if (Array.isArray(hit)) hit.push(n);
      else this._byId.set(rec.id, [hit, n]);
    }
    for (const c of rec.classes) addTo(this._byClass, c, n);
  }

  _unindex(n) {
    const rec = this._elKeys.get(n);
    if (!rec) return;
    removeFrom(this._byTag, rec.tag, n);
    if (rec.id !== null) {
      const hit = this._byId.get(rec.id);
      if (hit === n) this._byId.delete(rec.id);
      else if (Array.isArray(hit)) {
        const rest = hit.filter((x) => x !== n);
        this._byId.set(rec.id, rest.length === 1 ? rest[0] : rest);
      }
    }
    for (const c of rec.classes) removeFrom(this._byClass, c, n);
    this._elKeys.delete(n);
  }

  _reindex(n) {
    this._unindex(n);
    this._index(n);
  }

  _kidsInfo(node) {
    let c = this._kids.get(node);
    if (c && c.v === this._struct) return c;
    const list = [];
    const stack = [];
    const push = (v) => {
      const vals = Array.isArray(v) ? v : Object.values(v);
      for (let i = vals.length - 1; i >= 0; i--) if (isObj(vals[i])) stack.push(vals[i]);
    };
    push(node);
    while (stack.length) {
      const v = stack.pop();
      if (this._isEl.has(v)) list.push(v);
      else push(v);
    }
    const pos = new Map();
    list.forEach((n, i) => pos.set(n, i));
    c = { v: this._struct, list, pos };
    this._kids.set(node, c);
    return c;
  }

  _order() {
    if (this._orderCache && this._orderCache.v === this._struct) return this._orderCache.map;
    const map = new WeakMap();
    const list = [];
    this._walk(this.root, (n) => {
      map.set(n, list.length);
      list.push(n);
    });
    this._orderCache = { v: this._struct, map, list };
    return map;
  }

  // 按文档顺序排序：结果占全文比例高时直接按顺序表过滤（O(N)），否则取一次序号再排数字
  _inDocOrder(nodes, set) {
    if (nodes.length < 2) return nodes;
    const order = this._order();
    const { list } = this._orderCache;
    if (nodes.length * 8 > list.length) {
      const has = set || new Set(nodes);
      const out = [];
      for (const n of list) if (has.has(n)) out.push(n);
      return out;
    }
    const keys = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) keys[i] = order.get(nodes[i]) * 4194304 + i;
    keys.sort();
    const out = new Array(nodes.length);
    for (let i = 0; i < keys.length; i++) out[i] = nodes[keys[i] % 4194304];
    return out;
  }

  // 按文档顺序遍历 start 及其后代元素；fn 返回 false 时停止
  _walk(start, fn, includeStart = true) {
    const stack = includeStart ? [start] : [...this._kidsInfo(start).list].reverse();
    while (stack.length) {
      const n = stack.pop();
      if (fn(n) === false) return;
      const kids = this._kidsInfo(n).list;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  _isDescendant(n, ancestor) {
    for (let p = this.parentOf(n); p; p = this.parentOf(p)) if (p === ancestor) return true;
    return false;
  }

  // ---------- 内部：选择器匹配 ----------

  _query(selector, scopes, relative, firstOnly = false) {
    const list = relative ? parseRelativeSelector(selector) : parseSelector(selector);
    const out = new Set();
    let needSort = false;
    for (const cx of list) {
      const last = cx[cx.length - 1].compound;
      let cands = null;
      // 选择器前段有 #id 且之后只有后代/子代组合符时，只在该元素子树里找
      let idRoots = null;
      if (!scopes && !last.ids.length) {
        for (let k = cx.length - 2; k >= 0; k--) {
          if (cx[k + 1].comb !== ' ' && cx[k + 1].comb !== '>') break;
          if (cx[k].compound.ids.length) {
            idRoots = this._idList(cx[k].compound.ids[0]);
            break;
          }
        }
      }
      if (last.ids.length) cands = new Set(this._idList(last.ids[0]));
      else if (last.classes.length) {
        for (const c of last.classes) {
          const s = this._byClass.get(c);
          if (!s) {
            cands = new Set();
            break;
          }
          if (!cands || s.size < cands.size) cands = s;
        }
      } else if (last.tag && last.tag !== '*') cands = this._byTag.get(last.tag);
      if (idRoots) cands = null;
      // 有作用域且索引候选很多时，直接遍历作用域子树更快
      if (cands && scopes && cands.size > 64) cands = null;

      if (cands) {
        if (!cands.size) continue;
        needSort = true;
        for (const n of cands) {
          if (out.has(n)) continue;
          if (scopes && !scopes.some((s) => this._isDescendant(n, s))) continue;
          if (this._matchScoped(n, cx, scopes)) out.add(n);
        }
      } else {
        const visit = (n) => {
          if (!out.has(n) && this._matchScoped(n, cx, scopes)) {
            out.add(n);
            if (firstOnly && list.length === 1) return false;
          }
        };
        if (scopes) for (const s of scopes) this._walk(s, visit, false);
        else if (idRoots) for (const s of idRoots) this._walk(s, visit, false);
        else {
          // 全文扫描：用缓存的文档顺序表，免去逐层取子元素
          this._order();
          for (const n of this._orderCache.list) if (visit(n) === false) break;
        }
        if (idRoots && idRoots.length > 1) needSort = true;
        if (list.length > 1) needSort = true;
      }
    }
    const arr = [...out];
    return needSort ? this._inDocOrder(arr, out) : arr;
  }

  _matchScoped(n, cx, scopes) {
    if (!scopes || cx[0].comb === null) return this._matchComplex(n, cx, cx.length - 1, null);
    return scopes.some((s) => this._matchComplex(n, cx, cx.length - 1, s));
  }

  _matchComplex(n, cx, idx, scope) {
    if (!this._matchCompound(n, cx[idx].compound)) return false;
    const comb = cx[idx].comb;
    if (idx === 0) {
      if (!comb || !scope) return true;
      if (comb === '>') return this.parentOf(n) === scope;
      if (comb === ' ') return this._isDescendant(n, scope);
      const sib = this._siblings(n);
      if (comb === '+') return sib.i > 0 && sib.list[sib.i - 1] === scope;
      return sib.list.slice(0, sib.i).includes(scope);
    }
    if (comb === '>') {
      const p = this.parentOf(n);
      return !!p && this._matchComplex(p, cx, idx - 1, scope);
    }
    if (comb === ' ') {
      for (let p = this.parentOf(n); p; p = this.parentOf(p)) if (this._matchComplex(p, cx, idx - 1, scope)) return true;
      return false;
    }
    const { list, i } = this._siblings(n);
    if (comb === '+') return i > 0 && this._matchComplex(list[i - 1], cx, idx - 1, scope);
    for (let j = i - 1; j >= 0; j--) if (this._matchComplex(list[j], cx, idx - 1, scope)) return true;
    return false;
  }

  _siblings(n) {
    const p = this.parentOf(n);
    if (!p) return { list: [n], i: 0 };
    const info = this._kidsInfo(p);
    return { list: info.list, i: info.pos.get(n) };
  }

  _matchCompound(n, c) {
    if (c.tag && c.tag !== '*' && this.tagOf(n) !== c.tag) return false;
    if (c.ids.length) {
      const id = this.idOf(n);
      if (!c.ids.every((x) => x === id)) return false;
    }
    if (c.classes.length) {
      const cls = this.classesOf(n);
      if (!c.classes.every((x) => cls.includes(x))) return false;
    }
    for (const a of c.attrs) if (!matchAttr(n, a)) return false;
    for (const p of c.pseudos) if (!this._matchPseudo(n, p)) return false;
    return true;
  }

  _matchPseudo(n, { name, arg }) {
    switch (name) {
      case 'root':
        return n === this.root;
      case 'empty':
        return this._kidsInfo(n).list.length === 0;
      case 'first':
      case 'first-child':
        return this._siblings(n).i === 0;
      case 'last':
      case 'last-child': {
        const s = this._siblings(n);
        return s.i === s.list.length - 1;
      }
      case 'only-child':
        return this._siblings(n).list.length === 1;
      case 'nth-child':
        return nthMatches(arg, this._siblings(n).i + 1);
      case 'nth-last-child': {
        const s = this._siblings(n);
        return nthMatches(arg, s.list.length - s.i);
      }
      case 'key':
        return this._ownerKey(n) === arg;
      case 'not':
        return !arg.some((cx) => this._matchComplex(n, cx, cx.length - 1, null));
      case 'is':
        return arg.some((cx) => this._matchComplex(n, cx, cx.length - 1, null));
      case 'has':
        return arg.some((cx) => {
          const comb = cx[0].comb || ' ';
          let cands;
          if (comb === '>') cands = this._kidsInfo(n).list;
          else if (comb === ' ') {
            cands = [];
            this._walk(n, (d) => void cands.push(d), false);
          } else {
            const s = this._siblings(n);
            cands = comb === '+' ? s.list.slice(s.i + 1, s.i + 2) : s.list.slice(s.i + 1);
          }
          return cands.some((d) => this._matchComplex(d, cx, cx.length - 1, n));
        });
      default:
        return false;
    }
  }

  // ---------- 内部：修改原语 ----------
  // 每个原语都会：维护登记和索引、记录一个带锚点的补丁操作、登记反向操作用于回滚和撤销。

  _auto(fn) {
    return this._tx ? fn() : this.transaction(fn).result;
  }

  _record(kind, container, key, value, old, inverse, extra = {}) {
    const tx = this._tx;
    if (!tx) throw new Error('internal: mutation outside transaction');
    const path = this.pointer(container) + '/' + esc(key);
    const op = { op: kind, path };
    if (kind !== 'remove') op.value = copy(value);
    op.meta = { anchor: this._anchor(container, key), ...extra };
    const killed = collectIds(old, this.options.idKey);
    if (killed.length) op.meta.killed = killed;
    tx.ops.push(op);
    tx.inv.push(inverse);
    const el = this._isEl.has(container) ? container : this.parentOf(container);
    if (el) tx.touched.add(el);
  }

  // 找到最近的带 id 的祖先元素，返回 { id, rel }，rel 是从它出发的路径段（含最终 key）
  _anchor(container, key) {
    const rel = [String(key)];
    let x = container;
    for (;;) {
      if (this._isEl.has(x)) {
        const id = this.idOf(x);
        if (id !== null && this._byId.get(id) === x) return { id, rel: rel.reverse() };
      }
      if (x === this.root) return { id: null, rel: rel.reverse() };
      const m = this._up.get(x);
      rel.push(String(m.key === null ? m.owner.indexOf(x) : m.key));
      x = m.owner;
    }
  }

  // 每个原语都先做完登记、记录和反向操作，最后才真正修改数据。
  // 这样即使数据是 Vue / MobX 等代理、它们的观察者在修改时同步抛错，事务也能完整回滚。
  _set(container, key, value, raw = false) {
    const arr = Array.isArray(container);
    if (arr) {
      key = Number(key);
      if (!(key >= 0 && key < container.length)) throw new RangeError(`Index ${key} out of range`);
    }
    const had = arr || Object.prototype.hasOwnProperty.call(container, key);
    const old = container[key];
    if (isObj(old)) this._unregister(old);
    const v = this._adopt(value, container, arr ? null : key, !raw);
    this._record(had ? 'replace' : 'add', container, key, v, had ? old : undefined,
      had ? { t: 'set', c: container, k: key, v: old } : { t: 'del', c: container, k: key });
    this._dirty(container);
    const reindex = !arr && this._isEl.has(container) && this._indexKeys().has(key);
    if (reindex) this._unindex(container);
    try {
      container[key] = v;
      this._settle(container, key, v, arr);
    } finally {
      if (reindex) this._index(container);
    }
  }

  _del(container, key) {
    if (Array.isArray(container)) return this._remove(container, Number(key));
    if (!Object.prototype.hasOwnProperty.call(container, key)) return;
    const old = container[key];
    this._record('remove', container, key, undefined, old, { t: 'set', c: container, k: key, v: old });
    if (isObj(old)) this._unregister(old);
    this._dirty(container);
    const reindex = this._isEl.has(container) && this._indexKeys().has(key);
    if (reindex) this._unindex(container);
    try {
      delete container[key];
    } finally {
      if (reindex) this._index(container);
    }
  }

  _insert(arr, index, value, raw = false) {
    if (index < 0 || index > arr.length) throw new RangeError(`Index ${index} out of range`);
    const v = this._adopt(value, arr, null, !raw);
    const append = index === arr.length;
    this._record('add', arr, index, v, undefined, { t: 'rm', c: arr, k: index }, append ? { append: true } : {});
    this._dirty(arr);
    this._struct++;
    arr.splice(index, 0, v);
    this._settle(arr, index, v, true);
  }

  // 有些响应式库（MobX observable、Valtio）在赋值时会把普通对象换成自己的代理副本。
  // 写入后读回实际存进去的对象，按它重新登记，之后的修改才能作用到真正的数据上。
  _settle(container, key, v, arr) {
    if (this.options.mode !== 'inplace' || !isObj(v)) return;
    const stored = container[key];
    if (stored === v || !isObj(stored)) return;
    this._unregister(v);
    this._adopt(stored, container, arr ? null : key, false);
  }

  _remove(arr, index) {
    if (!(index >= 0 && index < arr.length)) throw new RangeError(`Index ${index} out of range`);
    const old = arr[index];
    // 先记录（路径要在删除前计算），再删除
    this._record('remove', arr, index, undefined, old, { t: 'ins', c: arr, k: index, v: old });
    if (isObj(old)) this._unregister(old);
    else this._struct++;
    this._dirty(arr);
    arr.splice(index, 1);
  }

  // 把元素从所在位置删除（数组成员或对象属性）
  _detach(n) {
    const m = this._up.get(n);
    if (!m) return;
    if (m.key === null) this._remove(m.owner, m.owner.indexOf(n));
    else this._del(m.owner, m.key);
  }

  _indexKeys() {
    if (!this.__ik) this.__ik = new Set([this.options.typeKey, this.options.idKey, this.options.classKey]);
    return this.__ik;
  }

  // tolerant：回滚时使用。原语在登记完成后才改数据，所以数据被改之后（例如代理的观察者）抛出的错误
  // 不会破坏一致性，回滚继续执行剩下的步骤
  _replay(inv, tolerant = false) {
    for (let i = inv.length - 1; i >= 0; i--) {
      const r = inv[i];
      try {
        if (r.t === 'set') this._set(r.c, r.k, r.v, true);
        else if (r.t === 'del') this._del(r.c, r.k);
        else if (r.t === 'ins') this._insert(r.c, r.k, r.v, true);
        else if (r.t === 'rm') this._remove(r.c, r.k);
      } catch (e) {
        if (!tolerant) throw e;
      }
    }
  }

  _rollback(tx) {
    const saved = this._tx;
    this._tx = { ops: [], inv: [], touched: new Set() };
    try {
      this._replay(tx.inv, true);
    } finally {
      this._tx = saved;
    }
  }

  _notifyWatchers(event) {
    const affected = new Set();
    for (const n of event.touched) for (let p = n; p; p = this.parentOf(p)) affected.add(p);
    for (const w of this._watchers) {
      const hit = [...affected].filter((n) => this.matches(n, w.selector));
      if (hit.length) w.fn(this.$(hit), event);
    }
  }

  // 解析路径到 { container, key }；useAnchor 时优先按 id 锚点定位
  _resolve(op, useAnchor) {
    const a = op.meta?.anchor;
    if (useAnchor && a && a.id !== null) {
      const el = this.byId(a.id);
      if (el) {
        let c = el;
        for (let i = 0; i < a.rel.length - 1; i++) {
          c = c[Array.isArray(c) ? Number(a.rel[i]) : a.rel[i]];
          if (!isObj(c)) throw new Error(`Cannot resolve ${op.path} from #${a.id}`);
        }
        return { container: c, key: a.rel[a.rel.length - 1] };
      }
    }
    return this._resolvePointer(op.path);
  }

  _resolvePointer(path) {
    if (path === '') return { container: null, key: null };
    const segs = path.split('/').slice(1).map(unesc);
    let c = this.root;
    for (let i = 0; i < segs.length - 1; i++) {
      c = c[Array.isArray(c) ? Number(segs[i]) : segs[i]];
      if (!isObj(c)) throw new Error(`Path not found: ${path}`);
    }
    return { container: c, key: segs[segs.length - 1] };
  }

  _getAt(path) {
    if (path === '') return this.root;
    const { container, key } = this._resolvePointer(path);
    return container[Array.isArray(container) ? Number(key) : key];
  }

  _applyOp(op, useAnchor) {
    if (op.op === 'test') {
      if (JSON.stringify(this._getAt(op.path)) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`);
      return;
    }
    if (op.op === 'move' || op.op === 'copy') {
      const v = copy(this._getAt(op.from));
      if (op.op === 'move') {
        const f = this._resolvePointer(op.from);
        this._del(f.container, f.key);
      }
      return this._applyOp({ op: 'add', path: op.path, value: v }, false);
    }
    const { container, key } = this._resolve(op, useAnchor);
    if (!container) throw new Error('Cannot replace the document root');
    if (Array.isArray(container)) {
      const idx = key === '-' || (op.op === 'add' && op.meta?.append && useAnchor) ? container.length : Number(key);
      if (op.op === 'add') this._insert(container, idx, op.value);
      else if (op.op === 'remove') this._remove(container, idx);
      else if (op.op === 'replace') this._set(container, idx, op.value);
    } else {
      if (op.op === 'remove') this._del(container, key);
      else this._set(container, key, op.value);
    }
  }
}

// ---------- Selection：与 jQuery 对齐的链式操作 ----------
//
// 约定与 jQuery 一致：
// - 回调参数是 (index, value/element)，this 指向当前元素
// - 读取方法返回第一个元素的值，写入方法对每个元素生效并返回 Selection 以便链式调用
// - 把已在文档里的元素 append/before/... 到别处是“移动”，多个目标时除最后一个外都复制
// - parents / prevAll / prevUntil / parentsUntil 按离当前元素由近到远排序
// 与 jQuery 不同之处见 docs/jquery-compat.md。

export class Selection {
  constructor(doc, nodes, prev = null) {
    this.doc = doc;
    this.nodes = nodes;
    this.prevObject = prev;
  }

  get length() {
    return this.nodes.length;
  }

  [Symbol.iterator]() {
    return this.nodes[Symbol.iterator]();
  }

  // ---------- 遍历 ----------
  find(sel) {
    if (!this.nodes.length) return this._wrap([]);
    if (typeof sel !== 'string') {
      const set = this.doc.$(sel).nodes;
      return this._wrap(set.filter((d) => this.nodes.some((a) => this.doc._isDescendant(d, a))));
    }
    return this._wrap(this.doc._query(sel, this.nodes, true));
  }
  children(sel) {
    return this._map((n) => this.doc.childrenOf(n), sel);
  }
  parent(sel) {
    return this._map((n) => [this.doc.parentOf(n)], sel);
  }
  parents(sel) {
    return this._map((n) => this._up(n, null), sel, true);
  }
  parentsUntil(until, sel) {
    return this._map((n) => this._up(n, until), sel, true);
  }
  closest(sel) {
    const p = this._pred(sel);
    return this._map((n) => {
      for (let x = n, i = 0; x; x = this.doc.parentOf(x), i++) if (p(x, i)) return [x];
      return [];
    });
  }
  siblings(sel) {
    return this._map((n) => this.doc._siblings(n).list.filter((x) => x !== n), sel);
  }
  next(sel) {
    return this._map((n) => {
      const s = this.doc._siblings(n);
      return [s.list[s.i + 1]];
    }, sel);
  }
  nextAll(sel) {
    return this._map((n) => this._side(n, 1, null), sel);
  }
  nextUntil(until, sel) {
    return this._map((n) => this._side(n, 1, until), sel);
  }
  prev(sel) {
    return this._map((n) => {
      const s = this.doc._siblings(n);
      return [s.list[s.i - 1]];
    }, sel);
  }
  prevAll(sel) {
    return this._map((n) => this._side(n, -1, null), sel, true);
  }
  prevUntil(until, sel) {
    return this._map((n) => this._side(n, -1, until), sel, true);
  }
  filter(test) {
    const p = this._pred(test);
    return this._wrap(this.nodes.filter((n, i) => p(n, i)));
  }
  not(test) {
    const p = this._pred(test);
    return this._wrap(this.nodes.filter((n, i) => !p(n, i)));
  }
  is(test) {
    const p = this._pred(test);
    return this.nodes.some((n, i) => p(n, i));
  }
  has(sel) {
    if (typeof sel === 'string') return this._wrap(this.nodes.filter((n) => this.doc._query(sel, [n], true).length > 0));
    const set = this.doc.$(sel).nodes;
    return this._wrap(this.nodes.filter((n) => set.some((d) => this.doc._isDescendant(d, n))));
  }
  eq(i) {
    const n = this.nodes.at(i);
    return this._wrap(n ? [n] : []);
  }
  first() {
    return this.eq(0);
  }
  last() {
    return this.eq(-1);
  }
  even() {
    return this._wrap(this.nodes.filter((_, i) => i % 2 === 0));
  }
  odd() {
    return this._wrap(this.nodes.filter((_, i) => i % 2 === 1));
  }
  slice(a, b) {
    return this._wrap(this.nodes.slice(a, b));
  }
  add(target, scope) {
    return this._wrap(uniqueInOrder(this.doc, [...this.nodes, ...this.doc.$(target, scope).nodes]));
  }
  addBack(sel) {
    const prev = this.prevObject ? (sel ? this.prevObject.filter(sel) : this.prevObject).nodes : [];
    return this._wrap(uniqueInOrder(this.doc, [...this.nodes, ...prev]));
  }
  end() {
    return this.prevObject || this._wrap([]);
  }

  // ---------- 读取 ----------
  get(i) {
    return i === undefined ? this.nodes.slice() : this.nodes.at(i);
  }
  toArray() {
    return this.nodes.slice();
  }
  /** each(function (i, el) {})；返回 false 提前结束 */
  each(fn) {
    for (let i = 0; i < this.nodes.length; i++) if (fn.call(this.nodes[i], i, this.nodes[i]) === false) break;
    return this;
  }
  /** map(function (i, el) {})：返回数组（数组结果展开一层，null/undefined 丢弃），可再调用 .get() */
  map(fn) {
    const out = [];
    this.nodes.forEach((n, i) => {
      const r = fn.call(n, i, n);
      if (r === null || r === undefined) return;
      if (Array.isArray(r)) out.push(...r);
      else out.push(r);
    });
    return withGet(out);
  }
  /** index()：在兄弟中的位置；index(selector)：在 selector 结果中的位置；index(element)：element 在本集合中的位置 */
  index(arg) {
    if (arg === undefined) return this.nodes.length ? this.doc._siblings(this.nodes[0]).i : -1;
    if (typeof arg === 'string') return this.doc.$(arg).nodes.indexOf(this.nodes[0]);
    return this.nodes.indexOf(arg instanceof Selection ? arg.nodes[0] : arg);
  }
  json() {
    return this.nodes.map((n) => cloneJson(n));
  }
  paths() {
    return this.nodes.map((n) => this.doc.pointer(n));
  }
  pluck(path) {
    const p = splitPath(path);
    return this.nodes.map((n) => getPath(n, p));
  }
  hasClass(c) {
    return this.nodes.some((n) => this.doc.classesOf(n).includes(c));
  }

  // ---------- 字段 ----------
  /**
   * attr(path)                            第一个元素的值
   * attr(path, value)                     对每个元素设置；value 为 null 时删除该字段
   * attr(path, function (i, old, el) {})  按元素计算，返回 undefined 不改
   * attr({ path: value, ... })            一次设置多个
   */
  attr(path, value) {
    if (isObj(path) && !Array.isArray(path)) {
      return this._write(() => {
        for (const [k, v] of Object.entries(path)) this.attr(k, v);
      });
    }
    const segs = splitPath(path);
    if (arguments.length < 2) return this.nodes.length ? getPath(this.nodes[0], segs) : undefined;
    return this._write(() => {
      this.nodes.forEach((n, i) => {
        const v = typeof value === 'function' ? value.call(n, i, getPath(n, segs), n) : value;
        if (v === undefined) return;
        if (v === null) removePath(this.doc, n, segs);
        else setPath(this.doc, n, segs, v);
      });
    });
  }
  /** 原样写入（null 也照写，不做函数求值） */
  set(path, value) {
    const segs = splitPath(path);
    return this._write(() => {
      for (const n of this.nodes) setPath(this.doc, n, segs, value);
    });
  }
  /** 把对象浅合并到元素（或其某个子路径）上 */
  merge(obj, path) {
    return this._write(() => {
      for (const [k, v] of Object.entries(obj)) this.set(path ? `${path}.${k}` : k, v);
    });
  }
  /** removeAttr('a b.c')：空格分隔可删多个 */
  removeAttr(paths) {
    const list = String(paths).split(/\s+/).filter(Boolean).map(splitPath);
    return this._write(() => {
      for (const n of this.nodes) for (const segs of list) removePath(this.doc, n, segs);
    });
  }
  /** css(name) / css([names]) / css(name, value | fn(i, old)) / css({...})：读写 options.styleKey（默认 style）下的字段 */
  css(name, value) {
    const sk = this.doc.options.styleKey;
    if (Array.isArray(name)) {
      const n = this.nodes[0];
      const out = {};
      for (const k of name) out[k] = n?.[sk]?.[camel(k)];
      return out;
    }
    if (isObj(name)) {
      return this._write(() => {
        for (const [k, v] of Object.entries(name)) this.css(k, v);
      });
    }
    const path = `${sk}.${camel(name)}`;
    if (arguments.length < 2) return this.attr(path);
    return this.attr(path, value === '' ? null : value);
  }
  /** text()：所有匹配元素及其后代的 options.textKey 拼接；text(value | fn(i, old))：设置每个元素的文字字段 */
  text(value) {
    const key = this.doc.options.textKey;
    if (arguments.length === 0) {
      const out = [];
      for (const n of this.nodes) {
        this.doc._walk(n, (d) => {
          const t = d[key];
          if (t !== undefined && t !== null && !isObj(t)) out.push(String(t));
        });
      }
      return out.join('');
    }
    return this.attr(key, typeof value === 'function' ? value : value === null ? '' : String(value));
  }
  addClass(names) {
    return this._classes(names, (cls, c) => (cls.includes(c) ? cls : [...cls, c]));
  }
  /** removeClass() 不带参数时移除全部 class */
  removeClass(names) {
    return this._classes(names, (cls, c) => cls.filter((x) => x !== c), names === undefined);
  }
  toggleClass(names, state) {
    return this._classes(names, (cls, c) => {
      const on = typeof state === 'boolean' ? state : !cls.includes(c);
      return on ? (cls.includes(c) ? cls : [...cls, c]) : cls.filter((x) => x !== c);
    });
  }

  // ---------- 结构 ----------
  // 内容可以是：JSON 值、JSON 数组、元素、Selection（含 clone() 得到的游离元素），或 function (i, el) 返回以上之一。
  // 文档里已有的元素会被移动；多个目标时，除最后一个外插入的是复制品。

  /** 插入到每个元素的 key 数组末尾（默认 options.childrenKey，不存在则创建） */
  append(content, key) {
    this._into(content, key, 'end');
    return this;
  }
  prepend(content, key) {
    this._into(content, key, 'start');
    return this;
  }
  /** 同 append，但返回新插入的元素（jqson 扩展） */
  insert(content, key) {
    return this._wrap(this._into(content, key, 'end'));
  }
  before(content) {
    this._beside(content, 'before');
    return this;
  }
  after(content) {
    this._beside(content, 'after');
    return this;
  }
  appendTo(target, key) {
    return this._to(target, (d) => d._into(this, key, 'end'));
  }
  prependTo(target, key) {
    return this._to(target, (d) => d._into(this, key, 'start'));
  }
  insertBefore(target) {
    return this._to(target, (d) => d._beside(this, 'before'));
  }
  insertAfter(target) {
    return this._to(target, (d) => d._beside(this, 'after'));
  }
  replaceWith(content) {
    this._replace(content);
    return this;
  }
  replaceAll(target) {
    return this._to(target, (d) => d._replace(this));
  }
  /** remove(selector?)：删除（可先按 selector 过滤） */
  remove(sel) {
    const list = sel === undefined ? this.nodes : this.nodes.filter((n, i) => this._pred(sel)(n, i));
    return this._write(() => {
      for (const n of list) {
        if (n === this.doc.root) throw new Error('Cannot remove the document root');
        this.doc._detach(n);
      }
    });
  }
  /** 与 remove 相同（JSON 没有事件和数据需要保留） */
  detach(sel) {
    return this.remove(sel);
  }
  /** 删除所有子元素 */
  empty() {
    return this._write(() => {
      for (const n of this.nodes) for (const k of this.doc.childrenOf(n).slice()) this.doc._detach(k);
    });
  }
  /** 深拷贝成游离元素，可继续修改后 appendTo / insertAfter 等插回文档 */
  clone() {
    return this.doc._fragment(this.nodes);
  }
  /** 用 wrapper（JSON 对象、选择器、元素或 function (i, el)）包裹每个元素，元素放进 wrapper 的 childrenKey */
  wrap(wrapper) {
    return this._write(() => {
      this.nodes.forEach((n, i) => this._wrapOne(n, this._wrapper(wrapper, i, n)));
    });
  }
  /** 用一个 wrapper 包裹全部元素：放在第一个元素的位置，其余元素按文档顺序移入 */
  wrapAll(wrapper) {
    if (!this.nodes.length) return this;
    return this._write(() => {
      const ordered = uniqueInOrder(this.doc, this.nodes);
      const wn = this._wrapOne(ordered[0], this._wrapper(wrapper, 0, ordered[0]));
      this._place(wn[this.doc.options.childrenKey], ordered.slice(1).map((n) => ({ move: n })), 'end');
    });
  }
  /** 用 wrapper 包裹每个元素的子元素数组 */
  wrapInner(wrapper) {
    const ck = this.doc.options.childrenKey;
    return this._write(() => {
      this.nodes.forEach((n, i) => {
        const w = this._wrapper(wrapper, i, n);
        const arr = n[ck];
        if (!Array.isArray(arr)) return this.doc._set(n, ck, [w]);
        const kids = arr.slice();
        for (let j = arr.length - 1; j >= 0; j--) this.doc._remove(arr, j);
        this.doc._insert(arr, 0, w);
        const inner = arr[0][ck];
        kids.forEach((k) => this.doc._insert(inner, inner.length, k, true));
      });
    });
  }
  /** 去掉父元素，把它的子元素放回父元素原来的位置（可用 selector 限定父元素） */
  unwrap(sel) {
    return this._write(() => {
      const ps = this.nodes.map((n) => this.doc.parentOf(n)).filter((p) => p && p !== this.doc.root && (!sel || this.doc.matches(p, sel)));
      for (const p of uniqueInOrder(this.doc, ps)) {
        const m = this.doc._up.get(p);
        if (!m) continue;
        if (m.key !== null) throw new Error('unwrap() 需要父元素位于数组中');
        const owner = m.owner;
        const idx = owner.indexOf(p);
        const kids = this.doc.childrenOf(p).slice();
        this.doc._remove(owner, idx);
        kids.forEach((k, j) => this.doc._insert(owner, idx + j, k, true));
      }
    });
  }

  // ---------- 内部 ----------
  _wrap(nodes) {
    return new Selection(this.doc, nodes, this);
  }
  _map(fn, sel, reverse = false) {
    const out = [];
    for (const n of this.nodes) for (const x of fn(n)) if (x) out.push(x);
    let nodes = uniqueInOrder(this.doc, out);
    if (reverse) nodes.reverse();
    if (sel) nodes = nodes.filter((n) => this.doc.matches(n, sel));
    return this._wrap(nodes);
  }
  _up(n, until) {
    const stop = until === null || until === undefined ? null : this._pred(until);
    const out = [];
    for (let p = this.doc.parentOf(n); p; p = this.doc.parentOf(p)) {
      if (stop && stop(p, 0)) break;
      out.push(p);
    }
    return out;
  }
  _side(n, dir, until) {
    const stop = until === null || until === undefined ? null : this._pred(until);
    const s = this.doc._siblings(n);
    const out = [];
    for (let i = s.i + dir; i >= 0 && i < s.list.length; i += dir) {
      if (stop && stop(s.list[i], 0)) break;
      out.push(s.list[i]);
    }
    return out;
  }
  _pred(test) {
    if (typeof test === 'function') return (n, i) => !!test.call(n, i, n);
    if (typeof test === 'string') return (n) => this.doc.matches(n, test);
    const set = new Set(test instanceof Selection ? test.nodes : Array.isArray(test) ? test : [test]);
    return (n) => set.has(n);
  }
  _write(fn) {
    this.doc._auto(fn);
    return this;
  }
  _classes(names, fn, all = false) {
    const key = this.doc.options.classKey;
    return this._write(() => {
      this.nodes.forEach((n, i) => {
        const before = this.doc.classesOf(n);
        const v = typeof names === 'function' ? names.call(n, i, before.join(' '), n) : names;
        const list = all ? before : String(v ?? '').split(/\s+/).filter(Boolean);
        let cls = before;
        for (const c of list) cls = fn(cls, c);
        if (cls.join(' ') === before.join(' ')) return;
        this.doc._set(n, key, Array.isArray(n[key]) ? cls : cls.join(' '));
      });
    });
  }
  // 把内容解析成待插入项：{ move: 文档内元素 } 或 { value: JSON }
  _items(content, i, n) {
    const v = typeof content === 'function' ? content.call(n, i, n) : content;
    if (v === undefined) return [];
    const raw = v instanceof Selection ? v.nodes : Array.isArray(v) ? v : [v];
    const last = i === this.nodes.length - 1;
    return raw.map((x) => {
      if (isObj(x) && this.doc._isEl.has(x)) return last ? { move: x } : { value: cloneJson(x) };
      return { value: x };
    });
  }
  // 依次插入到数组 arr：where = end | start | before ref | after ref；返回插入的元素
  _place(arr, items, where, ref) {
    const doc = this.doc;
    const out = [];
    let anchor = where === 'after' ? ref : null;
    for (const it of items) {
      let v = it.value;
      let raw = false;
      if (it.move) {
        const n = it.move;
        if (n === ref) {
          anchor = n;
          continue;
        }
        for (let x = arr; x; x = doc._up.get(x)?.owner) if (x === n) throw new Error('Cannot move an element into itself');
        doc._detach(n);
        v = n;
        raw = true;
      }
      const idx = where === 'end' ? arr.length : where === 'before' ? arr.indexOf(ref) : anchor ? arr.indexOf(anchor) + 1 : 0;
      doc._insert(arr, idx, v, raw);
      anchor = arr[idx];
      if (doc._isEl.has(anchor)) out.push(anchor);
    }
    return out;
  }
  _into(content, key, where) {
    key = key ?? this.doc.options.childrenKey;
    const out = [];
    this.doc._auto(() => {
      this.nodes.forEach((n, i) => {
        const items = this._items(content, i, n);
        if (!items.length) return;
        if (n[key] === undefined) this.doc._set(n, key, []);
        const arr = n[key];
        if (!Array.isArray(arr)) throw new TypeError(`"${key}" is not an array`);
        out.push(...this._place(arr, items, where, null));
      });
    });
    return out;
  }
  _beside(content, where) {
    const out = [];
    this.doc._auto(() => {
      this.nodes.forEach((n, i) => {
        const m = this.doc._up.get(n);
        if (!m || m.key !== null) throw new Error('before()/after() 需要元素位于数组中');
        out.push(...this._place(m.owner, this._items(content, i, n), where, n));
      });
    });
    return out;
  }
  _replace(content) {
    const out = [];
    this.doc._auto(() => {
      this.nodes.forEach((n, i) => {
        if (n === this.doc.root) throw new Error('Cannot replace the document root');
        const m = this.doc._up.get(n);
        if (!m) return;
        const items = this._items(content, i, n);
        if (items.some((it) => it.move === n)) return;
        if (m.key === null) {
          out.push(...this._place(m.owner, items, 'before', n));
          this.doc._detach(n);
          return;
        }
        if (items.length !== 1) throw new Error('replaceWith()：位于对象属性上的元素只能替换为一个值');
        const it = items[0];
        if (it.move) {
          this.doc._detach(it.move);
          this.doc._set(m.owner, m.key, it.move, true);
        } else this.doc._set(m.owner, m.key, it.value);
        const placed = m.owner[m.key];
        if (this.doc._isEl.has(placed)) out.push(placed);
      });
    });
    return out;
  }
  // appendTo 等：目标在宿主文档（clone() 得到的游离元素也插回原文档）
  _to(target, fn) {
    const host = this.doc._host || this.doc;
    const dest = target instanceof Selection && target.doc === host ? target : host.$(target);
    let out = [];
    host._auto(() => {
      out = fn(dest);
    });
    return new Selection(host, uniqueInOrder(host, out), this);
  }
  _wrapper(w, i, n) {
    let v = typeof w === 'function' ? w.call(n, i, n) : w;
    if (typeof v === 'string') v = (this.doc._host || this.doc).get(v);
    if (v instanceof Selection) v = v.nodes[0];
    if (!isObj(v) || Array.isArray(v)) throw new TypeError('wrap 系列方法需要一个 JSON 对象作为包裹元素');
    v = cloneJson(v);
    const ck = this.doc.options.childrenKey;
    if (!Array.isArray(v[ck])) v[ck] = [];
    return v;
  }
  _wrapOne(n, w) {
    const doc = this.doc;
    const m = doc._up.get(n);
    if (!m) throw new Error('wrap 系列方法不能用于根节点');
    const ck = doc.options.childrenKey;
    let wn;
    if (m.key === null) {
      const idx = m.owner.indexOf(n);
      doc._remove(m.owner, idx);
      doc._insert(m.owner, idx, w);
      wn = m.owner[idx];
    } else {
      doc._del(m.owner, m.key);
      doc._set(m.owner, m.key, w);
      wn = m.owner[m.key];
    }
    doc._insert(wn[ck], wn[ck].length, n, true);
    return wn;
  }
}

function withGet(arr) {
  Object.defineProperties(arr, {
    get: { value: (i) => (i === undefined ? arr.slice() : arr.at(i)) },
    toArray: { value: () => arr.slice() },
  });
  return arr;
}

const camel = (s) => String(s).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const splitPath = (p) => String(p).split('.');

function removePath(doc, n, segs) {
  let c = n;
  for (let i = 0; i < segs.length - 1 && isObj(c); i++) c = c[Array.isArray(c) ? Number(segs[i]) : segs[i]];
  if (isObj(c)) doc._del(c, segs[segs.length - 1]);
}

// ---------- 工具函数 ----------

function addTo(map, key, n) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(n);
}

function removeFrom(map, key, n) {
  const s = map.get(key);
  if (!s) return;
  s.delete(n);
  if (!s.size) map.delete(key);
}

function uniqueInOrder(doc, nodes) {
  const seen = new Set(nodes);
  return doc._inDocOrder([...seen], seen);
}

export function getPath(obj, segs) {
  let v = obj;
  for (const s of segs) {
    if (!isObj(v)) return undefined;
    v = v[Array.isArray(v) ? Number(s) : s];
  }
  return v;
}

function setPath(doc, node, segs, value) {
  let c = node;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = Array.isArray(c) ? Number(segs[i]) : segs[i];
    if (!isObj(c[k])) doc._set(c, k, /^\d+$/.test(segs[i + 1]) ? [] : {});
    c = c[k];
  }
  const last = Array.isArray(c) ? Number(segs[segs.length - 1]) : segs[segs.length - 1];
  if (Array.isArray(c) && last === c.length) doc._insert(c, last, value);
  else if (!isObj(value) && c[last] === value) return;
  else doc._set(c, last, value);
}

const isPrim = (x) => x !== undefined && x !== null && !isObj(x);
const normAttr = (a, x) => (a.insensitive ? String(x).toLowerCase() : String(x));

function attrEq(a, x) {
  if (a.typed) {
    if (typeof a.value === 'number') return (typeof x === 'number' || (typeof x === 'string' && x !== '')) && Number(x) === a.value;
    return x === a.value;
  }
  return isPrim(x) && normAttr(a, x) === a.value;
}

function attrAny(a, v) {
  if (!Array.isArray(v)) return attrEq(a, v);
  for (const x of v) if (attrEq(a, x)) return true;
  return false;
}

function matchAttr(n, a) {
  const v = getPath(n, a.path);
  if (!a.op) return v !== undefined;
  switch (a.op) {
    case '=':
      return attrAny(a, v);
    case '!=':
      return !attrAny(a, v);
    case '^=':
      return isPrim(v) && normAttr(a, v).startsWith(String(a.value));
    case '$=':
      return isPrim(v) && normAttr(a, v).endsWith(String(a.value));
    case '*=':
      return isPrim(v) && normAttr(a, v).includes(String(a.value));
    case '~=':
      if (Array.isArray(v)) return attrAny(a, v);
      return typeof v === 'string' && normAttr(a, v).split(/\s+/).includes(String(a.value));
    case '|=': {
      if (!isPrim(v)) return false;
      const s = normAttr(a, v);
      const val = String(a.value);
      return s === val || s.startsWith(val + '-');
    }
    default: {
      if (typeof v === 'number') return cmpNum(a.op, v, a.num ?? (a.num = Number(a.value)));
      if (typeof v !== 'string' || v === '') return false;
      return cmpNum(a.op, Number(v), a.num ?? (a.num = Number(a.value)));
    }
  }
}

function cmpNum(op, x, y) {
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  if (op === '>') return x > y;
  if (op === '>=') return x >= y;
  if (op === '<') return x < y;
  return x <= y;
}

function collectIds(value, idKey) {
  if (!isObj(value)) return [];
  const out = [];
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!Array.isArray(v)) {
      const id = v[idKey];
      if (typeof id === 'string' || typeof id === 'number') out.push(String(id));
    }
    for (const c of Array.isArray(v) ? v : Object.values(v)) if (isObj(c)) stack.push(c);
  }
  return out;
}

export function publicOp(op) {
  const { meta, ...rest } = op;
  return rest;
}

// ---------- 冲突检测 ----------
// 两边的操作都按锚点（最近的带 id 元素 + 相对路径）描述。
// 同一锚点下路径互为前缀即冲突；对数组的增删视为触及整个数组，但双方都只是追加时不算冲突；
// 一方删除或替换了某个 id 的子树，另一方又锚在这个 id 上，也算冲突。

const touchCache = new WeakMap();

// 操作的触及范围：锚点 + 相对路径的全部前缀键（结果缓存在操作对象上）
function touch(op) {
  let t = touchCache.get(op);
  if (t) return t;
  const a = op.meta?.anchor;
  const anchor = a ? (a.id === null ? '' : '#' + a.id) : '';
  let segs = a ? a.rel : op.path.split('/').slice(1);
  const last = segs[segs.length - 1];
  const structural = (op.op === 'add' || op.op === 'remove') && (last === '-' || /^\d+$/.test(last));
  if (structural) segs = segs.slice(0, -1);
  const prefixes = new Array(segs.length + 1);
  let acc = anchor + '\u0001';
  prefixes[0] = acc;
  for (let i = 0; i < segs.length; i++) prefixes[i + 1] = acc = acc + '\u0002' + segs[i];
  t = {
    key: acc,
    prefixes,
    append: structural && !!op.meta?.append,
    killed: op.meta?.killed || [],
    path: op.path,
    id: a?.id ?? null,
  };
  touchCache.set(op, t);
  return t;
}

export function findConflicts(theirs, ours) {
  if (!theirs.length || !ours.length) return [];
  const full = new Map(); // 对方非追加操作的路径 -> 原路径
  const below = new Map(); // 对方所有操作路径的全部前缀 -> 原路径
  const killed = new Map(); // 对方删掉的 id
  const anchored = new Map(); // 对方操作所锚定的 id
  for (const op of theirs) {
    const t = touch(op);
    if (!t.append) full.set(t.key, t.path);
    for (const p of t.prefixes) if (!below.has(p)) below.set(p, t.path);
    for (const k of t.killed) killed.set(k, t.path);
    if (t.id !== null && t.killed.length === 0) anchored.set(t.id, t.path);
    else if (t.id !== null) anchored.set(t.id, t.path);
  }
  const out = [];
  for (const op of ours) {
    const o = touch(op);
    let hit;
    for (const p of o.prefixes) if ((hit = full.get(p)) !== undefined) break;
    if (hit === undefined && !o.append) hit = below.get(o.key);
    if (hit === undefined && o.id !== null) hit = killed.get(o.id);
    if (hit === undefined) for (const k of o.killed) if ((hit = anchored.get(k)) !== undefined) break;
    if (hit !== undefined) out.push({ path: o.path, theirs: hit });
  }
  return out;
}
