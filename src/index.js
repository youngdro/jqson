import { JsonDoc, Selection, ValidationError, ConflictError, findConflicts, publicOp } from './doc.js';

export { JsonDoc, Selection, ValidationError, ConflictError, findConflicts, publicOp };
export { parseSelector, parseRelativeSelector, SelectorError } from './selector.js';
export { parallel, createPool } from './parallel.js';
export { runScript, compileScript } from './script.js';
export { help, inspect, explain };

import { help, inspect, explain } from './help.js';

/** doc.describe() 等同 inspect(doc)；doc.help(q) 等同 help(q) */
JsonDoc.prototype.describe = function describe(options) {
  return inspect(this, options);
};
JsonDoc.prototype.help = help;

/** 创建文档：const doc = jsondom(json); doc.$('clip.caption').attr('style.color', '#fff') */
export function jsondom(data, options) {
  return new JsonDoc(data, options);
}

export default jsondom;
