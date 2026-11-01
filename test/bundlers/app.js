// 打包器测试用的页面脚本：在 worker 里跑两个脚本任务，结果写到 window.__result
import jqson, { parallel } from 'jqson';

const doc = jqson({
  type: 'project',
  id: 'p',
  children: [{ type: 'segment', id: 's1', children: [{ type: 'text', id: 't1', start: 1 }, { type: 'text', id: 't2', start: 2 }] }],
});
try {
  const reports = await parallel(
    doc,
    [{ script: "$('text').attr('start', (i, v) => v + 10)" }, { script: "$('#s1').attr('mark', args.m)", args: { m: 'ok' } }],
    { threads: 2 },
  );
  window.__result = {
    applied: reports.map((r) => r.applied),
    errors: reports.filter((r) => r.error).map((r) => r.error.message),
    starts: doc.$('text').pluck('start'),
    mark: doc.$('#s1').attr('mark'),
  };
} catch (e) {
  window.__result = { errors: [String(e?.message || e)] };
}
