// 类型检查用例：npm run typecheck
import jsonjq, { exec, execSchema, parallel, runScript, syncTo, help, inspect, explain, ValidationError, JsonDoc, Selection } from 'jsonjq';

interface Project { type: 'project'; id: string; children: { type: string; id: string; text?: string }[] }
const data: Project = { type: 'project', id: 'p', children: [{ type: 'text', id: 't', text: 'a' }] };

const doc = jsonjq(data, { mode: 'immutable', batch: (run) => run() });
const state: Project = doc.state;
const s: Selection = doc.$('text').attr('start', (i, v) => v + i).addClass('x').css({ fontSize: 40 });
const n: number = s.length;
const ids: string[] = doc.$('text').map((i, el) => el.id as string);
const txt: string = doc.$('#t').text();
doc.$('#t').clone().attr('id', 'u').appendTo('#p').first();
doc.transaction((d) => d.$('#t').remove());
doc.on((e) => e.patch.forEach((op) => op.path));
doc.use(({ touched }) => touched.map((t) => ({ message: String(t.id) })));
const stop = doc.syncTo({}, { batch: (r) => r() });
stop();
async function run() {
  const reports = await parallel(doc, [async (f) => f.$('#t').text('b'), { script: "$('#t').text('c')" }], { policy: 'skip' });
  reports[0].applied;
  await runScript(doc, "return $('text').length", { args: {} });
}
const h: string = help('attr');
const r = explain('text');
if (r.ok) r.parts.join();
inspect(doc).tags;
try { doc.undo(); } catch (e) { if (e instanceof ValidationError) e.errors; }
jsonjq.fn.shift = function (this: Selection, dt: number) { return this.attr('start', (i, v) => v + dt); };
const d2: JsonDoc = doc.fork();
const er = doc.exec([{ $: 'text', expect: 1, css: { fontSize: { $mul: 1.1 } } }, { $: '#t', do: [['addClass', 'a']] }], { dryRun: true });
er.results[0].count;
void [exec, execSchema, state, n, ids, txt, run, h, d2, syncTo];
