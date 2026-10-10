import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import type { KnowledgeImportBatch, SourceTable } from '../shared/knowledge';

const root = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]), worker = path.resolve(process.argv[4]);
const hash = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const terminal = (batch: KnowledgeImportBatch) => !['running', 'queued'].includes(batch.state);
async function wait(store: ResourceStore, collection: string, id: string): Promise<KnowledgeImportBatch> {
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) { const batch = store.knowledge.list(collection, '').find(b => b.id === id)!; if (terminal(batch)) return batch; await pause(80); }
  throw new Error('Knowledge batch timed out');
}

async function run(): Promise<void> {
if (process.argv[5] === '--crash-child') {
  const profile = process.argv[6], collection = process.argv[7], source = process.argv[8];
  const library = new ExpertLibrary(root, profile), store = new ResourceStore(root, profile, library, worker);
  void store.knowledge.start(collection, '', [source], 'files').then(batch => {
    console.log(JSON.stringify({ checkpoint: batch.id }));
    // Keep the actual process alive until the parent kills it at the file checkpoint.
    setInterval(() => {}, 1000);
  });
} else {
  const profile = process.argv[5] ? path.join(path.dirname(output), `knowledge-source-profile-${Date.now()}`) : fs.mkdtempSync(path.join(os.tmpdir(), 'soul-知识导入-'));
  fs.mkdirSync(profile, { recursive: true });
  const input = path.join(profile, 'test-input'); fs.mkdirSync(input);
  let library = new ExpertLibrary(root, profile), store = new ResourceStore(root, profile, library, worker);
  const checks: string[] = [];
  const check = async (title: string, test: () => void | Promise<void>) => { const at = Date.now(); await test(); checks.push(title); console.log(`${title}: ${Date.now() - at} ms`); };
  store.saveCollection('', '完整来源验收'); let collection = store.read('').collections.find(c => !c.builtin)!.id;
  const importFiles = async (files: string[]) => { const batch = await store.knowledge.start(collection, '', files, 'files'); return wait(store, collection, batch.id); };
  const write = (name: string, bytes: string | Buffer) => { const file = path.join(input, name); fs.writeFileSync(file, bytes); return file; };
  const table = (id: string) => {
    const manifest = store.knowledge.versions(collection, id, '')[0], file = path.join(profile, 'knowledge', collection, '_sources', id, 'versions', manifest.version, manifest.tables[0].path);
    assert.equal(hash(fs.readFileSync(file)), manifest.tables[0].sha256); return JSON.parse(fs.readFileSync(file, 'utf8')) as SourceTable;
  };
  try {
    await check('Original bytes, extraction signatures and source locations remain separate from editable cards', async () => {
      const file = write('来源.txt', '第一版来源：验收编号 62709。\n第二行证据。');
      const batch = await importFiles([file]); assert.equal(batch.items[0].state, 'ready');
      const doc = store.documents(collection, '')[0], manifest = store.knowledge.versions(collection, batch.items[0].documentId, '')[0];
      assert.equal(hash(fs.readFileSync(store.knowledge.original(collection, manifest.documentId, manifest.version, ''))), hash(fs.readFileSync(file)));
      assert.equal(store.readDocument(collection, doc.id, '').revision, manifest.bodySha256); assert.equal(manifest.locations[0].lineStart, 1);
      assert.throws(() => store.saveDocument({ collectionId: collection, id: doc.id, name: doc.name, content: '改写唯一来源', revision: manifest.bodySha256 }, ''), /确定性正文/);
      assert.equal(store.read('').collections.find(c => c.id === collection)!.documents, 1);
      const again = await importFiles([file]); assert.equal(again.items[0].state, 'reused'); assert.equal(again.items[0].version, manifest.version);
      assert.equal(store.knowledge.versions(collection, manifest.documentId, '').length, 1);
      fs.writeFileSync(file, '第二版来源：编号 98731。'); const updated = await importFiles([file]);
      assert.equal(updated.items[0].state, 'ready'); assert.notEqual(updated.items[0].version, manifest.version);
      assert.equal(store.knowledge.versions(collection, manifest.documentId, '').length, 2);
      assert.throws(() => store.knowledge.restore(collection, manifest.documentId, manifest.version, 'stale', ''), /已变更/);
      store.knowledge.restore(collection, manifest.documentId, manifest.version, updated.items[0].version, '');
      assert(store.readDocument(collection, doc.id, '').content.includes('62709'));
    });
    await check('Excel retains row 6002, duplicate columns, formulas, merges and every table block', async () => {
      const rows: unknown[][] = [['项目', '设计寿命', '设计寿命', '值', '']];
      for (let i = 1; i <= 6001; i++) rows.push([`行${i}`, '10年', '', i, i === 6001 ? '尾部目标' : '']);
      rows[3000] = ['第二表块', '告警级别', '控制动作', '值', '位置'];
      rows[3001] = ['簇端欠压', '一级', '禁止放电', 2.8, '第3002行'];
      const sheet = XLSX.utils.aoa_to_sheet(rows); sheet.D2.f = 'SUM(D3:D4)'; sheet['!merges'] = [{ s: { r: 5, c: 0 }, e: { r: 5, c: 1 } }];
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '多块真实行号');
      const file = write('完整表.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
      const batch = await importFiles([file]); assert.equal(batch.items[0].state, 'ready'); const source = table(batch.items[0].documentId);
      assert.equal(source.rows, 6002); assert.equal(source.cells.find(c => c.address === 'E6002')!.value, '尾部目标');
      assert.equal(source.cells.find(c => c.address === 'B2')!.value, '10年'); assert.equal(source.cells.find(c => c.address === 'C2')!.value, '');
      assert.equal(source.cells.find(c => c.address === 'D2')!.formula, 'SUM(D3:D4)'); assert.equal(source.merges[0].startRow, 6);
      assert(source.cells.some(c => c.row === 3002 && c.value === '禁止放电'));
      const body = store.readDocument(collection, `imports/${batch.items[0].documentId}.md`, '').content;
      assert(body.includes('预览')); assert(!body.includes('尾部目标')); // A preview is not the source table.
      const xls = write('旧格式.xls', XLSX.write(book, { type: 'buffer', bookType: 'biff8' }));
      const old = await importFiles([xls]); assert.equal(old.items[0].state, 'ready'); assert.equal(table(old.items[0].documentId).cells.find(c => c.address === 'E6002')!.value, '尾部目标');
    });
    await check('CSV/TSV preserve Chinese, leading zeroes, exact long integers and quoted multiline fields', async () => {
      const file = write('中文.csv', '编号;内容;数值\r\n001;"中文证据;含分隔符\n第二行";12345678901234567890\r\n');
      const batch = await importFiles([file]); assert.equal(batch.items[0].state, 'ready'); const source = table(batch.items[0].documentId);
      assert.equal(source.encoding, 'utf8'); assert.equal(source.delimiter, ';');
      assert.equal(source.cells.find(c => c.address === 'A2')!.value, '001'); assert.equal(source.cells.find(c => c.address === 'C2')!.value, '12345678901234567890');
      assert.equal(source.cells.find(c => c.address === 'B2')!.value, '中文证据;含分隔符\n第二行');
      const tsv = await importFiles([write('资料.tsv', '项目\t单位\n电量\tkWh\n')]); assert.equal(table(tsv.items[0].documentId).delimiter, '\t');
    });
    await check('DOCX headings, PPTX table text and both HTML articles survive source extraction', async () => {
      const word = new AdmZip(); word.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
      word.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
      word.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文来源编号 62709</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>能量 27000 kWh</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'));
      const docx = write('验证.docx', word.toBuffer());
      const ppt = new AdmZip(); ppt.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:tbl><a:tblPr/><a:tr><a:tc><a:txBody><a:p><a:r><a:t>修订日期：2026-10-10</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:spTree></p:cSld></p:sld>'));
      const pptx = write('验证.pptx', ppt.toBuffer()), html = write('多卡片.html', '<title>完整网页</title><article>第一卡片 62709</article><article>第二卡片 98731</article><script>throw new Error("must not execute")</script>');
      const batch = await importFiles([docx, pptx, html]); assert(batch.items.every(i => i.state === 'ready'), JSON.stringify(batch));
      const contents = batch.items.map(i => store.readDocument(collection, `imports/${i.documentId}.md`, '').content);
      assert(contents[0].includes('27000 kWh')); assert(contents[1].includes('2026-10-10')); assert(!contents[1].includes('a:tbl'));
      assert(contents[2].includes('62709') && contents[2].includes('98731')); assert(!contents[2].includes('must not execute'));
    });
    await check('Native PDF rendering and bundled offline OCR work without a system OCR executable', async () => {
      const { createCanvas } = require('@napi-rs/canvas'); const canvas = createCanvas(1200, 240), context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 240); context.fillStyle = 'black'; context.font = '72px sans-serif'; context.fillText('Soul 62709', 70, 145);
      const png = write('OCR验证.png', canvas.toBuffer('image/png'));
      const jpeg = canvas.toBuffer('image/jpeg');
      const makePdf = (image: boolean) => {
        const stream = image ? Buffer.from('q 600 0 0 120 0 0 cm /Im0 Do Q') : Buffer.from('BT /F1 24 Tf 50 70 Td (Soul 62709) Tj ET');
        const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'), Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 120] /Resources ${image ? '<< /XObject << /Im0 5 0 R >> >>' : '<< /Font << /F1 5 0 R >> >>'} /Contents 4 0 R >>`), Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]), image ? Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 240 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]) : Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
        const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = parts[0].length;
        objects.forEach((object, i) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); length += part.length; });
        parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`)); return Buffer.concat(parts);
      };
      const batch = await importFiles([png, write('原生文字.pdf', makePdf(false)), write('扫描验证.pdf', makePdf(true))]);
      assert(batch.items.every(i => i.state === 'ready'), JSON.stringify(batch));
      for (const item of batch.items) { assert(store.readDocument(collection, `imports/${item.documentId}.md`, '').content.includes('62709')); const manifest = store.knowledge.versions(collection, item.documentId, '')[0]; assert(manifest.assets.some(a => a.ocr === 'recognized')); assert(manifest.assets.every(a => a.bytes > 0)); }
      // A stamp-filtered recognition supplements the source; it cannot replace
      // colored evidence or make unverified OCR look like native text.
      context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 240); context.strokeStyle = 'red'; context.lineWidth = 8;
      context.beginPath(); context.arc(600, 120, 90, 0, Math.PI * 2); context.stroke();
      context.fillStyle = 'black'; context.font = '72px sans-serif'; context.fillText('Soul 2023-11-08', 70, 145);
      const stampedBytes = canvas.toBuffer('image/png'), stamped = await importFiles([write('红章辅助.png', stampedBytes)]), item = stamped.items[0];
      assert.equal(item.state, 'partial');
      const source = store.knowledge.versions(collection, item.documentId, '')[0], original = source.assets.find(a => !a.derivedFrom)!;
      assert.equal(hash(fs.readFileSync(store.knowledge.original(collection, item.documentId, item.version, ''))), hash(stampedBytes));
      assert.equal(original.sha256, hash(stampedBytes)); assert(source.assets.some(a => a.derivedFrom === original.path && a.preprocessing?.method === 'suppress-red' && a.text.includes('2023-11-08')));
      assert(source.warnings.some(w => w.includes('彩色内容')));
    });
    await check('Invalid reimports and cancellation keep the last usable version intact', async () => {
      const file = path.join(input, '验证.docx'), doc = store.documents(collection, '').find(d => d.name === '验证.docx')!;
      const before = store.readDocument(collection, doc.id, ''); fs.writeFileSync(file, 'not a zip');
      const failed = await importFiles([file]); assert.equal(failed.items[0].state, 'failed'); assert.equal(store.readDocument(collection, doc.id, '').revision, before.revision);
      const original = path.join(input, '来源.txt'), existing = store.documents(collection, '').find(d => d.name === '来源.txt')!, baseline = store.readDocument(collection, existing.id, '');
      fs.writeFileSync(original, '取消的新版不得覆盖'); const queued = await store.knowledge.start(collection, '', [original], 'files'); store.knowledge.cancel(queued.id, '');
      assert.equal((await wait(store, collection, queued.id)).state, 'cancelled'); await pause(250);
      assert.equal(store.readDocument(collection, existing.id, '').revision, baseline.revision);
      store.removeDocument(collection, existing.id, baseline.revision, ''); assert(!store.documents(collection, '').some(d => d.id === existing.id)); store.restoreTrash(''); assert.equal(store.readDocument(collection, existing.id, '').revision, baseline.revision);
    });
    await check('Directory and ZIP intake preserve relative paths, reject traversal and isolate expert bindings', async () => {
      const folder = path.join(input, '目录'); fs.mkdirSync(path.join(folder, 'A'), { recursive: true }); fs.mkdirSync(path.join(folder, 'B')); fs.writeFileSync(path.join(folder, 'A/同名.md'), 'A 证据'); fs.writeFileSync(path.join(folder, 'B/同名.md'), 'B 证据');
      const queued = await store.knowledge.start(collection, '', [folder], 'directory'), result = await wait(store, collection, queued.id); assert.equal(result.items.length, 2); assert(result.items.every(i => i.state === 'ready')); assert.notEqual(result.items[0].documentId, result.items[1].documentId);
      const zip = new AdmZip(); zip.addFile('知识/中文.md', Buffer.from('ZIP 中文证据')); const valid = write('资料.zip', zip.toBuffer());
      const zipped = await store.knowledge.start(collection, '', [valid], 'zip'); assert.equal((await wait(store, collection, zipped.id)).items[0].state, 'ready');
      const bad = new AdmZip(); bad.addFile('../escape.md', Buffer.from('invalid')); const badBytes = bad.toBuffer(); // Patch the entry name because ZIP libraries may sanitize traversal on creation.
      const goodName = Buffer.from('escape.md'), oldName = Buffer.from('../escape.md');
      assert(badBytes.includes(goodName)); if (!badBytes.includes(oldName)) { const malicious = new AdmZip(); malicious.addFile('aa/escape.md', Buffer.from('invalid')); const bytes = malicious.toBuffer(); for (let at = bytes.indexOf('aa/escape.md'); at >= 0; at = bytes.indexOf('aa/escape.md', at + 1)) bytes.write('../escape.md', at, 'utf8'); fs.writeFileSync(path.join(input, '恶意.zip'), bytes); } else fs.writeFileSync(path.join(input, '恶意.zip'), badBytes);
      await assert.rejects(store.knowledge.start(collection, '', [path.join(input, '恶意.zip')], 'zip'), /路径|名称|segment|非法|relative/i);
      library.installExpert('finance-expert'); library.installExpert('hr-expert'); assert.throws(() => store.documents(collection, 'finance-expert'), /未绑定/);
      store.bind('finance-expert', [...store.read('finance-expert').bindings, collection]); assert(store.documents(collection, 'finance-expert').length > 0); assert.throws(() => store.knowledge.list(collection, 'hr-expert'), /未绑定/); await assert.rejects(store.knowledge.start('shared', '', [path.join(input, '来源.txt')], 'files'), /只读/);
    });
    await check('A killed native process resumes its frozen original and committed versions stay unchanged', async () => {
      const docs = store.documents(collection, ''), before = docs.map(d => ({ id: d.id, revision: store.readDocument(collection, d.id, '').revision }));
      const source = write('强制退出.md', '强制退出前已冻结：62709'); store.close(); library.close();
      const batchId = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [process.argv[1], root, output, worker, '--crash-child', profile, collection, source], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); let data = '', id = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash checkpoint timed out')); }, 30_000);
        child.stdout.on('data', bytes => { data += bytes; const match = data.match(/\{"checkpoint":"([^"]+)"\}/); if (match) { id = match[1]; child.kill('SIGKILL'); } }); child.stderr.on('data', bytes => process.stderr.write(bytes));
        child.once('error', reject); child.once('exit', () => { clearTimeout(timer); if (id) resolve(id); else reject(new Error('Child exited before durable checkpoint')); });
      });
      fs.writeFileSync(source, '源文件后来已经变化'); library = new ExpertLibrary(root, profile); store = new ResourceStore(root, profile, library, worker);
      const resumed = await wait(store, collection, batchId); assert.equal(resumed.items[0].state, 'ready'); assert(store.readDocument(collection, `imports/${resumed.items[0].documentId}.md`, '').content.includes('62709'));
      for (const d of before) assert.equal(store.readDocument(collection, d.id, '').revision, d.revision);
    });
    const corpus = process.argv[5]; const real: unknown[] = [];
    if (corpus) await check('The 17 frozen real documents retain original hashes and complete structured evidence', async () => {
      const documents = JSON.parse(fs.readFileSync(corpus, 'utf8')).documents as Array<{ id: string; input: string; sha256: string }>;
      const batch = await importFiles(documents.map(d => d.input));
      for (const [index, item] of batch.items.entries()) { assert(['ready', 'partial'].includes(item.state), JSON.stringify(item)); assert.equal(item.sha256, documents[index].sha256); const manifest = store.knowledge.versions(collection, item.documentId, '')[0]; real.push({ benchmarkId: documents[index].id, ...item, locations: manifest.locations.length, tables: manifest.tables, assets: manifest.assets.map(a => ({ origin: a.origin, page: a.page, slide: a.slide, ocr: a.ocr, confidence: a.confidence })) }); }
      const d11 = batch.items[10]; const sheets = store.knowledge.versions(collection, d11.documentId, '')[0].tables; let formulas = 0;
      for (const sheet of sheets) { const file = path.join(profile, 'knowledge', collection, '_sources', d11.documentId, 'versions', d11.version, sheet.path); formulas += (JSON.parse(fs.readFileSync(file, 'utf8')) as SourceTable).cells.filter(c => c.formula).length; }
      assert.equal(formulas, 171);
      const csv = table(batch.items[14].documentId); assert(csv.cells.some(c => c.display.includes('告警'))); assert(!csv.cells.some(c => c.display.includes('å')));
    });
    const report = { ok: true, platform: process.platform, arch: process.arch, versions: process.versions, worker, workerSha256: hash(fs.readFileSync(worker)), checks, real, profile: corpus ? profile : undefined };
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: true, checks: checks.length, output }));
  } finally { store.close(); library.close(); if (!process.argv[5]) fs.rmSync(profile, { recursive: true, force: true }); }
}
}
void run().catch(cause => { console.error(cause); process.exit(1); });
