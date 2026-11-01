// jqson 类型声明：jQuery for JSON

/** 文档中的元素：带 type 或 id 字段的普通对象（可通过选项改变判定方式） */
export type JsonNode = { [key: string]: any };
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** RFC 6902 JSON Patch 操作 */
export interface PatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  from?: string;
  value?: any;
}

/** 内部操作：JSON Patch 加上用于合并的锚点信息 */
export interface InternalOp extends PatchOp {
  meta?: { anchor?: { id: string | null; rel: string[] }; append?: boolean; killed?: string[] };
}

export type Mode = 'copy' | 'inplace' | 'immutable';

export interface Options {
  /** copy（默认，深拷贝）| inplace（直接修改传入对象）| immutable（深拷贝 + 结构共享快照 doc.state） */
  mode?: Mode;
  /** @deprecated 用 mode: 'inplace' 代替 clone: false */
  clone?: boolean;
  typeKey?: string;
  idKey?: string;
  classKey?: string;
  childrenKey?: string;
  /** css() 读写的字段，默认 'style' */
  styleKey?: string;
  /** text() 读写的字段，默认 'text' */
  textKey?: string;
  /** 'auto'：带 type 或 id 的对象是元素；'all'：所有对象都是元素；或自定义判定函数 */
  element?: 'auto' | 'all' | ((obj: JsonNode, key: string | null) => boolean);
  /** 撤销栈深度，0 关闭，默认 200 */
  history?: number;
  /** snapshot() 产出的新对象是否 Object.freeze */
  freeze?: boolean;
  /** 把每个事务包进外部批处理，例如 MobX 的 runInAction */
  batch?: (<T>(run: () => T) => T) | null;
}

export interface CommitEvent<T = JsonNode> {
  version: number;
  patch: PatchOp[];
  ops: InternalOp[];
  /** 本次改动涉及的元素 */
  touched: JsonNode[];
  meta: Record<string, any>;
  /** 结构共享的不可变快照（按需计算） */
  readonly state: T;
}

export interface ValidationContext {
  doc: JsonDoc;
  patch: PatchOp[];
  ops: InternalOp[];
  touched: JsonNode[];
}
export type ValidationIssue = { message: string; path?: string; [key: string]: any } | string;
export type Validator = (ctx: ValidationContext) => ValidationIssue[] | null | undefined | void;

export interface Conflict {
  path: string;
  [key: string]: any;
}

export interface MergeResult {
  applied: boolean;
  conflicts: Conflict[];
  version: number;
}

export type MergePolicy = 'throw' | 'skip' | 'force';

/** 选择器、元素、元素数组、Selection；传入不在文档里的 JSON 对象会得到游离元素 */
export type Target = string | JsonNode | JsonNode[] | Selection;
export type Predicate = string | JsonNode | JsonNode[] | Selection | ((this: JsonNode, index: number, el: JsonNode) => any);
/** 插入的内容：JSON 值、数组、元素、Selection，或按元素计算的函数 */
export type Content = any | Selection | ((this: JsonNode, index: number, el: JsonNode) => any);

export class JsonDoc<T extends JsonNode = JsonNode> {
  constructor(data: T, options?: Options);
  readonly options: Required<Omit<Options, 'clone' | 'batch'>> & Pick<Options, 'batch'> & { clone: boolean };
  /** 当前根对象（只读使用，修改请走 Selection 方法） */
  readonly root: T;
  readonly version: number;
  readonly key: string;
  /** 元素总数 */
  readonly size: number;
  /** 结构共享的不可变快照，等同 snapshot() */
  readonly state: T;

  $(target: Target, scope?: Target): Selection;
  get(selector: string): JsonNode | undefined;
  byId(id: string | number): JsonNode | undefined;
  matches(node: JsonNode, selector: string): boolean;
  toJSON(): T;
  snapshot(): T;
  pointer(node: JsonNode): string;
  parentOf(node: JsonNode): JsonNode | null;
  childrenOf(node: JsonNode): JsonNode[];
  tagOf(node: JsonNode): string;
  idOf(node: JsonNode): string | null;
  classesOf(node: JsonNode): string[];

  transaction<R>(fn: (doc: this) => R, meta?: Record<string, any>): { result: R; patch: PatchOp[] | null; version: number };
  on(listener: (e: CommitEvent<T>) => void): () => void;
  watch(selector: string, listener: (sel: Selection, e: CommitEvent<T>) => void): () => void;
  use(validator: Validator): () => void;
  undo(): PatchOp[] | false;
  redo(): PatchOp[] | false;
  applyPatch(patch: PatchOp[]): { result: undefined; patch: PatchOp[] | null; version: number };

