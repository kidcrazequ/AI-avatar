import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { parse } from 'yaml';
import { assertSafeSegment, resolveUnderRoot } from '../../packages/core/src/utils/path-security';
import type { CapabilityDetail, CapabilityItem, CapabilitySnapshot, CapabilityState } from '../shared/contracts';
import type { ExpertLibrary } from './expert-library';
import type { ResourceStore } from './resources';

type Document = { name: string; content: string };
type Package = { item: CapabilityItem; readme: string; documents: Document[] };
type Row = { key: string; package: string | null; state: string; revision: string };
type Owner = { expert: string; key: string; previous_key: string | null };
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const plain = (value: unknown, limit: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\r\n\x00]/.test(value)) throw new Error(`${label}须为 ${limit} 字符内的单行文本`);
  return value.trim();
};
function skill(content: unknown): Document & { description: string } {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65536) throw new Error('技能须为 64 KB 内的 Markdown');
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const metadata = block ? parse(block, { maxAliasCount: 0 }) : null;
  const name = plain(metadata?.name, 120, 'name');
  assertSafeSegment(name, '技能名称');
  if (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('技能名称无法用于 Windows');
  return { name, description: plain(metadata?.description, 2000, 'description'), content };
}
const bundles = [
  { key: 'soul-visualization', name: '图表与证据', description: '基于已有知识与用户数据生成图表、流程图和信息图，保留数据来源。', category: '数据库与分析', names: ['draw-chart', 'draw-mermaid', 'draw-infographic', 'chart-from-knowledge', 'decision-trace'] },
  { key: 'soul-design', name: '设计与交付', description: '从视觉方向、设计系统到原型与开发交接，复用 Soul 公共设计技能。', category: '设计', names: ['claude-frontend-design', 'claude-design-system', 'claude-wireframe', 'claude-interactive-prototype', 'claude-make-tweakable', 'claude-handoff-to-code'] },
  { key: 'soul-presentation', name: '演示与导出', description: '组织演示文稿并提供 PDF、HTML 和 PPTX 交付指南。', category: '工作流', names: ['claude-make-deck', 'claude-export-pptx-editable', 'claude-export-pptx-screenshots', 'claude-save-pdf', 'claude-save-standalone-html'] },
  {"key": "soul-research", "name": "联网研究与溯源", "description": "整理联网检索步骤，核对材料出处，并追溯结论的依据；外部工具需单独配置。", "category": "知识研究", "names": ["agent-reach", "decision-trace", "chart-from-knowledge", "draw-chart"]},
  {"key": "soul-requirements", "name": "需求澄清与决策", "description": "按用户请求反问需求、对照知识库澄清术语，并保留决策依据。", "category": "产品管理", "names": ["grill-me", "grill-against-knowledge", "decision-trace"]},
  {"key": "soul-prototyping", "name": "交互原型与开发交接", "description": "从结构线框到可点击原型，加入可调参数，并形成开发交接材料。", "category": "代码开发", "names": ["claude-wireframe", "claude-interactive-prototype", "claude-make-tweakable", "claude-handoff-to-code"]},
  {"key": "soul-motion", "name": "动效与内容表达", "description": "制作 HTML 时间轴动画、信息图和演示页面，说明表达结构与播放方式。", "category": "设计", "names": ["claude-animated-video", "draw-infographic", "claude-make-deck"]},
  {"key": "soul-brand", "name": "品牌视觉与 Canva 交付", "description": "确定视觉方向、复用设计系统，再通过导出文件手动交接到 Canva。", "category": "设计", "names": ["claude-frontend-design", "claude-design-system", "claude-send-to-canva"]},
  {"key": "soul-document-delivery", "name": "离线文档与归档", "description": "将已有制品整理为独立 HTML、PDF 和可编辑 PPTX，供分享与归档。", "category": "工作流", "names": ["claude-save-standalone-html", "claude-save-pdf", "claude-export-pptx-editable"]},
  {"key": "soul-aip-reference", "name": "企业 AI 平台知识", "description": "参考已有 Palantir AIP 文档快照，梳理模块用途和决策依据；不包含平台连接。", "category": "知识研究", "names": ["palantir-aip-foundry", "decision-trace", "draw-mermaid"]},
];

