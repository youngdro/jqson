import { JsonDoc, Selection, ValidationError, ConflictError, findConflicts, publicOp } from './doc.js';

export { JsonDoc, Selection, ValidationError, ConflictError, findConflicts, publicOp };
export { parseSelector, parseRelativeSelector, SelectorError } from './selector.js';
export { parallel, createPool } from './parallel.js';
export { runScript, compileScript } from './script.js';
export { help, inspect, explain };
export { applyPatchTo, syncTo } from './sync.js';
export { exec, execSchema, ExecError, EXEC_METHODS } from './exec.js';
import { exec } from './exec.js';
import { syncTo } from './sync.js';

import { help, inspect, explain } from './help.js';

/** doc.describe() 等同 inspect(doc)；doc.help(q) 等同 help(q) */
JsonDoc.prototype.describe = function describe(options) {
  return inspect(this, options);
};
JsonDoc.prototype.help = help;
/** doc.exec(commands, { dryRun }) 等同 exec(doc, commands, { dryRun }) */
JsonDoc.prototype.exec = function (commands, options) {
  return exec(this, commands, options);
};
/** doc.syncTo(reactiveObj, { batch }) 等同 syncTo(doc, reactiveObj, { batch }) */
JsonDoc.prototype.syncTo = function (target, options) {
  return syncTo(this, target, options);
};

/** 创建文档：const doc = jsonjq(json); doc.$('clip.caption').attr('style.color', '#fff') */
export function jsonjq(data, options) {
  return new JsonDoc(data, options);
}

/** 插件扩展点，同 jQuery.fn：jsonjq.fn.myMethod = function () { return this } */
jsonjq.fn = Selection.prototype;
export const fn = Selection.prototype;

export default jsonjq;
