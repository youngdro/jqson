// CSS 选择器解析器：把选择器字符串编译成结构化的 AST，结果按字符串缓存。
//
// 支持：
//   类型       clip      *                      （匹配节点的 type 字段，没有 type 时匹配所在属性名）
//   id/class   #intro    .caption
//   属性       [a] [a=v] [a!=v] [a^=v] [a$=v] [a*=v] [a~=v] [a|=v]
//              [a>v] [a>=v] [a<v] [a<=v]   （数值比较，扩展语法）
//              [style.color=red]           （点号路径读取嵌套字段）
//              [name="x" i]                （大小写不敏感）
//   组合符     后代(空格)  >  +  ~   以及逗号分组
//   伪类       :first-child :last-child :only-child :nth-child(an+b) :nth-last-child(an+b)
//              :first :last（在同一父节点下按位置） :root :empty
//              :not(sel) :is(sel) :has(sel) :has(> sel) :key(name)

const cache = new Map();
const CACHE_LIMIT = 500;

export function parseSelector(source) {
  let hit = cache.get(source);
  if (hit) return hit;
  hit = new Parser(source).parseList();
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(source, hit);
  return hit;
}

/** 相对选择器（可以 > + ~ 开头），用于 find() 等以某些元素为起点的查询 */
export function parseRelativeSelector(source) {
  const key = '\u0000rel:' + source;
  let hit = cache.get(key);
  if (hit) return hit;
  hit = new Parser(source).parseList(true);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, hit);
  return hit;
}

export class SelectorError extends Error {
  constructor(message, source, pos) {
    super(`${message} (selector "${source}" at ${pos}). 用 explain(selector) 定位，help('selectors') 查看语法`);
    this.name = 'SelectorError';
    this.selector = source;
    this.position = pos;
  }
}

const IDENT = /[A-Za-z0-9_\- -￿$@]/;
const ATTR_NAME = /[A-Za-z0-9_\- -￿$@.:]/;

class Parser {
  constructor(src) {
    this.src = src;
    this.i = 0;
  }

  fail(msg) {
    throw new SelectorError(msg, this.src, this.i);
  }

  peek() {
    return this.src[this.i];
  }

  ws() {
    const start = this.i;
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
    return this.i > start;
  }

  // 选择器列表：a, b > c
  parseList(allowLeadingCombinator = false) {
    const list = [];
    for (;;) {
      this.ws();
      list.push(this.parseComplex(allowLeadingCombinator));
      this.ws();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      break;
    }
    if (this.i < this.src.length && this.peek() !== ')') this.fail(`Unexpected "${this.peek()}"`);
    return list;
  }

  // 复合序列：compound (combinator compound)*
  parseComplex(allowLeadingCombinator) {
    const parts = [];
    let comb = null;
    this.ws();
    if (allowLeadingCombinator && '>+~'.includes(this.peek())) {
      comb = this.peek();
      this.i++;
      this.ws();
    }
    for (;;) {
      const compound = this.parseCompound();
      parts.push({ comb, compound });
      const hadWs = this.ws();
      const c = this.peek();
      if (c === undefined || c === ',' || c === ')') break;
      if (c === '>' || c === '+' || c === '~') {
        comb = c;
        this.i++;
        this.ws();
      } else if (hadWs) {
        comb = ' ';
      } else {
        this.fail(`Unexpected "${c}"`);
      }
    }
    return parts;
  }

