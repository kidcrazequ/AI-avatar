import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { isSeq, parse, parseDocument } from 'yaml';
import { assertSafeSegment, resolveUnderRoot } from '../../packages/core/src/utils/path-security';
import { ExpertLibrary } from './expert-library';
import type { DocumentInput, KnowledgeCollection, QualityReport, ResourceDocument, ResourceFile, ResourceProject, ResourceSnapshot, ResourceVersion, SkillItem } from '../shared/contracts';

const hash = (text: string | Buffer) => crypto.createHash('sha256').update(text).digest('hex');
const text = (value: unknown, label: string, limit: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new Error(`${label}格式无效或超过 ${limit} 字符`);
  return value;
};
const name = (value: unknown): string => {
  const clean = text(value, '文件名称', 120).trim();
  assertSafeSegment(clean, '文件名称');
  if (/[<>:"|?*\x00-\x1f]/.test(clean) || /[. ]$/.test(clean) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) throw new Error('文件名称无法用于 Windows');
  return clean;
};
function safe(root: string, relative: string): string {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('资源根目录不接受符号链接');
  const result = resolveUnderRoot(root, text(relative, '资源路径', 2000));
  let current = root;
  for (const part of path.relative(root, result).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('资源不接受符号链接');
  }
  return result;
}
function read(file: string, source: string): ResourceFile {
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('文本超过 2 MB');
  const content = fs.readFileSync(file, 'utf8');
  return { path: source, source, content, revision: hash(content) };
}
function files(root: string, prefix = '', depth = 0, inspect = false): ResourceDocument[] {
  if (!fs.existsSync(root) || depth > 20) return [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('资源根目录不接受符号链接');
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.isSymbolicLink()) return [];
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return files(path.join(root, entry.name), relative + '/', depth + 1, inspect);
    if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) return [];
    const absolute = path.join(root, entry.name);
    const bytes = fs.statSync(absolute).size;
    const body = inspect && bytes <= 2 * 1024 * 1024 ? fs.readFileSync(absolute, 'utf8').slice(0, 8192) : '';
    return [{ id: relative, name: entry.name, path: relative, bytes, placeholder: /示例占位|待补充|暂无专业资料/.test(body) }];
  });
}
export const memoryGroups = ['专家画像', '用户偏好', '工作规则', '长期反馈'];
interface CollectionRow { id: string; title: string; archived: number }
interface Trash { id: number; collection_id: string; file: string; content: string; scope: string }

