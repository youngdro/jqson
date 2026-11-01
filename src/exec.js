// 声明式指令：Agent 用纯 JSON 描述“选中什么、做什么”，不执行任何代码。
//
//   [
//     { "$": "text[zone=price-band]", "expect": 2, "css": { "fontSize": { "$mul": 1.1, "$round": 0 } } },
//     { "$": "#offer", "append": { "type": "text", "id": "tip", "text": "限时" } },
//     { "$": "#point-1", "do": [["attr", "text", "零糖"], ["addClass", "hl"]] },
//     { "$": "segment", "pluck": "id" }
//   ]
//
// - 只能调用白名单里的方法；参数只能是 JSON；整批指令在一个事务里执行，任何一条失败全部回滚
// - expect 断言匹配数量，防止选错元素
// - 需要按旧值计算时用值运算：{"$add": n} {"$mul": n} {"$round": 位数} {"$prefix": s} {"$suffix": s}
//   {"$replace": [旧, 新]} {"$default": v}，可组合

import { Selection } from './doc.js';

const TRAVERSE = new Set([
  'find', 'children', 'parent', 'parents', 'parentsUntil', 'closest', 'siblings', 'next', 'nextAll', 'nextUntil',
  'prev', 'prevAll', 'prevUntil', 'filter', 'not', 'has', 'eq', 'first', 'last', 'even', 'odd', 'slice', 'add', 'addBack', 'end',
]);
const WRITE = new Set([
  'attr', 'set', 'merge', 'removeAttr', 'css', 'text', 'addClass', 'removeClass', 'toggleClass',
  'append', 'prepend', 'insert', 'before', 'after', 'appendTo', 'prependTo', 'insertBefore', 'insertAfter',
  'replaceWith', 'replaceAll', 'remove', 'detach', 'empty', 'clone', 'wrap', 'wrapAll', 'wrapInner', 'unwrap',
]);
// 只读的收尾方法：返回值写进结果
const READ = new Set(['count', 'pluck', 'paths', 'json', 'index', 'is', 'hasClass']);
// 带一个参数时是读取（attr/css 的名字、text 无参数）
const GETTER_ARITY = { attr: 1, css: 1, text: 0 };
const VALUE_METHODS = new Set(['attr', 'css', 'text']);
const RESERVED = new Set(['$', 'expect', 'do', 'note']);

export const EXEC_METHODS = { traverse: [...TRAVERSE], write: [...WRITE], read: [...READ] };

const VALUE_OPS = ['$default', '$add', '$mul', '$round', '$replace', '$prefix', '$suffix'];

export class ExecError extends Error {
  constructor(message, index, detail) {
    super(index === undefined ? message : `指令 #${index}: ${message}`);
    this.name = 'ExecError';
    this.index = index;
    if (detail) Object.assign(this, detail);
  }
}

function isValueOp(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.length || !keys.every((k) => k.startsWith('$'))) return false;
  const bad = keys.filter((k) => !VALUE_OPS.includes(k));
  if (bad.length) throw new ExecError(`未知的值运算 ${bad.join(', ')}，可用：${VALUE_OPS.join(' ')}`);
  return true;
}

// 把值运算变成 jQuery 风格的 (i, old) => 新值
function compileValueOp(op) {
  return (i, old) => {
    let v = old;
    if ('$default' in op && (v === undefined || v === null)) v = op.$default;
    if ('$add' in op) v = num(v) + op.$add;
    if ('$mul' in op) v = num(v) * op.$mul;
    if ('$round' in op) {
      const f = 10 ** (op.$round || 0);
      v = Math.round(num(v) * f) / f;
    }
    if ('$replace' in op) v = String(v ?? '').split(op.$replace[0]).join(op.$replace[1]);
    if ('$prefix' in op) v = op.$prefix + String(v ?? '');
    if ('$suffix' in op) v = String(v ?? '') + op.$suffix;
    return v;
  };
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) throw new ExecError(`值 ${JSON.stringify(v)} 不是数字，不能做数值运算`);
  return n;
}

// 把参数里的值运算展开成函数（只对 attr / css / text 生效）
function prepareArgs(method, args) {
  if (!VALUE_METHODS.has(method)) return args;
  const out = args.slice();
  if (method === 'text') {
    if (isValueOp(out[0])) out[0] = compileValueOp(out[0]);
    return out;
  }
  if (typeof out[0] === 'string') {
    if (out.length > 1 && isValueOp(out[1])) out[1] = compileValueOp(out[1]);
    return out;
  }
  if (out[0] && typeof out[0] === 'object' && !Array.isArray(out[0])) {
    // attr({ a: 1, b: {$add: 1} }) → 逐个字段
    return [Object.fromEntries(Object.entries(out[0]).map(([k, v]) => [k, isValueOp(v) ? compileValueOp(v) : v]))];
  }
  return out;
}

