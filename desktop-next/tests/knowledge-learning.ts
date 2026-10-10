import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { KnowledgeLearning } from '../electron/knowledge/learning-store';
import { callKnowledgeModel } from '../electron/task-models';
import type { ModelCall } from '../electron/task-models';

const [resourceRoot, output, worker, mode, childProfile] = process.argv.slice(2);
const model = { id: 'controlled', label: '受控协议验收', model: 'controlled', baseUrl: 'http://127.0.0.1/v1', protocol: 'openai' as const, configured: true, apiKey: 'LOCAL-TEST-ONLY' };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function main() {
  const profile = mode === '--crash-child' ? childProfile : fs.mkdtempSync(path.join(os.tmpdir(), 'soul-learning-'));
  const library = new ExpertLibrary(resourceRoot, profile); const resources = new ResourceStore(resourceRoot, profile, library, worker);
  if (mode === '--crash-child') {
    const learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, async () => { console.log('CALL-STARTED'); return new Promise(() => {}); }, () => {});
    const spec = JSON.parse(fs.readFileSync(path.join(profile, 'crash-spec.json'), 'utf8'));
    learning.start(learning.preview(spec).token, 'finance-expert'); return;
  }
  const checks: string[] = []; let learning: KnowledgeLearning | undefined;
  const check = async (name: string, action: () => Promise<void>) => { await action(); checks.push(name); console.log(name); };
  const wait = async (id: string) => { for (let i = 0; i < 500; i++) { const job = learning!.read(id, 'finance-expert'); if (job.state !== 'running') return job; await pause(); } throw new Error('Learning did not settle'); };
  try {
    library.installExpert('finance-expert'); library.installExpert('hr-expert'); resources.saveCollection('', '独立派生验收');
    const collectionId = resources.read('').collections.find(item => !item.builtin)!.id;
    resources.bind('finance-expert', [collectionId]); resources.bind('hr-expert', []);
    const text = '# 来源\n英维克保修 5 年；盖鼎保修 2 年。\n原始资料存在歧义时须说明。';
    resources.saveDocument({ collectionId, id: '', name: '保修.md', content: text, revision: '' }, '');
    const documentId = resources.documents(collectionId, '')[0].id;
    const spec = { collectionId, documentId, scope: 'finance-expert', model: 'Auto', lineStart: 1, lineEnd: 3 };
    let calls = 0; const good: ModelCall = async () => { calls++; return { text: JSON.stringify({ notes: [{ text: '英维克保修为 5 年，盖鼎为 2 年，需参照原件适用条件。', quote: text.split('\n')[1], lineStart: 2, lineEnd: 2 }], gaps: ['适用条件未提供'] }), calls: [], usage: { inputTokens: 50, outputTokens: 25 } }; };
    learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, good, () => {});
    await check('Preview is free; same source/model/range is one independent operation, without rewriting source or ordinary chat', async () => {
      const preview = learning!.preview(spec); assert.equal(calls, 0); assert.equal(preview.chunks, 1);
      const first = learning!.start(preview.token, spec.scope); assert(learning!.isBusy()); const job = await wait(first.id);
      assert.equal(job.state, 'completed'); assert.equal(job.parts[0].usage!.inputTokens, 50); assert.equal(job.parts[0].notes[0].quote, text.split('\n')[1]);
      assert.equal(learning!.start(preview.token, spec.scope).id, first.id);
      assert.equal(learning!.start(learning!.preview(spec).token, spec.scope).id, first.id); assert.equal(calls, 1);
      model.label = '仅重命名模型'; assert.equal(learning!.start(learning!.preview(spec).token, spec.scope).id, first.id); assert.equal(calls, 1); model.label = '受控协议验收';
      assert.equal(resources.readDocument(collectionId, documentId, '').content, text);
      const stored = fs.readFileSync(path.join(profile, 'soul.sqlite')); assert(!stored.includes(model.apiKey));
      assert.throws(() => learning!.read(first.id, 'hr-expert'), /范围/);
      assert.throws(() => learning!.preview({ ...spec, scope: 'hr-expert' }), /未绑定/);
      resources.saveDocument({ collectionId, id: documentId, name: '保修.md', content: '# 新资料\n新版本不含保修期限', revision: resources.readDocument(collectionId, documentId, '').revision }, '');
      assert.equal(learning!.read(first.id, spec.scope).parts[0].notes[0].quote, text.split('\n')[1]);
      learning!.close(); learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, good, () => {});
      assert.equal(learning.read(first.id, spec.scope).version, preview.version); assert.equal(calls, 1);
      learning.close();
      const db = new Database(path.join(profile, 'soul.sqlite')); const storedJob = JSON.parse((db.prepare('SELECT value FROM knowledge_learning_v1 WHERE id=?').get(first.id) as { value: string }).value);
      storedJob.state = 'running'; storedJob.parts[0].state = 'received'; storedJob.parts[0].notes = [];
      db.prepare('UPDATE knowledge_learning_v1 SET value=? WHERE id=?').run(JSON.stringify(storedJob), first.id); db.close();
      learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, good, () => {});
      assert.equal(learning.read(first.id, spec.scope).state, 'completed'); assert.equal(learning.read(first.id, spec.scope).parts[0].notes[0].quote, text.split('\n')[1]); assert.equal(calls, 1);
      resources.bind('finance-expert', []); assert.throws(() => learning!.read(first.id, spec.scope), /未绑定/); resources.bind('finance-expert', [collectionId]);
    });
    await check('Unverifiable citations are withheld and retry does not bill again', async () => {
      learning!.close(); learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, async () => { calls++; return { text: JSON.stringify({ notes: [{ text: '编造', quote: '原文不存在', lineStart: 1, lineEnd: 1 }], gaps: [] }), calls: [] }; }, () => {});
      const spec2 = { ...spec, lineEnd: 2 }, preview = learning.preview(spec2), job = await wait(learning.start(preview.token, spec.scope).id);
      assert.equal(job.state, 'interrupted'); assert.equal(job.parts[0].state, 'failed'); assert.equal(job.parts[0].notes.length, 0);
      const before = calls; learning.start(preview.token, spec.scope); assert.equal(calls, before);
      assert(job.parts[0].rawResponse!.includes('原文不存在'));
    });
    await check('Actual process crash keeps source version and unknown billing checkpoint; restart does not resend', async () => {
      learning!.close(); learning = undefined;
      fs.writeFileSync(path.join(profile, 'crash-spec.json'), JSON.stringify({ ...spec, lineStart: 2, lineEnd: 2 }));
      const child = spawn(process.execPath, [process.argv[1], resourceRoot, output, worker, '--crash-child', profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Child did not start model call')); }, 30_000); let stdout = ''; child.stdout!.on('data', chunk => { stdout += chunk; if (stdout.includes('CALL-STARTED')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); child.once('exit', code => { if (!stdout.includes('CALL-STARTED')) reject(new Error('Child exited before checkpoint ' + code)); }); });
      const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
      learning = new KnowledgeLearning(profile, resources, { resolve: () => model }, good, () => {});
      const job = learning.list(collectionId, documentId, spec.scope).find(item => item.lineStart === 2)!;
      assert.equal(job.state, 'interrupted'); assert.equal(job.parts[0].state, 'unknown'); const before = calls;
      assert.equal(learning.start(learning.preview({ ...spec, lineStart: 2, lineEnd: 2 }).token, spec.scope).id, job.id); await pause(); assert.equal(calls, before);
    });
    await check('OpenAI and Anthropic adapters make exactly one HTTP request with no tools or automatic retry', async () => {
      let requests = 0, status = 200; const bodies: any[] = [];
      const server = http.createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { requests++; bodies.push(JSON.parse(body)); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url!.endsWith('/messages') ? { content: [{ type: 'text', text: '{"notes":[],"gaps":[]}' }], usage: { input_tokens: 10, output_tokens: 5 } } : { choices: [{ message: { content: '{"notes":[],"gaps":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
      try { for (const protocol of ['openai', 'anthropic'] as const) { const reply = await callKnowledgeModel({ ...model, protocol, baseUrl }, [{ role: 'system', content: '独立整理' }, { role: 'user', content: '来源' }], new AbortController().signal, () => {}); assert.equal(reply.usage!.inputTokens, 10); } status = 503; await assert.rejects(callKnowledgeModel({ ...model, protocol: 'anthropic', baseUrl }, [{ role: 'user', content: '失败' }], new AbortController().signal, () => {}), /503/); assert.equal(requests, 3); for (const body of bodies) { assert.equal(body.max_tokens, 8192); assert(!body.tools); } }
      finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, checks }, null, 2));
  } finally { learning?.close(); resources.close(); library.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
