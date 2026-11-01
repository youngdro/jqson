// 文档里的示例必须能跑：README / skill 中的 exec 指令和 JSON Patch 都在示例工程上执行一遍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jqson from '../src/index.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const data = JSON.parse(read('examples/video-project.json'));

for (const file of ['README.md', 'README.en.md', 'skills/jqson/SKILL.md']) {
  if (!fs.existsSync(new URL(`../${file}`, import.meta.url))) continue;
  test(`${file} 中的 JSON 示例可以执行`, () => {
    const blocks = [...read(file).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    assert.ok(blocks.length > 0);
    for (const b of blocks) {
      const doc = jqson(data);
      if (Array.isArray(b) && b[0]?.op) doc.applyPatch(b);
      else assert.ok(doc.exec(b, { dryRun: true }).patch.length > 0);
    }
  });
}