function steps(cmd) {
  const list = [];
  for (const [k, v] of Object.entries(cmd)) {
    if (RESERVED.has(k)) continue;
    // true / null 表示无参数调用，如 { "remove": true }
    list.push([k, ...(v === true || v === null ? [] : Array.isArray(v) ? v : [v])]);
  }
  if (cmd.do !== undefined) {
    if (!Array.isArray(cmd.do)) throw new ExecError('"do" 必须是 [["方法", 参数...], ...]');
    for (const s of cmd.do) {
      if (!Array.isArray(s) || typeof s[0] !== 'string') throw new ExecError('"do" 的每一项必须是 ["方法", 参数...]');
      list.push(s);
    }
  }
  return list;
}

function checkExpect(expect, count) {
  if (expect === undefined) return;
  const ok = typeof expect === 'number' ? count === expect : (expect.min === undefined || count >= expect.min) && (expect.max === undefined || count <= expect.max);
  if (!ok) throw new ExecError(`期望匹配 ${JSON.stringify(expect)} 个元素，实际 ${count} 个`, undefined, { expected: expect, actual: count });
}

function runOne(doc, cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new ExecError('每条指令必须是对象，形如 { "$": "选择器", "attr": [...] }');
  if (typeof cmd.$ !== 'string' && !(cmd.$ && typeof cmd.$ === 'object')) throw new ExecError('缺少 "$"：选择器字符串，或要新建的 JSON 对象');
  let sel = doc.$(cmd.$);
  checkExpect(cmd.expect, sel.length);
  const result = { count: sel.length };
  for (const [method, ...rawArgs] of steps(cmd)) {
    if (READ.has(method)) {
      result.value = method === 'count' ? sel.length : sel[method](...rawArgs);
      continue;
    }
    const isGetter =
      VALUE_METHODS.has(method) &&
      ((rawArgs.length === GETTER_ARITY[method] && typeof rawArgs[0] !== 'object') || (method === 'css' && rawArgs.length === 1 && Array.isArray(rawArgs[0])));
    if (isGetter) {
      result.value = sel[method](...rawArgs);
      continue;
    }
    if (!TRAVERSE.has(method) && !WRITE.has(method)) {
      throw new ExecError(`不支持的方法 "${method}"。可用：遍历 ${[...TRAVERSE].join(' ')}；修改 ${[...WRITE].join(' ')}；读取 ${[...READ].join(' ')}`);
    }
    if ((method === 'filter' || method === 'not') && typeof rawArgs[0] !== 'string') throw new ExecError(`${method} 在指令中只接受选择器字符串`);
    const r = sel[method](...prepareArgs(method, rawArgs));
    if (r instanceof Selection) sel = r;
    result.count = sel.length;
  }
  return result;
}

/**
 * 执行一批声明式指令，整体原子。
 * @param {import('./doc.js').JsonDoc} doc
 * @param {object|object[]} commands
 * @param {{ dryRun?: boolean }} options dryRun 时在副本上执行，只返回结果和补丁，不修改 doc
 * @returns {{ results: object[], patch: object[], version: number, applied: boolean }}
 */
export function exec(doc, commands, { dryRun = false } = {}) {
  const list = Array.isArray(commands) ? commands : [commands];
  const target = dryRun ? doc.fork() : doc;
  const results = [];
  let i = 0;
  try {
    const { patch, version } = target.transaction(() => {
      for (i = 0; i < list.length; i++) results.push(runOne(target, list[i]));
    }, { kind: 'exec' });
    return { results, patch: patch || [], version: dryRun ? doc.version : version, applied: !dryRun };
  } catch (e) {
    if (e instanceof ExecError && e.index === undefined) {
      const err = new ExecError(e.message, i, { expected: e.expected, actual: e.actual });
      throw err;
    }
    if (e && typeof e === 'object' && !('commandIndex' in e)) e.commandIndex = i;
    throw e;
  }
}

/** 给 Agent 工具调用（function calling）用的 JSON Schema */
export const execSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'jsonjq exec commands',
  description:
    '对 JSON 文档执行的一批声明式指令（jQuery for JSON），整体原子执行。每条指令用 "$" 选中元素，再按顺序调用方法；参数只能是 JSON。',
  type: 'array',
  items: {
    type: 'object',
    required: ['$'],
    properties: {
      $: { description: 'CSS 选择器，如 "segment#offer > text[start>=2]"；或一个 JSON 对象表示新建元素', type: ['string', 'object'] },
      expect: {
        description: '断言匹配数量，不符合则整批回滚',
        oneOf: [{ type: 'integer', minimum: 0 }, { type: 'object', properties: { min: { type: 'integer' }, max: { type: 'integer' } } }],
      },
      do: {
        description: '按顺序调用的方法：[["方法", 参数...], ...]',
        type: 'array',
        items: { type: 'array', prefixItems: [{ type: 'string', enum: [...TRAVERSE, ...WRITE, ...READ] }] },
      },
      note: { type: 'string', description: '说明，不参与执行' },
    },
    additionalProperties: {
      description:
        '简写：键是方法名，值是参数（数组表示参数列表，其他值表示唯一参数）。按键的顺序执行。数值类参数可用值运算 {"$add":n} {"$mul":n} {"$round":位数} {"$prefix":s} {"$suffix":s} {"$replace":[a,b]} {"$default":v}',
    },
  },
};