  fork(): JsonDoc<T>;
  opsSince(version: number): InternalOp[];
  merge(source: JsonDoc | { ops: InternalOp[]; baseVersion?: number }, options?: { policy?: MergePolicy }): MergeResult;

  /** 执行一批声明式指令（纯 JSON，不执行代码），整体原子 */
  exec(commands: ExecCommand | ExecCommand[], options?: { dryRun?: boolean }): ExecResult;
  describe(options?: InspectOptions): InspectResult;
  help(query?: string): string;
  syncTo(target: object, options?: SyncOptions): () => void;
}

export class Selection implements Iterable<JsonNode> {
  readonly doc: JsonDoc;
  readonly nodes: JsonNode[];
  readonly prevObject: Selection | null;
  readonly length: number;
  [Symbol.iterator](): Iterator<JsonNode>;

  // 遍历
  find(selector: Target): Selection;
  children(selector?: string): Selection;
  parent(selector?: string): Selection;
  parents(selector?: string): Selection;
  parentsUntil(until?: Predicate, selector?: string): Selection;
  closest(selector: Predicate): Selection;
  siblings(selector?: string): Selection;
  next(selector?: string): Selection;
  nextAll(selector?: string): Selection;
  nextUntil(until?: Predicate, selector?: string): Selection;
  prev(selector?: string): Selection;
  prevAll(selector?: string): Selection;
  prevUntil(until?: Predicate, selector?: string): Selection;
  filter(test: Predicate): Selection;
  not(test: Predicate): Selection;
  is(test: Predicate): boolean;
  has(selector: string | JsonNode | Selection): Selection;
  eq(index: number): Selection;
  first(): Selection;
  last(): Selection;
  even(): Selection;
  odd(): Selection;
  slice(start?: number, end?: number): Selection;
  add(target: Target, scope?: Target): Selection;
  addBack(selector?: string): Selection;
  end(): Selection;

  // 读取
  get(): JsonNode[];
  get(index: number): JsonNode | undefined;
  toArray(): JsonNode[];
  each(fn: (this: JsonNode, index: number, el: JsonNode) => void | boolean): this;
  map<R>(fn: (this: JsonNode, index: number, el: JsonNode) => R | R[] | null | undefined): R[] & { get(): R[]; get(i: number): R | undefined; toArray(): R[] };
  index(target?: string | JsonNode | Selection): number;
  json(): JsonNode[];
  paths(): string[];
  pluck(path: string): any[];
  hasClass(name: string): boolean;

  // 字段
  attr(path: string): any;
  attr(path: string, fn: (this: JsonNode, index: number, old: any, el: JsonNode) => any): this;
  /** value 为 null 时删除字段 */
  attr(path: string, value: any): this;
  attr(values: Record<string, any>): this;
  set(path: string, value: any): this;
  merge(obj: Record<string, any>, path?: string): this;
  removeAttr(paths: string): this;
  css(name: string): any;
  css(names: string[]): Record<string, any>;
  css(name: string, fn: (this: JsonNode, index: number, old: any, el: JsonNode) => any): this;
  css(name: string, value: any): this;
  css(values: Record<string, any>): this;
  text(): string;
  text(fn: (this: JsonNode, index: number, old: any, el: JsonNode) => any): this;
  text(value: string | number | null): this;
  addClass(names: string | ((this: JsonNode, index: number, current: string, el: JsonNode) => string)): this;
  removeClass(names?: string | ((this: JsonNode, index: number, current: string, el: JsonNode) => string)): this;
  toggleClass(names: string | ((this: JsonNode, index: number, current: string, el: JsonNode) => string), state?: boolean): this;

  // 结构
  append(content: Content, key?: string): this;
  prepend(content: Content, key?: string): this;
  insert(content: Content, key?: string): Selection;
  before(content: Content): this;
  after(content: Content): this;
  appendTo(target: Target, key?: string): Selection;
  prependTo(target: Target, key?: string): Selection;
  insertBefore(target: Target): Selection;
  insertAfter(target: Target): Selection;
  replaceWith(content: Content): this;
  replaceAll(target: Target): Selection;
  remove(selector?: Predicate): this;
  detach(selector?: Predicate): this;
  empty(): this;
  clone(): Selection;
  wrap(wrapper: string | JsonNode | Selection | ((this: JsonNode, index: number, el: JsonNode) => JsonNode)): this;
  wrapAll(wrapper: string | JsonNode | Selection | ((this: JsonNode, index: number, el: JsonNode) => JsonNode)): this;
  wrapInner(wrapper: string | JsonNode | Selection | ((this: JsonNode, index: number, el: JsonNode) => JsonNode)): this;
  unwrap(selector?: string): this;

