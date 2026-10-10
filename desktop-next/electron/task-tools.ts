import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveUnderRoot, assertSafeSegment } from '../../packages/core/src/utils/path-security';
import type { TaskApproval, TaskFile, TaskMember, TaskRecord, WireCall } from '../shared/contracts';
import { digest, now, required } from './task-repository';
import type { KnowledgeLookup } from './knowledge/lookup-store';
import type { LookupRequest } from '../shared/knowledge-lookup';

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const string = { type: 'string' };
export const taskTools = [
  tool('search_knowledge', '检索当前专家绑定知识的任务快照，返回候选原文、来源与覆盖信号；引号短语和编号须匹配。专业事实必须再阅读核对。', { query: string, caseSensitive: { type: 'boolean' }, limit: { type: 'integer' } }, ['query']),
  tool('read_knowledge', '按行、页或章节读取冻结的来源版本。使用 nextLine 继续阅读长文；文件 ID 来自检索。', { id: string, lineStart: { type: 'integer' }, lineEnd: { type: 'integer' }, page: { type: 'integer' }, section: string }, ['id']),
  tool('describe_table', '查看冻结来源的全部工作表、物理行列、表头块、合并区域及公式数量。', { id: string }, ['id']),
  tool('query_table', '查询完整表格，保留物理行号、单元格、类型、公式原式和缓存值。默认表头是物理第1行，其他表块显式指定 headerRow 与行范围。列为 describe_table 返回的唯一 key 或 @A/@B/@C 物理列。聚合由代码执行，缓存值不重新计算。', { id: string, sheet: string, headerRow: { type: 'integer' }, rowStart: { type: 'integer' }, rowEnd: { type: 'integer' }, columns: { type: 'array', items: string }, filters: { type: 'array', items: { type: 'object', properties: { column: string, operator: { type: 'string', enum: ['eq', 'contains', 'gt', 'gte', 'lt', 'lte'] }, value: { type: ['string', 'number', 'boolean'] } }, required: ['column', 'operator', 'value'], additionalProperties: false } }, offset: { type: 'integer' }, limit: { type: 'integer' }, aggregate: { type: 'object', properties: { column: string, operation: { type: 'string', enum: ['sum', 'average', 'min', 'max', 'count'] } }, required: ['column', 'operation'], additionalProperties: false } }, ['id', 'sheet']),
  tool('read_skill', '读取当前专家启用的技能原文。', { id: string }, ['id']),
  tool('read_project_file', '读取选定工作目录下的 Markdown、文本、CSV、JSON 文件，路径必须相对。', { file: string }, ['file']),
  tool('write_artifact', '申请把成果写入工作目录的 Soul-Outputs/任务ID/ 下。必须等待用户审批，只能新建文件。', { file: string, content: string }, ['file', 'content']),
  tool('list_connector_tools', '列出当前专家已连接的外部工具，返回连接器 ID、名称与能力。', {}, []),
  tool('call_connector_tool', '申请调用当前专家连接器的工具，必须等待用户审批。参数结构参考工具目录。', { connectorId: string, name: string, arguments: { type: 'object' } }, ['connectorId', 'name', 'arguments']),
];
export function safeTaskPath(root: string, relative: string): string {
  if (!path.isAbsolute(root) || !fs.existsSync(root) || !fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('工作目录不存在或是符号链接');
  required(relative, '文件路径', 300);
  for (const segment of relative.replaceAll('\\', '/').split('/')) {
    assertSafeSegment(segment, '文件路径');
    if (segment.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw new Error('文件路径无效');
  }
  const absolute = resolveUnderRoot(root, relative);
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('文件路径不接受符号链接');
  }
  return absolute;
}
export function parseTool(call: WireCall): Record<string, unknown> {
  const input = JSON.parse(required(call.function.arguments, '工具参数', 160000));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工具参数须为对象');
  return input;
}
export function requestArtifact(task: TaskRecord, call: WireCall): TaskApproval {
  const input = parseTool(call), member = task.members[task.checkpoint.member];
  const file = required(input.file, '成果文件名', 300);
  if (!/\.(md|txt|csv|json)$/i.test(file)) throw new Error('成果支持 md、txt、csv、json');
  const destination = safeTaskPath(member.directory, `Soul-Outputs/${task.id}/${file}`);
  const content = required(input.content, '成果内容', 100000);
  return { id: crypto.randomUUID(), taskId: task.id, expertId: member.expertId, state: 'pending', requested: now(), destination, content, hash: digest(content), callId: call.id, roundId: task.rounds.at(-1)!.id, note: '' };
}
export function commitArtifact(task: TaskRecord, approval: TaskApproval): string {
  if (approval.state !== 'approved' || digest(approval.content) !== approval.hash) throw new Error('成果尚未批准或内容已变化');
  const member = task.members[task.checkpoint.member];
  const destination = safeTaskPath(member.directory, path.relative(member.directory, approval.destination));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile() || digest(fs.readFileSync(destination, 'utf8')) !== approval.hash) throw new Error('成果路径已存在不同内容，请先人工处理冲突');
  } else {
    const fd = fs.openSync(destination, 'wx');
    try { fs.writeFileSync(fd, approval.content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (!task.artifacts.some(item => item.path === destination)) task.artifacts.push({ path: destination, hash: approval.hash });
  return `已写入：${destination}\nSHA256：${approval.hash}`;
}
export async function runReadonlyTool(member: TaskMember, call: WireCall, lookup: KnowledgeLookup): Promise<string> {
  const input = parseTool(call);
  if (['search_knowledge', 'read_knowledge', 'describe_table', 'query_table'].includes(call.function.name)) {
    const operation = ({ search_knowledge: 'search', read_knowledge: 'read', describe_table: 'describe', query_table: 'table' } as const)[call.function.name as 'search_knowledge'];
    return JSON.stringify(await lookup.execute(lookup.taskSources(member.knowledge), { ...input, operation } as LookupRequest));
  }
  if (call.function.name === 'read_skill') {
    const files = member.skills;
    const file = files.find(item => item.id === required(input.id, '资源 ID', 2000));
    if (!file) return JSON.stringify({ error: '当前专家快照中未找到该文件', available: files.map(({ id, source }) => ({ id, source })) });
    return JSON.stringify({ id: file.id, source: file.source, hash: file.hash, content: file.content.slice(0, 24000), truncated: file.content.length > 24000 });
  }
  if (call.function.name === 'read_project_file') {
    const file = safeTaskPath(member.directory, required(input.file, '项目文件', 300));
    if (!/\.(md|txt|csv|json)$/i.test(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 200000) throw new Error('项目文件须为 200 KB 内的文本');
    const content = fs.readFileSync(file, 'utf8');
    return JSON.stringify({ source: file, hash: digest(content), content });
  }
  throw new Error('未开放的工具');
}
export function taskFile(id: string, name: string, source: string, content: string): TaskFile { return { id, name, source, content, hash: digest(content) }; }
