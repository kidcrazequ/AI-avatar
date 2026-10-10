import { useEffect, useRef, useState } from 'react';
import type { ResourceDocument } from '../shared/contracts';
import { knowledgeExtensions, knowledgeLimits, type KnowledgeImportBatch, type SourceManifest } from '../shared/knowledge';
import type { LearningJob, LearningPreview } from '../shared/knowledge-learning';
import { Modal } from './primitives';

export interface KnowledgeDialog { view: 'import' | 'batches' | 'source' | 'learning'; file?: ResourceDocument }
const labels: Record<string, string> = { queued: '排队中', extracting: '提取中', running: '处理中', ready: '内容就绪', partial: '部分可用', reused: '已复用', failed: '失败', cancelled: '已取消', completed: '已完成', interrupted: '已中断', received: '已收到返回，正在校验引用', started: '模型调用中', done: '引用已验证', unknown: '调用结果未确认' };
const time = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });
export function KnowledgeDialogs({ selection, collectionId, scope, writable, close, refresh }: { selection: KnowledgeDialog; collectionId: string; scope: string; writable: boolean; close(): void; refresh(): Promise<void> }) {
  const api = window.soulDesktop.resources.knowledge;
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [kind, setKind] = useState<'files' | 'directory' | 'zip'>('files');
  const [batches, setBatches] = useState<KnowledgeImportBatch[]>([]); const [selectedBatch, setSelectedBatch] = useState('');
  const [versions, setVersions] = useState<SourceManifest[]>([]); const [version, setVersion] = useState(selection.file?.sourceVersion ?? ''); const [expected, setExpected] = useState(selection.file?.sourceVersion ?? '');
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]); const [model, setModel] = useState('Auto');
  const [start, setStart] = useState(1); const [end, setEnd] = useState(1); const [total, setTotal] = useState(0);
  const [preview, setPreview] = useState<LearningPreview>(); const [jobs, setJobs] = useState<LearningJob[]>([]);
  const file = selection.file, title = { import: '导入知识资料', batches: '导入记录', source: '来源与版本', learning: 'AI 学习整理' }[selection.view];
  const run = async (action: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { lock.current = false; setBusy(false); } };
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (selection.view === 'batches') { const value = await api.batches(collectionId, scope); if (current) { setBatches(value); setSelectedBatch(previous => previous || value[0]?.id || ''); } }
        if (selection.view === 'source' && file) {
          const [value, documents] = await Promise.all([api.versions(collectionId, file.id.slice(8, -3), scope), window.soulDesktop.resources.documents(collectionId, scope)]);
          if (current) { setVersions(value); setExpected(documents.find(item => item.id === file.id)?.sourceVersion ?? ''); }
        }
        if (selection.view === 'learning' && file) { const value = await api.learning.list(collectionId, file.id, scope); if (current) setJobs(value); }
      } catch (cause) { if (current) setError(String(cause)); }
    };
    void load(); const off = api.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => { void load(); }, 80); });
    if (selection.view === 'learning' && file) {
      window.soulDesktop.tasks.read().then(value => { if (current) setModels(value.models); }).catch(cause => { if (current) setError(String(cause)); });
      window.soulDesktop.resources.lookup.execute(scope, collectionId, { operation: 'read', id: `${collectionId}/${file.id}`, lineStart: 1 }).then(value => { if (current && 'totalLines' in value) { setTotal(value.totalLines); setEnd(Math.min(value.totalLines, 500)); } }).catch(cause => { if (current) setError(String(cause)); });
    }
    return () => { current = false; clearTimeout(timer); off(); };
  }, [selection.view, collectionId, scope, file?.id]);
  const batch = batches.find(item => item.id === selectedBatch), source = versions.find(item => item.version === version);
  return <Modal title={title} className={selection.view === 'import' ? 'project-dialog' : 'detail-dialog'} onClose={() => { if (!busy) close(); }} footer={<><button className="btn" disabled={busy} onClick={close}>关闭</button>{selection.view === 'import' && <button className="btn primary" disabled={busy || !writable} onClick={() => void run(async () => { const value = await api.chooseImport(collectionId, scope, kind); if (value) { await refresh(); close(); } })}>{busy ? '正在选择…' : '选择并导入'}</button>}{selection.view === 'source' && source && writable && source.version !== expected && <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.restore(collectionId, source.documentId, source.version, expected, scope); setExpected(source.version); await refresh(); })}>恢复此版本</button>}{selection.view === 'learning' && preview && <button className="btn primary" disabled={busy} onClick={() => void run(async () => { const job = await api.learning.start(preview.token, scope); setJobs(await api.learning.list(collectionId, file!.id, scope)); setPreview(undefined); if (job.state === 'interrupted') setError('该来源、模型和范围已有中断记录；为避免重复计费，本次不会重发。'); })}>确认用量并开始</button>}</>}>
    <div className="dialog-body knowledge-dialog" data-ued-node={`knowledge.${selection.view}`}><h2>{title}</h2>
      {selection.view === 'import' && <>
        <p className="resource-note">先归档原件并提取正文、图片与完整表格。AI 整理需要另行手动开启。</p>
        <div className="field"><label htmlFor="knowledge-import-kind">导入方式</label><select id="knowledge-import-kind" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="files">资料文件（支持多选）</option><option value="directory">资料文件夹（包含子目录）</option><option value="zip">ZIP 资料包</option></select></div>
        <p>支持 {knowledgeExtensions.join(' / ')}</p><p className="resource-note">单文件上限 {knowledgeLimits.fileBytes / 1024 / 1024} MB，每批最多 {knowledgeLimits.members} 份。目录或 ZIP 中不支持的格式会在导入记录列出；扫描件可能仅部分可用。</p>
      </>}
      {selection.view === 'batches' && <>
        <div className="field"><label htmlFor="knowledge-batch">导入批次</label><select id="knowledge-batch" value={selectedBatch} onChange={event => setSelectedBatch(event.target.value)}>{batches.map(item => <option key={item.id} value={item.id}>{time(item.at)} · {labels[item.state]} · {item.items.length} 份</option>)}</select></div>
        {!batch && <p className="resource-note">暂无导入记录。关闭本窗口后可选择资料文件。</p>}
        {batch && <><p>{labels[batch.state]} · {batch.items.filter(item => ['ready', 'partial', 'reused'].includes(item.state)).length} / {batch.items.length} 份可用</p><div className="flex">{writable && ['queued', 'running'].includes(batch.state) && <button className="btn" disabled={busy} onClick={() => void run(() => api.cancel(batch.id, scope))}>取消未完成资料</button>}{writable && !['queued', 'running'].includes(batch.state) && batch.items.some(item => ['partial', 'failed', 'cancelled'].includes(item.state)) && <button className="btn" disabled={busy} onClick={() => void run(() => api.retry(batch.id, scope))}>重试基础提取</button>}</div><table className="resource-table"><thead><tr><th>资料</th><th>状态与诊断</th></tr></thead><tbody>{batch.items.map(item => <tr key={item.id}><td>{item.relativePath}<span className="tiny">{item.bytes.toLocaleString()} 字节</span></td><td>{labels[item.state]}{item.error && <p className="resource-note">{item.error}</p>}{item.warnings.map((warning, i) => <p className="resource-note" key={i}>{warning}</p>)}</td></tr>)}{batch.skipped.map((item, i) => <tr key={'skipped' + i}><td>{item.path}</td><td>未导入：{item.reason}</td></tr>)}</tbody></table><p className="resource-note">基础提取重试不会启动 AI 调用。内容就绪后可查找，查找索引按需建立；“部分可用”仍需核对诊断。</p></>}
      </>}
      {selection.view === 'source' && <>
        <div className="field"><label htmlFor="knowledge-version">来源版本</label><select id="knowledge-version" value={version} onChange={event => setVersion(event.target.value)}>{versions.map(item => <option key={item.version} value={item.version}>{time(item.created)} · {item.version}{item.version === expected ? '（当前）' : ''}</option>)}</select></div>
        {source ? <><h3>{source.originalName}</h3><p>{labels[source.status]} · 原件 {source.originalBytes.toLocaleString()} 字节 · 提取正文 {source.bodyBytes.toLocaleString()} 字节</p><button className="btn" disabled={busy} onClick={() => void run(() => api.openOriginal(collectionId, source.documentId, source.version, scope))}>打开原件</button><dl className="knowledge-hashes"><dt>原件 SHA-256</dt><dd>{source.originalSha256}</dd><dt>正文 SHA-256</dt><dd>{source.bodySha256}</dd><dt>提取版本</dt><dd>{source.signature}</dd></dl>{source.warnings.map((warning, i) => <p className="resource-note" key={i}>{warning}</p>)}<h3>提取诊断</h3><p>{source.locations.length} 处来源定位 · {source.tables.length} 张完整表格 · {source.assets.length} 个图片产物</p><table className="resource-table"><thead><tr><th>原文位置</th><th>提取方式</th></tr></thead><tbody>{source.locations.map((location, i) => <tr key={i}><td>行 {location.lineStart}–{location.lineEnd}{location.page && ` · 第 ${location.page} 页`}{location.sheet && ` · ${location.sheet}`}</td><td>{location.method === 'ocr' ? 'OCR（需核对原件）' : '原生内容'}</td></tr>)}</tbody></table>{source.tables.map(table => <p key={table.path}>{table.sheet} · {table.rows} 行 × {table.columns} 列 · {table.cells} 个物理单元格</p>)}{source.assets.map(asset => <p className="resource-note" key={asset.path}>{asset.origin} · OCR {asset.ocr}{asset.confidence !== undefined ? ` · 识别分数 ${asset.confidence.toFixed(1)}` : ''}{asset.error && ` · ${asset.error}`}</p>)}<p className="resource-note">恢复只切换当前资料版本；已开始的专家任务继续使用原来源快照。</p></> : <p className="resource-note">正在读取来源清单…</p>}
      </>}
      {selection.view === 'learning' && <>
        <p className="resource-note">生成带原文引用的参阅草案，单独保存。原件与确定性提取正文保持独立，笔记尚未进入专家检索。</p><p>{file?.name} · 共 {total} 行</p>
        <div className="field"><label htmlFor="learning-model">模型</label><select id="learning-model" value={model} onChange={event => { setModel(event.target.value); setPreview(undefined); }}><option value="Auto">Auto</option>{models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
        <div className="knowledge-range"><div className="field"><label htmlFor="learning-start">起始行</label><input id="learning-start" type="number" min={1} max={total} value={start} onChange={event => { setStart(Number(event.target.value)); setPreview(undefined); }} /></div><div className="field"><label htmlFor="learning-end">结束行</label><input id="learning-end" type="number" min={start} max={total} value={end} onChange={event => { setEnd(Number(event.target.value)); setPreview(undefined); }} /></div></div>
        <button className="btn" disabled={busy || !total || !models.length} onClick={() => void run(async () => setPreview(await api.learning.preview({ collectionId, documentId: file!.id, scope, model, lineStart: start, lineEnd: end })))}>预览来源与用量</button>{!models.length && <p className="resource-note">请先在系统设置中配置模型，原文仍可查找。</p>}
        {preview && <div className="knowledge-learning-preview"><p>{preview.model} · {preview.promptVersion} · 版本 {preview.version} · 行 {preview.lineStart}–{preview.lineEnd}</p><p>{preview.chunks} 次调用 · 输入约 {preview.inputTokenUpperEstimate.toLocaleString()} tokens（保守估算） · 输出上限 {preview.outputTokenLimit.toLocaleString()} tokens</p><p className="resource-note">{preview.cost}</p></div>}
        <h3>独立整理记录</h3>{!jobs.length && <p className="resource-note">暂无记录。预览用量不会调用模型。</p>}{jobs.map(job => <section className="knowledge-learning-record" key={job.id}><strong>{labels[job.state]} · {time(job.created)}</strong><p className="preview-meta">{job.model} · {job.promptVersion ?? '旧整理规则'} · 版本 {job.version} · 行 {job.lineStart}–{job.lineEnd}</p>{job.state === 'running' && <button className="btn" disabled={busy} onClick={() => void run(() => api.learning.cancel(job.id, scope))}>停止整理</button>}{job.parts.map((part, i) => <div key={i}><p>{labels[part.state]} · 行 {part.lineStart}–{part.lineEnd}{part.usage && ` · 输入 ${part.usage.inputTokens} / 输出 ${part.usage.outputTokens} tokens`}</p>{part.error && <p className="resource-note">{part.error}</p>}{part.rawResponse && <details><summary>查看模型原始返回</summary><pre className="resource-preview">{part.rawResponse}</pre></details>}{part.notes.map((note, n) => <article key={n}><p>{note.text}</p><blockquote>{note.quote}</blockquote><p className="preview-meta">来源：{job.sourceName} · {job.version} · 行 {note.lineStart}–{note.lineEnd}</p></article>)}{part.gaps.map((gap, n) => <p className="resource-note" key={n}>资料缺口：{gap}</p>)}</div>)}</section>)}
      </>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div>
  </Modal>;
}