  /** 插件方法 */
  [plugin: string]: any;
}

export class ValidationError extends Error {
  errors: ValidationIssue[];
}
export class ConflictError extends Error {
  conflicts: Conflict[];
}
export class SelectorError extends Error {
  selector: string;
  position: number;
}

// 并行
export type Task<T extends JsonNode = JsonNode> = ((fork: JsonDoc<T>, index: number) => any) | { script: string; args?: any };
export interface TaskReport {
  index: number;
  ok: boolean;
  applied: boolean;
  conflicts: Conflict[];
  error?: Error;
  result?: any;
}
export interface Pool {
  size: number;
  close(): void;
}
export function parallel<T extends JsonNode>(
  doc: JsonDoc<T>,
  tasks: Task<T>[],
  options?: { policy?: MergePolicy; order?: 'task' | 'finish'; threads?: number; pool?: Pool },
): Promise<TaskReport[]>;
export function createPool(options?: { size?: number }): Promise<Pool>;

// 脚本：在 fork 上执行，成功才合并。注意：执行的是任意 JS，没有沙箱
export type QueryFn = ((target: Target, scope?: Target) => Selection) & { doc: JsonDoc };
export function runScript(
  doc: JsonDoc,
  source: string | (($: QueryFn, doc: JsonDoc, args: any) => any),
  options?: { args?: any; policy?: MergePolicy; atomic?: boolean },
): Promise<{ result: any; ops: InternalOp[]; version: number; conflicts?: Conflict[] }>;
export function compileScript(source: string): (...args: any[]) => Promise<any>;

// 声明式指令
/** 值运算：按旧值计算新值，可组合 */
export interface ValueOp {
  $default?: any;
  $add?: number;
  $mul?: number;
  $round?: number;
  $replace?: [string, string];
  $prefix?: string;
  $suffix?: string;
}
export interface ExecCommand {
  /** 选择器，或要新建的 JSON 对象 */
  $: string | JsonNode;
  /** 断言匹配数量，不符则整批回滚 */
  expect?: number | { min?: number; max?: number };
  /** 按顺序调用的方法：[["方法", ...参数]] */
  do?: [string, ...any[]][];
  note?: string;
  /** 简写：方法名 → 参数（数组为参数列表，true 为无参数，其他值为唯一参数） */
  [method: string]: any;
}
export interface ExecResult {
  results: { count: number; value?: any }[];
  patch: PatchOp[];
  version: number;
  applied: boolean;
}
export class ExecError extends Error {
  /** 出错的指令序号 */
  index?: number;
  expected?: any;
  actual?: number;
}
export function exec(doc: JsonDoc, commands: ExecCommand | ExecCommand[], options?: { dryRun?: boolean }): ExecResult;
export const execSchema: Record<string, any>;
export const EXEC_METHODS: { traverse: string[]; write: string[]; read: string[] };

// 响应式同步
export interface SyncOptions {
  batch?: <R>(run: () => R) => R;
}
export function syncTo(doc: JsonDoc, target: object, options?: SyncOptions): () => void;
export function applyPatchTo<O extends object>(target: O, patch: PatchOp[]): O;

// 自查
export interface InspectOptions {
  depth?: number;
  limit?: number;
}
export interface InspectResult {
  elements: number;
  options: Record<string, any>;
  tags: Record<string, { count: number; ids?: string[]; classes?: string[]; parents?: string[]; childKeys?: string[]; fields: Record<string, { types: string; sample: any[] }> }>;
  ids: string[];
  classes: Record<string, number>;
  outline: string[];
  suggestions: string[];
  next: string;
}
export function inspect(target: JsonDoc | JsonNode, options?: InspectOptions): InspectResult;
export function explain(selector: string):
  | { ok: true; selector: string; parts: string[]; hints: string[] }
  | { ok: false; selector: string; error: string; position: number; pointer: string; help: string };
export interface HelpFn {
  (query?: string): string;
  json(query?: string): any;
  topics(): string[];
  api(): { name: string; on: string; sig: string; desc: string; example?: string }[];
}
export const help: HelpFn;

export function parseSelector(source: string): any;
export function parseRelativeSelector(source: string): any;
export function findConflicts(theirs: InternalOp[], ours: InternalOp[]): Conflict[];
export function publicOp(op: InternalOp): PatchOp;

/** 插件扩展点，同 jQuery.fn */
export const fn: Selection & Record<string, any>;

export interface Jqson {
  <T extends JsonNode>(data: T, options?: Options): JsonDoc<T>;
  fn: Selection & Record<string, any>;
}
export const jqson: Jqson;
export default jqson;