export class ResourceStore {
  private db: Database.Database;
  private collectionsRoot: string;
  constructor(private resourcesRoot: string, private profileRoot: string, private library: ExpertLibrary) {
    this.collectionsRoot = path.join(profileRoot, 'knowledge');
    fs.mkdirSync(this.collectionsRoot, { recursive: true });
    this.db = new Database(path.join(profileRoot, 'soul.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS resource_projects (id TEXT PRIMARY KEY,value TEXT NOT NULL,scope TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS resource_collections (id TEXT PRIMARY KEY,title TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS resource_versions (id INTEGER PRIMARY KEY AUTOINCREMENT,expert_id TEXT NOT NULL,file TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL,content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_trash (id INTEGER PRIMARY KEY AUTOINCREMENT,collection_id TEXT NOT NULL,file TEXT NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  private scope(id: string): void { if (id) this.library.resourceLocation(id); }
  private collection(id: string, scope: string, write = false): { root: string; source: string; builtin: boolean } {
    this.scope(scope);
    const collection = this.collections().find(item => item.id === id);
    if (!collection) throw new Error('知识库不存在或已移除');
    if (scope && !this.bindings(scope).includes(id)) throw new Error('当前专家未绑定此知识库');
    if (id.startsWith('expert:')) {
      const owner = id.slice(7);
      if (write && scope !== owner) throw new Error('请从所属专家的知识库编辑原文件');
      const location = this.library.resourceLocation(owner, write);
      return { root: path.join(location.root, 'knowledge'), source: `${location.expert.sourceLabel}/knowledge`, builtin: true };
    }
    if (id === 'shared') {
      if (write) throw new Error('随应用提供的公共知识只读，请新建知识库后补充');
      return { root: path.join(this.resourcesRoot, 'shared/knowledge'), source: 'shared/knowledge', builtin: true };
    }
    return { root: safe(this.collectionsRoot, name(id)), source: `knowledge/${id}`, builtin: false };
  }
  private collections(): KnowledgeCollection[] {
    const builtins = this.library.list().experts.map(expert => {
      const root = path.join(this.library.resourceLocation(expert.id).root, 'knowledge');
      return { id: 'expert:' + expert.id, title: expert.name + ' · 专业知识', source: expert.sourceLabel + '/knowledge', documents: files(root).length, builtin: true, writable: expert.installed };
    });
    const shared = { id: 'shared', title: 'Soul 共享知识', source: 'shared/knowledge', documents: files(path.join(this.resourcesRoot, 'shared/knowledge')).length, builtin: true, writable: false };
    const custom = (this.db.prepare('SELECT * FROM resource_collections WHERE archived=0 ORDER BY rowid').all() as CollectionRow[]).map(row => ({ id: row.id, title: row.title, source: `knowledge/${row.id}`, documents: files(safe(this.collectionsRoot, row.id)).length, builtin: false, writable: true }));
    return [...builtins, shared, ...custom];
  }
  private bindings(id: string): string[] {
    const { root, expert } = this.library.resourceLocation(id);
    const config = expert.installed ? JSON.parse(fs.readFileSync(safe(root, 'avatar.config.json'), 'utf8')) : {};
    const available = new Set(this.collections().map(item => item.id));
    return (Array.isArray(config.knowledgeCollections) ? config.knowledgeCollections : ['expert:' + id, 'shared']).filter((value: unknown) => typeof value === 'string' && available.has(value));
  }
  read(scope: string): ResourceSnapshot {
    this.scope(scope);
    const projects = (this.db.prepare('SELECT value FROM resource_projects WHERE archived=0 AND (scope=\'\' OR scope=?) ORDER BY rowid').all(scope) as Array<{ value: string }>).map(row => JSON.parse(row.value) as ResourceProject);
    if (!scope) return { projects, collections: this.collections(), bindings: [], skills: [], memory: null, settings: null, versions: [], quality: null };
    const { root, expert } = this.library.resourceLocation(scope);
    return { projects, collections: this.collections(), bindings: this.bindings(scope), skills: this.skills(scope), memory: read(safe(root, 'memory/MEMORY.md'), expert.sourceLabel + '/memory/MEMORY.md'), settings: read(safe(root, 'soul.md'), expert.sourceLabel + '/soul.md'), versions: this.versions(scope), quality: this.checkQuality(scope) };
  }
  saveProject(input: ResourceProject, scope: string): void {
    this.scope(scope);
    const projectName = text(input.name, '项目名称', 80).trim();
    const description = text(input.description, '简介', 500, true).trim();
    if (input.expertId !== '' && input.expertId !== scope) throw new Error('不能修改其他专家的私密项目');
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 8) throw new Error('项目需要 1–8 个来源');
    const seen = new Set<string>();
    const sources = input.sources.map(source => {
      let value = text(source.path, '来源路径', 1000).trim();
      if (source.type === 'local') {
        if (!path.isAbsolute(value) || !fs.statSync(value).isDirectory()) throw new Error('本地来源须为存在的绝对目录');
        value = fs.realpathSync(value);
      } else if (source.type === 'git') {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.pathname === '/' || url.search || url.hash) throw new Error('Git 来源须为不含凭据的 HTTPS 仓库地址');
        value = url.href;
      } else throw new Error('来源类型无效');
      const key = process.platform === 'win32' && source.type === 'local' ? value.toLowerCase() : value;
      if (seen.has(key)) throw new Error('来源路径重复');
      seen.add(key);
      return { type: source.type, path: value };
    });
    const existing = input.id ? this.db.prepare('SELECT value,scope FROM resource_projects WHERE id=? AND archived=0').get(input.id) as { value: string; scope: string } | undefined : undefined;
    if (input.id && (!existing || (existing.scope && existing.scope !== scope) || existing.scope !== input.expertId)) throw new Error('项目不存在或范围不匹配');
    if (existing && JSON.parse(existing.value).updated !== input.updated) throw new Error('项目已变更，请重新打开');
    const duplicate = (this.db.prepare('SELECT id,value FROM resource_projects WHERE scope=? AND archived=0').all(input.expertId) as Array<{ id: string; value: string }>).some(row => row.id !== input.id && JSON.parse(row.value).name.toLocaleLowerCase() === projectName.toLocaleLowerCase());
    if (duplicate) throw new Error('该范围下已有同名项目');
    const project = { id: input.id || crypto.randomUUID(), name: projectName, description, expertId: input.expertId, sources, updated: new Date().toISOString() };
    this.db.prepare('INSERT INTO resource_projects (id,value,scope) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(project.id, JSON.stringify(project), project.expertId);
  }
  removeProject(id: string, scope: string): void {
    if (!this.read(scope).projects.some(project => project.id === id)) throw new Error('项目不存在');
    this.db.prepare('UPDATE resource_projects SET archived=1 WHERE id=?').run(id);
  }
  saveCollection(id: string, title: string): void {
    const value = text(title, '知识库标题', 80).trim();
    if (this.collections().some(item => item.id !== id && item.title.toLocaleLowerCase() === value.toLocaleLowerCase())) throw new Error('知识库标题重复');
    if (id && !this.db.prepare('SELECT id FROM resource_collections WHERE id=? AND archived=0').get(id)) throw new Error('只能编辑自建知识库');
    const collectionId = id || crypto.randomUUID();
    fs.mkdirSync(safe(this.collectionsRoot, collectionId), { recursive: true });
    this.db.prepare('INSERT INTO resource_collections (id,title) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(collectionId, value);
  }
  removeCollection(id: string): void {
    if (!this.collections().some(item => item.id === id && !item.builtin)) throw new Error('专家包知识库不能移除');
    this.db.prepare('UPDATE resource_collections SET archived=1 WHERE id=?').run(id);
  }
  bind(id: string, ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(item => !this.collections().some(collection => collection.id === item))) throw new Error('知识库绑定无效');
    const { root } = this.library.resourceLocation(id, true);
    const current = read(safe(root, 'avatar.config.json'), 'avatar.config.json');
    const config = JSON.parse(current.content);
    this.write(id, root, 'avatar.config.json', JSON.stringify({ ...config, knowledgeCollections: ids }, null, 2), current.revision, '绑定知识库');
  }
  documents(id: string, scope: string): ResourceDocument[] {
    return files(this.collection(id, scope).root, '', 0, true);
  }
  readDocument(id: string, file: string, scope: string): ResourceFile {
    const collection = this.collection(id, scope);
    if (!this.documents(id, scope).some(item => item.id === file)) throw new Error('资料不存在');
    return read(safe(collection.root, file), collection.source + '/' + file);
  }
  saveDocument(input: DocumentInput, scope: string): void {
    const collection = this.collection(input.collectionId, scope, true);
    const title = name(input.name);
    const content = text(input.content, '正文', 2 * 1024 * 1024);
    const file = input.id || (/\.md$/i.test(title) ? title : title.replace(/\.txt$/i, '') + '.md');
    if (input.id && !this.documents(input.collectionId, scope).some(item => item.id === input.id)) throw new Error('资料已被移除');
    if (!input.id && fs.existsSync(safe(collection.root, file))) throw new Error('资料名称重复');
    this.write(scope || 'global', collection.root, file, content, input.revision, '编辑知识资料');
  }
  removeDocument(id: string, file: string, revision: string, scope: string): void {
    const collection = this.collection(id, scope, true);
    const current = this.readDocument(id, file, scope);
    if (current.revision !== revision) throw new Error('资料已变更，请重新打开');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO resource_trash (collection_id,file,content,scope) VALUES (?,?,?,?)').run(id, file, current.content, scope);
      fs.renameSync(safe(collection.root, file), path.join(this.profileRoot, `.removed-${crypto.randomUUID()}.md`));
    })();
  }
  restoreTrash(scope: string): void {
    this.scope(scope);
    // Restore collections before documents; an existing file is never overwritten.
    this.db.prepare('UPDATE resource_collections SET archived=0').run();
    this.db.prepare('UPDATE resource_projects SET archived=0 WHERE scope=\'\' OR scope=?').run(scope);
    for (const entry of this.db.prepare('SELECT * FROM resource_trash WHERE scope=? ORDER BY id DESC').all(scope) as Trash[]) {
      const collection = this.collection(entry.collection_id, scope, true);
      const target = safe(collection.root, entry.file);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content, { flag: 'wx' });
      this.db.prepare('DELETE FROM resource_trash WHERE id=?').run(entry.id);
    }
  }
  private versions(id: string): ResourceVersion[] {
    return this.db.prepare('SELECT id,at,reason,file,content FROM resource_versions WHERE expert_id=? AND file=\'memory/MEMORY.md\' ORDER BY id DESC').all(id) as ResourceVersion[];
  }
  private write(id: string, root: string, file: string, content: string, revision: string, reason: string): void {
    const target = safe(root, file);
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if ((previous === null ? '' : hash(previous)) !== revision) throw new Error('文件已变更，请重新打开后保存');
    if (previous === content) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), `.save-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(temp, content, { flag: 'wx' });
      this.db.transaction(() => {
        const statement = this.db.prepare('INSERT INTO resource_versions (expert_id,file,at,reason,content) VALUES (?,?,?,?,?)');
        if (previous !== null && !this.db.prepare('SELECT id FROM resource_versions WHERE expert_id=? AND file=? LIMIT 1').get(id, file)) statement.run(id, file, new Date().toISOString(), '原始文件', previous);
        statement.run(id, file, new Date().toISOString(), reason, content);
        fs.renameSync(temp, target);
      })();
    } catch (error) {
      if (previous !== null) fs.writeFileSync(target, previous); else if (fs.existsSync(target)) fs.rmSync(target);
      throw error;
    } finally { fs.rmSync(temp, { force: true }); }
  }
  saveMemory(id: string, value: string, revision: string, group: string): void {
    const { root } = this.library.resourceLocation(id, true);
    const file = 'memory/MEMORY.md';
    const previous = read(safe(root, file), file).content;
    let content = text(value, '记忆内容', 40000, true);
    if (group) {
      if (!memoryGroups.includes(group)) throw new Error('未知记忆分组');
      const blocks = previous.split(/(?=^##\s+)/m);
      const indices = blocks.flatMap((block, index) => block.split(/\r?\n/)[0].trim() === '## ' + group ? [index] : []);
      if (indices.length > 1) throw new Error('记忆中有重复分组，请先编辑完整文件');
      const replacement = `## ${group}\n\n${content}\n\n`;
      if (indices.length) blocks[indices[0]] = replacement;
      else blocks.push((previous.endsWith('\n') ? '\n' : '\n\n') + replacement);
      content = blocks.join('');
    } else {
      for (const heading of memoryGroups) {
        const count = (body: string) => body.split(/\r?\n/).filter(line => line.trim() === '## ' + heading).length;
        if (count(content) > 1 || (count(previous) === 1 && count(content) !== 1)) throw new Error(`请保留且只保留一个「## ${heading}」标题`);
      }
    }
    this.write(id, root, file, content, revision, group ? '编辑' + group : '编辑完整文件');
  }
  restoreVersion(id: string, version: number, revision: string): void {
    const { root } = this.library.resourceLocation(id, true);
    const record = this.versions(id).find(item => item.id === version);
    if (!record) throw new Error('版本不存在');
    this.write(id, root, 'memory/MEMORY.md', record.content, revision, `恢复版本 ${version}`);
  }
  private skills(id: string): SkillItem[] {
    const { root } = this.library.resourceLocation(id);
    const configured = this.library.detail(id).skills;
    const refs = [...configured, ...files(path.join(root, 'skills')).map(file => ({ id: file.name.replace(/\.md$/, ''), name: file.name.replace(/\.md$/, ''), source: 'local' as const, path: 'skills/' + file.id, domain: '', available: true })), ...files(path.join(this.resourcesRoot, 'shared/skills')).map(file => ({ id: file.name.replace(/\.md$/, ''), name: file.name.replace(/\.md$/, ''), source: file.id.startsWith('community/') ? 'community' as const : 'shared' as const, path: 'shared/skills/' + file.id, domain: '', available: true }))];
    const result = new Map<string, SkillItem>();
    for (const ref of refs) {
      const origin = ref.source === 'local' ? root : this.resourcesRoot;
      const absolute = safe(origin, ref.path);
      const body = ref.available && fs.existsSync(absolute) ? read(absolute, ref.path).content : '';
      const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const metadata = frontmatter ? parse(frontmatter, { maxAliasCount: 0 }) : {};
      if (!frontmatter && !configured.some(item => item.path === ref.path && item.source === ref.source)) continue;
      const skillName = typeof metadata?.name === 'string' ? metadata.name : ref.name;
      const description = typeof metadata?.description === 'string' ? metadata.description : ref.domain || '声明的技能文件';
      const domain = configured.find(item => item.name === skillName)?.domain ?? ref.domain;
      const category = /图|数据|财务/.test(domain) ? '数据与 AI' : /设计|视觉/.test(domain) ? '设计与 UI' : /检索|研究|回溯/.test(domain) ? '研究与分析' : /文档|演示|写作/.test(domain) ? '文档与写作' : '效率工具';
      const key = ref.source + ':' + ref.path;
      result.set(key, { ...ref, id: skillName, name: skillName, key, title: domain || skillName, description, category, configured: configured.some(item => item.name === skillName && item.source === ref.source && item.path === ref.path) });
    }
    return [...result.values()];
  }
  readSkill(id: string, key: string): ResourceFile {
    const skill = this.skills(id).find(item => item.key === key);
    if (!skill || !skill.available) throw new Error('技能文件不存在');
    const root = skill.source === 'local' ? this.library.resourceLocation(id).root : this.resourcesRoot;
    return read(safe(root, skill.path), skill.path);
  }
  configureSkill(id: string, key: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('技能状态无效');
    const skill = this.skills(id).find(item => item.key === key);
    if (!skill || (enabled && !skill.available)) throw new Error('技能不可用');
    const { root } = this.library.resourceLocation(id, true);
    const file = 'skills/skill-index.yaml';
    const previous = read(safe(root, file), file);
    const doc = parseDocument(previous.content);
    if (doc.errors.length) throw new Error('技能索引 YAML 无效');
    const data = doc.toJS({ maxAliasCount: 50 });
    for (const [field, entries] of Object.entries(data)) if (Array.isArray(entries)) {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.name === skill.name) doc.deleteIn([field, i]);
    }
    if (enabled) {
      const section = skill.source === 'local' ? 'local_skills' : skill.source === 'shared' ? 'shared_skills' : 'community_skills';
      if (doc.get(section) == null) doc.set(section, doc.createNode([]));
      if (!isSeq(doc.get(section))) throw new Error('技能索引的分组须为列表');
      doc.addIn([section], { name: skill.name, path: skill.path, source: skill.source, domain: skill.title });
    }
    this.write(id, root, file, doc.toString(), previous.revision, enabled ? '配置技能' : '移除技能配置');
  }
  uploadSkill(id: string, value: string): void {
    const { root } = this.library.resourceLocation(id, true);
    const content = text(value, '技能 Markdown', 65536);
    if (Buffer.byteLength(content) > 65536) throw new Error('技能文件超过 64 KB');
    const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const data = block ? parse(block, { maxAliasCount: 0 }) : null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('技能需要 name 与 description frontmatter');
    const skillName = name(data.name);
    const description = text(data.description, 'description', 2000);
    if (/[\r\n]/.test(skillName + description)) throw new Error('name 与 description 须为单行');
    const relative = `skills/${skillName}.md`;
    if (fs.existsSync(safe(root, relative))) throw new Error('已有同名专属技能，请先核对原文件');
    fs.writeFileSync(safe(root, relative), content, { flag: 'wx' });
    try { this.configureSkill(id, 'local:' + relative, true); }
    catch (error) { fs.rmSync(safe(root, relative), { force: true }); throw error; }
  }
  saveSoul(id: string, value: string, revision: string): void {
    const { root } = this.library.resourceLocation(id, true);
    const content = text(value, '人格文件', 60000);
    if (!/^#\s+/m.test(content) || !/^##\s+/m.test(content)) throw new Error('请保留人格文件的标题和章节');
    this.write(id, root, 'soul.md', content, revision, '保存人格设定');
  }
  checkQuality(id: string): QualityReport {
    const { root, expert } = this.library.resourceLocation(id);
    const detail = this.library.detail(id);
    const documents = files(path.join(root, 'knowledge'), '', 0, true);
    const cases = files(path.join(root, 'tests/cases'));
    const checks = ['soul.md', 'AGENTS.md', 'knowledge/README.md', 'skills/skill-index.yaml', 'memory/MEMORY.md'].map(file => ({ name: file, ok: fs.existsSync(safe(root, file)) && (file.startsWith('memory/') || Boolean(read(safe(root, file), file).content.trim())), source: expert.sourceLabel + '/' + file }));
    return { at: new Date().toISOString(), professional: '未执行', knowledge: documents.length, cases, checks: [...checks,
      { name: '专业知识资料', ok: documents.some(file => file.name !== 'README.md' && !file.placeholder), source: `${documents.length} 份文件；示例占位 ${documents.filter(file => file.placeholder).length} 份` },
      { name: '至少 5 个专业测试用例', ok: cases.length >= 5, source: `${cases.length} 份用例（未执行）` },
      { name: '技能引用文件', ok: detail.skills.every(skill => skill.available), source: `${detail.skills.length} 项 skill-index.yaml 配置` }] };
  }
  readCase(id: string, file: string): ResourceFile {
    const { root, expert } = this.library.resourceLocation(id);
    if (!this.checkQuality(id).cases.some(item => item.id === file)) throw new Error('测试用例不存在');
    return read(safe(root, 'tests/cases/' + file), expert.sourceLabel + '/tests/cases/' + file);
  }
}