export class CapabilityStore {
  constructor(private db: Database.Database, private profile: string, private library: ExpertLibrary, private resources: ResourceStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS capabilities_v3 (key TEXT PRIMARY KEY, package TEXT, state TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_owners_v3 (expert TEXT NOT NULL,key TEXT NOT NULL,previous_key TEXT,PRIMARY KEY(expert,key));`);
  }
  private rows(): Row[] { return this.db.prepare('SELECT * FROM capabilities_v3 ORDER BY rowid').all() as Row[]; }
  read(scope = ''): CapabilitySnapshot {
    if (scope) this.library.resourceLocation(scope);
    const items: CapabilityItem[] = [], errors: string[] = [];
    try {
      const skills = this.resources.catalogSkills();
      for (const value of skills.filter(value => value.available)) items.push({ key: 'skill:' + value.key, kind: 'skill', name: skills.filter(skill => skill.title === value.title).length > 1 ? `${value.title} · ${value.name}` : value.title, description: value.description, category: value.category, author: 'Soul', version: '1.0.0', origin: 'bundled', skills: [{ name: value.name, key: value.key, description: value.description }], installed: false, enabled: false, expertIds: [], revision: '' });
      for (const bundle of bundles) {
        const included = bundle.names.map(name => skills.find(value => value.name === name && value.source === 'shared' && value.available));
        if (included.some(value => !value)) { errors.push(`${bundle.name}的源文件不完整`); continue; }
        items.push({ key: 'plugin:' + bundle.key, kind: 'plugin', name: bundle.name, description: bundle.description, category: bundle.category, author: 'Soul', version: '1.0.0', origin: 'bundled', skills: included.map(value => ({ name: value!.name, key: value!.key, description: value!.description })), installed: false, enabled: false, expertIds: [], revision: '' });
      }
    } catch (cause) { errors.push(`公共技能读取失败：${String(cause)}`); }
    for (const row of this.rows()) {
      let item = items.find(item => item.key === row.key);
      if (row.package) { item = (JSON.parse(row.package) as Package).item; items.push(item); }
      if (!item) { errors.push(`已安装资源源文件缺失：${row.key}`); continue; }
      Object.assign(item, JSON.parse(row.state), { revision: row.revision });
    }
    return { items: scope ? items.filter(item => item.installed && item.expertIds.includes(scope)) : items, errors };
  }
  detail(key: string): CapabilityDetail {
    const item = this.read().items.find(item => item.key === key);
    if (!item) throw new Error('资源不存在或源文件缺失');
    const row = this.rows().find(row => row.key === key);
    const uploaded = row?.package ? JSON.parse(row.package) as Package : null;
    const documents = uploaded?.documents ?? item.skills.map(value => ({ name: value.name, content: this.resources.readSkill('', value.key).content }));
    return { item, documents, readme: uploaded?.readme || `# ${item.name}\n\n${item.description}\n\n本资源包含 ${item.skills.length} 个声明式 Markdown 技能。安装后选择专家关联，任务中才能使用。技能提到的外部工具仍需单独配置连接器。` };
  }
  import(content: string, kind: 'plugin' | 'skill'): string {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new Error('导入内容须在 1 MB 内');
    if (!['plugin', 'skill'].includes(kind)) throw new Error('资源类型无效');
    let name: string, description: string, category: string, author: string, version: string, readme: string, documents: Document[];
    if (kind === 'skill') {
      const parsed = skill(content); ({ name, description } = parsed);
      category = '效率工具'; author = '本地导入'; version = '1.0.0'; readme = content; documents = [parsed];
    } else {
      const value = JSON.parse(content);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['schema', 'name', 'description', 'category', 'author', 'version', 'readme', 'skills'].includes(key)) || value.schema !== 'soul-plugin-v1') throw new Error('插件须为 soul-plugin-v1 JSON 包，仅包含元信息和 Markdown skills');
      name = plain(value.name, 80, '插件名称'); description = plain(value.description, 2000, '插件说明'); category = plain(value.category || '工作流', 40, '分类'); author = plain(value.author || '本地导入', 80, '作者'); version = plain(value.version || '1.0.0', 32, '版本');
      if (typeof value.readme !== 'string' || value.readme.length > 40000) throw new Error('插件 readme 须为 40000 字符内的 Markdown');
      readme = value.readme;
      if (!Array.isArray(value.skills) || !value.skills.length || value.skills.length > 32) throw new Error('插件需要 1–32 个 Markdown 技能');
      documents = value.skills.map(skill);
    }
    if (new Set(documents.map(document => document.name.toLowerCase())).size !== documents.length) throw new Error('插件中有重复技能名称');
    const digest = hash(content), key = 'upload:' + kind + ':' + digest;
    const item: CapabilityItem = { key, kind, name, description, category, author, version, origin: 'uploaded', skills: documents.map(document => ({ name: document.name, key: `local:skills/capabilities/${digest}/${document.name}.md`, description: skill(document.content).description })), installed: false, enabled: false, expertIds: [], revision: '' };
    this.db.prepare('INSERT OR IGNORE INTO capabilities_v3 (key,package,state,revision) VALUES (?,?,?,?)').run(key, JSON.stringify({ item, documents, readme }), JSON.stringify({ installed: false, enabled: false, expertIds: [] }), crypto.randomUUID());
    return key;
  }
  configure(key: string, revision: string, state: CapabilityState): void {
    if (!state || typeof state.installed !== 'boolean' || typeof state.enabled !== 'boolean' || !Array.isArray(state.expertIds) || state.expertIds.length > 200 || state.expertIds.some(id => typeof id !== 'string') || new Set(state.expertIds).size !== state.expertIds.length || (!state.installed && (state.enabled || state.expertIds.length))) throw new Error('安装状态与专家关联无效');
    const before = this.read().items, item = before.find(item => item.key === key);
    if (!item) throw new Error('资源不存在');
    if (item.installed === state.installed && item.enabled === state.enabled && [...item.expertIds].sort().join('\0') === [...state.expertIds].sort().join('\0')) return;
    if (revision !== item.revision) throw new Error('资源配置已变更，请重新打开');
    for (const id of state.expertIds) this.library.resourceLocation(id, true);
    const after = before.map(value => value.key === key ? { ...value, ...state } : value);
    const affected = [...new Set([...item.expertIds, ...state.expertIds])].filter(id => this.library.list().experts.some(expert => expert.id === id && expert.installed));
    const backups = new Map<string, string>(), created: string[] = [];
    for (const id of affected) {
      const file = this.resources.skillIndexFile(id);
      backups.set(file, fs.readFileSync(file, 'utf8'));
    }
    const wanted = (items: CapabilityItem[], id: string) => items.filter(value => value.installed && value.enabled && value.expertIds.includes(id)).flatMap(value => value.skills);
    try {
      this.db.transaction(() => {
        for (const id of affected) {
          const root = this.library.resourceLocation(id, true).root;
          const previous = wanted(before, id), next = wanted(after, id);
          const names = new Map<string, string>();
          for (const value of next) { const existing = names.get(value.name); if (existing && existing !== value.key) throw new Error(`多个资源包含同名技能「${value.name}」，请先解除已有资源关联`); names.set(value.name, value.key); }
          for (const value of previous.filter(value => !next.some(next => next.key === value.key))) {
            const owner = this.db.prepare('SELECT * FROM capability_owners_v3 WHERE expert=? AND key=?').get(id, value.key) as Owner | undefined;
            const current = this.resources.skillItems(id).find(skill => skill.key === value.key && skill.configured);
            if (owner && current && owner.previous_key !== value.key) {
              this.resources.configureSkill(id, value.key, false);
              if (owner.previous_key && this.resources.skillItems(id).some(skill => skill.key === owner.previous_key && skill.available)) this.resources.configureSkill(id, owner.previous_key, true);
            }
            this.db.prepare('DELETE FROM capability_owners_v3 WHERE expert=? AND key=?').run(id, value.key);
          }
          for (const value of [...new Map(next.map(value => [value.key, value])).values()]) {
            if (previous.some(previous => previous.key === value.key)) continue;
            if (value.key.startsWith('local:skills/capabilities/')) {
              const source = after.find(item => item.skills.some(skill => skill.key === value.key))!;
              const document = this.detail(source.key).documents.find(document => document.name === value.name)!;
              const file = resolveUnderRoot(root, value.key.slice(6));
              let current = root;
              for (const part of path.relative(root, file).split(path.sep)) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('技能目录不接受符号链接'); }
              if (fs.existsSync(file)) { if (fs.readFileSync(file, 'utf8') !== document.content) throw new Error(`技能「${value.name}」已有本地修改，请先处理`); }
              else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, document.content, { flag: 'wx' }); created.push(file); }
            }
            const current = this.resources.skillItems(id).find(skill => skill.name === value.name && skill.configured);
            this.db.prepare('INSERT INTO capability_owners_v3 (expert,key,previous_key) VALUES (?,?,?)').run(id, value.key, current?.key ?? null);
            this.resources.configureSkill(id, value.key, true);
          }
        }
        this.db.prepare('INSERT INTO capabilities_v3 (key,package,state,revision) VALUES (?,NULL,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,revision=excluded.revision').run(key, JSON.stringify(state), crypto.randomUUID());
      })();
    } catch (cause) {
      for (const [file, content] of backups) fs.writeFileSync(file, content);
      for (const file of created) fs.rmSync(file, { force: true });
      throw cause;
    }
  }
}
