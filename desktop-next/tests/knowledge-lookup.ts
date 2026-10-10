import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as XLSX from 'xlsx';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { TaskRepository } from '../electron/task-repository';
import { TaskRuntime } from '../electron/task-runtime';
import { runReadonlyTool, taskFile } from '../electron/task-tools';
import { Permissions, defaultPermissions } from '../electron/permissions';
import type { KnowledgeSearch, KnowledgeRange, TableQuery, TableDescription } from '../shared/knowledge-lookup';
import type { TaskMember, TaskSendInput, WireCall } from '../shared/contracts';
import type { SourceTable } from '../shared/knowledge';

const [resourceRoot, output, worker, realReport, corpus, crashProfile] = process.argv.slice(2);
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const call = (name: string, input: object): WireCall => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } });
const model = { id: 'controlled', label: '协议验收', model: 'controlled', baseUrl: 'http://127.0.0.1', protocol: 'openai' as const, configured: true, apiKey: '' };
const models = { list: () => [model], resolve: () => model };
const input = (): TaskSendInput => ({ requestId: crypto.randomUUID(), taskId: '', expertId: 'finance-expert', groupId: '', model: 'Auto', directory: '', projectId: '', text: '冻结来源版本验收', attachments: [] });
const norm = (value: string) => value.normalize('NFKC').replace(/[\s*`_]/g, '').toLowerCase();
async function main() {
  if (realReport === '--crash-child') {
    const profile = crashProfile, library = new ExpertLibrary(resourceRoot, profile), resources = new ResourceStore(resourceRoot, profile, library, worker), repository = new TaskRepository(profile);
    let round = 0;
    const runtime = new TaskRuntime(repository, library, resources, models, profile, () => {}, async () => {
      if (++round === 1) return { text: '', calls: [call('read_knowledge', { id: fs.readFileSync(path.join(profile, 'source-id'), 'utf8') })] };
      console.log(JSON.stringify({ taskId: repository.views()[0].id })); return new Promise(() => {});
    });
    runtime.send(input()); return;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-lookup-'));
  const library = new ExpertLibrary(resourceRoot, profile); library.installExpert('finance-expert'); library.installExpert('hr-expert');
  let resources = new ResourceStore(resourceRoot, profile, library, worker);
  let repository = new TaskRepository(profile);
  const permissions = new Permissions(profile, id => library.detail(id));
  const checks: string[] = [];
  const check = async (name: string, test: () => Promise<void>) => { await test(); checks.push(name); console.log(name); };
  const collection = () => resources.read('').collections.find(c => !c.builtin)!.id;
  const member = (expertId = 'finance-expert'): TaskMember => ({ expertId, name: expertId, avatar: '', model: model.id, directory: '', system: '', skills: [], knowledge: resources.captureKnowledge(expertId).map(s => ({ ...s, content: '' })) });
  const tool = async (m: TaskMember, name: string, args: object) => JSON.parse(await runReadonlyTool(m, call(name, args), resources.lookup));
  const importFile = async (file: string) => { const batch = await resources.knowledge.start(collection(), '', [file], 'files'); for (let i = 0; i < 1000; i++) { const result = resources.knowledge.list(collection(), '').find(b => b.id === batch.id)!; if (!['running', 'queued'].includes(result.state)) { assert(!result.items.some(item => item.state === 'failed'), JSON.stringify(result)); return result; } await pause(); } throw new Error('Import timed out'); };
  try {
    resources.saveCollection('', '范围与版本验收'); resources.bind('finance-expert', [collection()]); resources.bind('hr-expert', []);
    const text = path.join(profile, '长文.txt'); fs.writeFileSync(text, '# 冻结来源\n## 长段\n' + Array.from({ length: 1500 }, (_, i) => `原文行 ${i + 1}：测试长文用于尾部范围定位。`).join('\n') + '\n## 尾部证据\n旧版本证据 VERSION62709\n术语 RetentionTier HOT WARM COLD\n');
    await importFile(text); const textDoc = resources.documents(collection(), '')[0], id = `${collection()}/${textDoc.id}`;
    const rows: unknown[][] = [['项目', '值', '值', '编号']]; for (let i = 1; i <= 6001; i++) rows.push([`行${i}`, i, '', i === 6001 ? '0012345678901234567890' : '']);
    rows[3000] = ['第二表块', '等级', '动作', '标记']; rows[3001] = ['第二块来源', '一级', '禁止放电', '原式不可补值'];
    rows[4500] = ['重复', '重复', '重复_2', 'A']; rows[4501] = ['v1', 'v2', 'v3', '物理列值'];
    const sheet = XLSX.utils.aoa_to_sheet(rows); sheet.B2.f = 'SUM(B3:B4)'; sheet.C2 = { t: 'n', f: 'SUM(B3:B4)' }; sheet['!merges'] = [{ s: { r: 5, c: 0 }, e: { r: 5, c: 1 } }];
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '完整网格'); const excel = path.join(profile, '完整表.xlsx'); fs.writeFileSync(excel, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })); await importFile(excel);
    const tableId = `${collection()}/${resources.documents(collection(), '').find(d => d.name === '完整表.xlsx')!.id}`;
    const captured = member();
    await check('Unified resource and expert lookup agree, including evidence beyond preview limits', async () => {
      const a = await resources.queryKnowledge('finance-expert', collection(), { operation: 'search', query: 'VERSION62709' }) as KnowledgeSearch;
      const b = await tool(captured, 'search_knowledge', { query: 'VERSION62709' }); assert.deepEqual(a, b); assert.equal(a.chunks[0].id, id); assert(a.chunks[0].lineStart > 1000);
      const read = await tool(captured, 'read_knowledge', { id, section: '尾部证据' }); assert(read.content.includes('VERSION62709')); assert.equal(read.version, textDoc.sourceVersion);
      const section = await tool(captured, 'read_knowledge', { id, section: '长段' }); assert(section.nextLine); const continued = await tool(captured, 'read_knowledge', { id, section: '长段', lineStart: section.nextLine }); assert.equal(continued.lineStart, section.nextLine); assert(continued.lineStart > section.lineEnd); assert(!continued.content.includes('VERSION62709'));
      const tail = await tool(captured, 'search_knowledge', { query: '0012345678901234567890' }); assert.equal(tail.chunks[0].id, tableId); assert(tail.chunks[0].tables[0].addresses.includes('D6002'));
      assert.equal((await tool(captured, 'search_knowledge', { query: 'RetentionTier HOT WARM COLD' })).chunks[0].id, id);
      assert.equal((await tool(captured, 'search_knowledge', { query: 'version62709', caseSensitive: true })).chunks.length, 0);
      assert.equal((await tool(captured, 'search_knowledge', { query: 'version62709' })).chunks[0].id, id);
      assert.equal((await tool(captured, 'search_knowledge', { query: '长文 "不在原文的短语"' })).chunks.length, 0);
      const legacy = { ...captured, knowledge: [taskFile('legacy/old.md', '旧任务原文', '历史来源', '旧任务保留的事实 OLD62709')] };
      assert((await tool(legacy, 'read_knowledge', { id: 'legacy/old.md' })).content.includes('OLD62709'));
      legacy.knowledge[0].content = '被改过的旧任务'; await assert.rejects(tool(legacy, 'read_knowledge', { id: 'legacy/old.md' }), /快照哈希/);
      await assert.rejects(tool(captured, 'read_knowledge', { id, lineStart: -1 }), /范围/);
      for (const query of ['不存在编号 XYZ998877', '量子宇宙飞船差旅规范']) assert.equal((await tool(captured, 'search_knowledge', { query })).chunks.length, 0);
    });
    await check('Full grid queries retain duplicate columns, physical tail, formulas and deterministic aggregates', async () => {
      const desc = await tool(captured, 'describe_table', { id: tableId }) as TableDescription; assert.equal(desc.tables[0].rows, 6002); assert.equal(desc.tables[0].formulas, 2); assert.equal(desc.tables[0].missingFormulaValues, 1);
      const tail = await tool(captured, 'query_table', { id: tableId, sheet: '完整网格', filters: [{ column: '编号', operator: 'eq', value: '0012345678901234567890' }] }) as TableQuery;
      assert.equal(tail.rows[0].row, 6002); assert.equal(tail.rows[0].cells.find(c => c.address === 'B6002')!.value, 6001);
      const first = await tool(captured, 'query_table', { id: tableId, sheet: '完整网格', rowStart: 2, rowEnd: 2 }) as TableQuery; assert.equal(first.rows[0].cells.find(c => c.address === 'B2')!.formula, 'SUM(B3:B4)'); assert(first.columns.some(c => c.key === '值_2'));
      const sum = await tool(captured, 'query_table', { id: tableId, sheet: '完整网格', rowStart: 3, rowEnd: 4, aggregate: { column: 'B', operation: 'sum' } }) as TableQuery; assert.equal(sum.aggregate!.value, 5);
      const block = await tool(captured, 'query_table', { id: tableId, sheet: '完整网格', headerRow: 3001, rowStart: 3002, rowEnd: 3002, filters: [{ column: '等级', operator: 'eq', value: '一级' }] }) as TableQuery; assert.equal(block.rows[0].cells.find(c => c.address === 'C3002')!.value, '禁止放电');
      const duplicates = await tool(captured, 'query_table', { id: tableId, sheet: '完整网格', headerRow: 4501, rowStart: 4502, rowEnd: 4502, filters: [{ column: '重复_2_2', operator: 'eq', value: 'v3' }], columns: ['@D'] }) as TableQuery; assert.equal(duplicates.rows[0].cells[0].address, 'D4502'); assert.equal(duplicates.rows[0].cells[0].value, '物理列值');
      await assert.rejects(tool(captured, 'query_table', { id: tableId, sheet: '完整网格', headerRow: 4501, columns: ['A'] }), /冲突/);
      await assert.rejects(tool(captured, 'query_table', { id: tableId, sheet: '完整网格', rowStart: 2, rowEnd: 2, aggregate: { column: 'C', operation: 'sum' } }), /没有可聚合数值/);
      await assert.rejects(tool(captured, 'query_table', { id: tableId, sheet: '完整网格', filters: [{ column: 'B', operator: 'gt', value: '2' }] }), /数值/);
    });
    await check('Scope is enforced before indexing and for every read/table route; tool policy still applies', async () => {
      await assert.rejects(resources.queryKnowledge('hr-expert', collection(), { operation: 'search', query: 'VERSION62709' }), /未绑定/);
      for (const operation of ['read', 'describe', 'table'] as const) await assert.rejects(resources.lookup.execute(resources.lookup.taskSources(member('hr-expert').knowledge), { operation, id: tableId, sheet: '完整网格' }), /授权范围/);
      assert.equal((await resources.queryKnowledge('hr-expert', '', { operation: 'search', query: 'VERSION62709' }) as KnowledgeSearch).chunks.length, 0);
      const config = defaultPermissions(); config.policies.query_table = 'deny'; permissions.save('finance-expert', config); assert.equal(permissions.decision(captured, call('query_table', { id: tableId, sheet: '完整网格' })), 'deny');
      config.policies.query_table = 'ask'; permissions.save('finance-expert', config); assert.equal(permissions.decision(captured, call('query_table', { id: tableId, sheet: '完整网格' })), 'ask');
    });
    await check('A killed task resumes its original version after reimport and unbinding; new tasks cannot read it', async () => {
      resources.close(); repository.close(); fs.writeFileSync(path.join(profile, 'source-id'), id);
      const child = spawn(process.execPath, [process.argv[1], resourceRoot, output, worker, '--crash-child', '', profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const checkpoint = await new Promise<{ taskId: string }>((resolve, reject) => { let out = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Crash checkpoint timed out')); }, 30000); child.stdout.on('data', data => { out += data; const line = out.split('\n').find(item => item.startsWith('{"taskId"')); if (line) { clearTimeout(timer); resolve(JSON.parse(line)); } }); child.on('exit', code => reject(new Error('Child exited before checkpoint: ' + code))); child.stderr.on('data', data => process.stderr.write(data)); });
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      resources = new ResourceStore(resourceRoot, profile, library, worker); repository = new TaskRepository(profile);
      const before = repository.get(checkpoint.taskId); assert.equal(before.status, 'interrupted'); assert(before.members[0].knowledge.every(s => s.reference && s.content === ''));
      const frozen = JSON.stringify(before.members[0].knowledge), oldWire = before.checkpoint.wire.find(m => m.role === 'tool')!.content;
      fs.writeFileSync(text, '新版来源 VERSION98731'); await importFile(text); resources.bind('finance-expert', []);
      assert.equal(resources.captureKnowledge('finance-expert').length, 0);
      let rounds = 0;
      const runtime = new TaskRuntime(repository, library, resources, models, profile, () => {}, async (_config, messages) => {
        if (++rounds === 1) { assert(messages.some(m => m.role === 'tool' && m.content === oldWire)); return { text: '', calls: [call('read_knowledge', { id, section: '尾部证据' }), call('query_table', { id: tableId, sheet: '完整网格', rowStart: 6002 })] }; }
        assert(messages.some(m => m.role === 'tool' && m.content.includes('VERSION62709'))); assert(!messages.some(m => m.role === 'tool' && m.content.includes('VERSION98731'))); return { text: '原版本任务恢复通过', calls: [] };
      });
      runtime.resume(before.id, crypto.randomUUID()); for (let i = 0; i < 1000 && repository.get(before.id).status !== 'completed'; i++) await pause();
      const done = repository.get(before.id); assert.equal(done.status, 'completed'); assert.equal(JSON.stringify(done.members[0].knowledge), frozen);
      runtime.close(); const ref = captured.knowledge[0].reference!, frozenBody = path.join(resources.lookup.root, ref.key, 'body.md'); fs.appendFileSync(frozenBody, '\n篡改'); await assert.rejects(tool(captured, 'read_knowledge', { id: captured.knowledge[0].id }), /哈希/);
    });
    const result: Record<string, unknown> = { ok: true, platform: process.platform, arch: process.arch, checks };
    if (realReport && corpus) result.real = await realBenchmark(realReport, corpus);
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
  } finally { permissions.close(); resources.close(); repository.close(); library.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
async function realBenchmark(reportFile: string, corpusRoot: string) {
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')), profile = path.join(path.dirname(output), `knowledge-lookup-real-${Date.now()}`); fs.cpSync(report.profile, profile, { recursive: true });
  const library = new ExpertLibrary(resourceRoot, profile), store = new ResourceStore(resourceRoot, profile, library, worker);
  try {
    const collection = store.read('').collections.find(c => c.title === '共同真实资料')?.id ?? store.read('').collections.filter(c => !c.builtin).find(c => store.documents(c.id, '').some(d => d.id === `imports/${report.real[0].documentId}.md`))!.id;
    const corpusManifest = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
    const selected = new Set(report.real.map((item: any) => `imports/${item.documentId}.md`));
    // This disposable copy must represent exactly the original 17-document corpus in both UI and task scopes.
    for (const doc of store.documents(collection, '')) if (!selected.has(doc.id)) store.removeDocument(collection, doc.id, store.readDocument(collection, doc.id, '').revision, '');
    library.installExpert('finance-expert'); store.bind('finance-expert', [collection]);
    const sources = store.captureKnowledge('finance-expert'), documents = report.real.map((item: any) => ({ benchmarkId: item.benchmarkId, documentId: item.documentId, source: sources.find(s => s.id.endsWith(`/imports/${item.documentId}.md`))! }));
    assert.equal(documents.length, 17); assert.equal(sources.length, 17); assert(documents.every((d: any) => d.source));
    const originals = documents.map((doc: any) => { const item = report.real.find((i: any) => i.benchmarkId === doc.benchmarkId), file = store.knowledge.original(collection, item.documentId, item.version, 'finance-expert'), expected = corpusManifest.documents.find((d: any) => d.id === doc.benchmarkId); const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); assert.equal(actual, expected.sha256); assert.equal(doc.source.reference.version, item.version); return { id: doc.benchmarkId, version: item.version, sha256: actual }; });
    const member: TaskMember = { expertId: 'finance-expert', name: '财研', avatar: '', model: 'controlled', directory: '', system: '', skills: [], knowledge: sources.map(s => ({ ...s, content: '' })) };
    const tool = async (name: string, input: object) => JSON.parse(await runReadonlyTool(member, call(name, input), store.lookup));
    const gold = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'gold.json'), 'utf8')), queries = [];
    for (const item of gold.cases) for (const variant of ['keywords', 'question']) {
      const expected = documents.find((d: any) => d.benchmarkId === item.doc)!.source.id, at = performance.now();
      const search = await tool('search_knowledge', { query: item[variant] }) as KnowledgeSearch;
      queries.push({ case: item.id, variant, query: item[variant], expected, ids: search.chunks.map(c => c.id), found: search.chunks.some(c => c.id === expected), ms: performance.now() - at, response: search });
    }
    const negatives = []; for (const query of gold.negative_queries) { const response = await tool('search_knowledge', { query: typeof query === 'string' ? query : query.query }); negatives.push({ query, ok: response.chunks.length === 0, response }); }
    const contents = new Map<string, { content: string; ranges: unknown[] }>(), formulaActual: Array<{ sheet: string; address: string; formula: string }> = [];
    for (const document of documents) {
      const source = document.source, content: string[] = [], ranges = []; let next = 1;
      do { const result = await tool('read_knowledge', { id: source.id, lineStart: next }) as KnowledgeRange; content.push(result.content); ranges.push({ lineStart: result.lineStart, lineEnd: result.lineEnd, locations: result.locations }); next = result.nextLine ?? 0; } while (next);
      const describe = await tool('describe_table', { id: source.id }) as TableDescription;
      for (const sheet of describe.tables) { let offset = 0; do { const result = await tool('query_table', { id: source.id, sheet: sheet.sheet, rowStart: 1, offset, limit: 200 }) as TableQuery; content.push(...result.rows.flatMap(row => row.cells.map(cell => cell.display))); if (document.benchmarkId === 'd11') formulaActual.push(...result.rows.flatMap(row => row.cells.filter(cell => cell.formula).map(cell => ({ sheet: sheet.sheet, address: cell.address, formula: cell.formula! })))); offset = result.nextOffset ?? 0; } while (offset); }
      contents.set(document.benchmarkId, { content: norm(content.join('\n')), ranges });
    }
    const evidence = gold.cases.map((item: any) => { const source = documents.find((d: any) => d.benchmarkId === item.doc)!.source, data = contents.get(item.doc)!; return { case: item.id, found: item.groups.every((group: string[]) => group.some(text => data.content.includes(norm(text)))), version: source.reference.version, ranges: data.ranges }; });
    const sourceBook = XLSX.read(fs.readFileSync(corpusManifest.documents.find((d: any) => d.id === 'd11').input), { type: 'buffer', cellFormula: true });
    const expectedFormulas = sourceBook.SheetNames.flatMap(sheet => Object.entries(sourceBook.Sheets[sheet]).filter(([address, cell]) => !address.startsWith('!') && cell.f).map(([address, cell]) => ({ sheet, address, formula: cell.f })));
    const order = (a: object, b: object) => JSON.stringify(a).localeCompare(JSON.stringify(b)); expectedFormulas.sort(order); formulaActual.sort(order);
    assert.equal(expectedFormulas.length, 171); assert.deepEqual(formulaActual, expectedFormulas, 'The tool must return the original formula at the same physical cell');
    const tableGold = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'table-gold.json'), 'utf8')), tables = [];
    for (const item of tableGold.cases) {
      const source = documents.find((d: any) => d.benchmarkId === item.id)!.source;
      const response = await tool('query_table', { id: source.id, sheet: item.sheet, filters: Object.entries(item.filter).map(([column, value]) => ({ column, operator: 'eq', value })) }) as TableQuery;
      const ok = response.rows.some(row => Object.entries(item.expected).every(([key, value]) => { const column = response.columns.find(c => c.key === key); return column && norm(String(row.cells.find(c => c.column === column.column)?.display ?? '')) === norm(String(value)); }));
      tables.push({ ...item, ok, response });
    }
    const result = { profile, originals, formulas: { count: formulaActual.length, exact: true }, documents: documents.map((d: any) => ({ id: d.benchmarkId, source: d.source })), sourceRecall: queries.filter(q => q.found).length, queryCount: queries.length, queries, negative: negatives, evidencePassed: evidence.filter(e => e.found).length, evidence, tables };
    fs.writeFileSync(path.join(path.dirname(output), 'lookup-real-results.json'), JSON.stringify(result, null, 2));
    assert(queries.filter(q => q.found).length >= 51, 'Source recall must not regress below the best measured Soul/PAP baseline; the offline RRF target is reported separately'); assert(negatives.every(n => n.ok), 'Absent evidence must not produce a positive result'); assert.equal(evidence.filter(e => e.found).length, 28, 'Preserve all available evidence; the known OCR defect must remain explicit'); assert(tables.every(t => t.ok), 'Physical table associations must pass');
    return result;
  } finally { store.close(); library.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