  ident(re = IDENT) {
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === '\\') {
        this.i += 2;
        continue;
      }
      if (!re.test(c)) break;
      this.i++;
    }
    if (this.i === start) this.fail('Expected a name');
    return this.src.slice(start, this.i).replace(/\\(.)/g, '$1');
  }

  parseCompound() {
    const node = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
    let any = false;
    const c0 = this.peek();
    if (c0 === '*') {
      this.i++;
      node.tag = '*';
      any = true;
    } else if (c0 !== undefined && IDENT.test(c0)) {
      node.tag = this.ident();
      any = true;
    }
    for (;;) {
      const c = this.peek();
      if (c === '#') {
        this.i++;
        node.ids.push(this.ident());
      } else if (c === '.') {
        this.i++;
        node.classes.push(this.ident());
      } else if (c === '[') {
        this.i++;
        node.attrs.push(this.parseAttr());
      } else if (c === ':') {
        this.i++;
        node.pseudos.push(this.parsePseudo());
      } else break;
      any = true;
    }
    if (!any) this.fail('Expected a selector');
    return node;
  }

  parseAttr() {
    this.ws();
    const name = this.ident(ATTR_NAME);
    this.ws();
    let op = null;
    let value = null;
    let typed = false;
    let flag = null;
    const two = this.src.slice(this.i, this.i + 2);
    if (['!=', '^=', '$=', '*=', '~=', '|=', '>=', '<='].includes(two)) {
      op = two;
      this.i += 2;
    } else if ('=<>'.includes(this.peek())) {
      op = this.peek();
      this.i++;
    }
    if (op) {
      this.ws();
      const q = this.peek();
      if (q === '"' || q === "'") {
        this.i++;
        let s = '';
        while (this.i < this.src.length && this.src[this.i] !== q) {
          if (this.src[this.i] === '\\') this.i++;
          s += this.src[this.i++];
        }
        if (this.peek() !== q) this.fail('Unterminated string');
        this.i++;
        value = s;
      } else {
        const start = this.i;
        while (this.i < this.src.length && !/[\]\s]/.test(this.src[this.i])) this.i++;
        const raw = this.src.slice(start, this.i);
        if (raw === '') this.fail('Expected a value');
        // 未加引号的数字、布尔、null 按类型比较
        if (raw === 'true') (value = true), (typed = true);
        else if (raw === 'false') (value = false), (typed = true);
        else if (raw === 'null') (value = null), (typed = true);
        else if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) (value = Number(raw)), (typed = true);
        else value = raw;
      }
      this.ws();
      if (/[iIsS]/.test(this.peek() || '') && this.src[this.i + 1] !== undefined) {
        const f = this.peek().toLowerCase();
        const save = this.i;
        this.i++;
        this.ws();
        if (this.peek() === ']') flag = f;
        else this.i = save;
      }
      this.ws();
    }
    if (this.peek() !== ']') this.fail('Expected "]"');
    this.i++;
    const path = name.split('.');
    const cmp = typeof value === 'string' && flag === 'i' ? value.toLowerCase() : value;
    return { name, path, op, value: cmp, typed, insensitive: flag === 'i' };
  }

  parsePseudo() {
    const name = this.ident().toLowerCase();
    let arg = null;
    if (this.peek() === '(') {
      this.i++;
      if (name === 'not' || name === 'is' || name === 'where' || name === 'has') {
        arg = this.parseList(name === 'has');
      } else {
        const start = this.i;
        let depth = 0;
        while (this.i < this.src.length) {
          const c = this.src[this.i];
          if (c === '(') depth++;
          else if (c === ')') {
            if (depth === 0) break;
            depth--;
          }
          this.i++;
        }
        arg = this.src.slice(start, this.i).trim();
      }
      if (this.peek() !== ')') this.fail('Expected ")"');
      this.i++;
    }
    if (name === 'nth-child' || name === 'nth-last-child') arg = parseNth(arg, this);
    if (name === 'key' && arg) arg = arg.replace(/^["']|["']$/g, '');
    if (!KNOWN_PSEUDOS.has(name)) this.fail(`Unknown pseudo-class ":${name}"`);
    return { name: name === 'where' ? 'is' : name, arg };
  }
}

const KNOWN_PSEUDOS = new Set([
  'first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child',
  'first', 'last', 'root', 'empty', 'not', 'is', 'where', 'has', 'key',
]);

function parseNth(arg, parser) {
  const s = (arg || '').replace(/\s+/g, '').toLowerCase();
  if (s === 'odd') return { a: 2, b: 1 };
  if (s === 'even') return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (m) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    return { a, b: m[2] ? Number(m[2]) : 0 };
  }
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: Number(s) };
  parser.fail(`Bad nth expression "${arg}"`);
}

// 1-based 位置 pos 是否满足 an+b
export function nthMatches({ a, b }, pos) {
  if (a === 0) return pos === b;
  const n = (pos - b) / a;
  return Number.isInteger(n) && n >= 0;
}
