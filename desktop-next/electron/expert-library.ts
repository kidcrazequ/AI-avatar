import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { parse } from 'yaml';
import { assertSafeSegment, resolveUnderRoot } from '../../packages/core/src/utils/path-security';
import type { ArchiveFile, CreateExpertInput, ExpertDetail, ExpertGroup, ExpertRecord, ImportPreview, LibrarySnapshot, RoleInput, SkillReference } from '../shared/contracts';

interface PackMeta {
  id: string; name: string; description: string; domain: string; version: string; author: string;
  sourceAvatarId: string; redline: string; defaultModel?: string; installable?: boolean; draft?: boolean;
}
interface Pack { id: string; root: string; meta: PackMeta; source: ExpertRecord['source'] }
interface Instance { id: string; template_id: string; name: string; description: string; installed_at: string; archived: number }
const requiredFiles = ['soul.md', 'AGENTS.md', 'knowledge/README.md', 'skills/skill-index.yaml', 'memory/MEMORY.md'];
const catalogueOrder = ['小堵-工商储专家', 'design-master', 'finance-expert', 'electrical-engineer-expert', 'product-manager-expert', 'hr-expert', 'legal-expert', 'market-analyst-expert', 'project-manager-expert', 'orchestrator'];
const readText = (file: string) => {
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('文本超过 2 MB，请拆分后导入');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
};
const field = (value: unknown, label: string, limit: number, optional = false): string => {
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) throw new Error(`${label}须为 ${optional ? '0' : '1'}–${limit} 个字符`);
  return value.trim();
};
const portableId = (value: unknown) => {
  const id = field(value, '专家 ID', 120);
  assertSafeSegment(id, '专家 ID');
  if (/[<>:"|?*\x00-\x1f]/.test(id) || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) throw new Error('专家 ID 无法用作 Windows 目录名');
  return id;
};
const displayName = (name: string) => name.match(/[（(]([^）)]+)[）)]$/)?.[1] ?? name;

// Import snapshots reject links and special files before copying anything into the catalogue.
function packFiles(root: string): Array<{ relative: string; bytes: number }> {
  const files: Array<{ relative: string; bytes: number }> = [];
  let total = 0;
  const walk = (relative: string, depth: number) => {
    if (depth > 20) throw new Error('专家包目录层级过深');
    const absolute = relative ? resolveUnderRoot(root, relative) : root;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`专家包不接受符号链接：${relative || '根目录'}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) {
        if (name === '.git' || name === '.DS_Store') continue;
        assertSafeSegment(name, '资源文件名');
        walk(path.join(relative, name), depth + 1);
      }
    } else if (stat.isFile()) {
      total += stat.size;
      if (stat.size > 32 * 1024 * 1024 || total > 200 * 1024 * 1024 || files.length >= 3000) throw new Error('专家包超过文件数量或体积限制');
      files.push({ relative, bytes: stat.size });
    } else throw new Error(`不支持的资源类型：${relative}`);
  };
  walk('', 0);
  return files;
}

function metadata(root: string): PackMeta {
  const raw: unknown = JSON.parse(readText(resolveUnderRoot(root, 'expert-pack.json')));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expert-pack.json 必须是对象');
  const data = raw as Record<string, unknown>;
  const result = {} as PackMeta;
  for (const key of ['id', 'name', 'description', 'domain', 'version', 'author', 'sourceAvatarId', 'redline'] as const) result[key] = field(data[key], key, key === 'description' || key === 'redline' ? 2000 : 120);
  portableId(result.id);
  result.defaultModel = data.defaultModel === undefined ? 'Auto' : field(data.defaultModel, '默认模型', 120);
  result.installable = data.installable !== false && data.draft !== true;
  result.draft = data.draft === true;
  for (const file of requiredFiles) if (!fs.existsSync(resolveUnderRoot(root, file))) throw new Error(`专家包缺少 ${file}`);
  return result;
}

function copyPack(source: string, target: string): void {
  const entries = packFiles(source);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of entries) {
    const destination = resolveUnderRoot(target, entry.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(resolveUnderRoot(source, entry.relative), destination, fs.constants.COPYFILE_EXCL);
  }
}

function avatar(root: string): string {
  const image = resolveUnderRoot(root, 'avatar.png');
  if (fs.existsSync(image) && fs.statSync(image).size <= 2 * 1024 * 1024) {
    const data = fs.readFileSync(image);
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return `data:image/png;base64,${data.toString('base64')}`;
  }
  const ref = resolveUnderRoot(root, 'avatar.txt');
  return fs.existsSync(ref) ? readText(ref).trim() : '';
}

function writeAvatar(root: string, image: string): void {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 2.8 * 1024 * 1024) throw new Error('头像须为不超过 2 MB 的 PNG 图片');
  const bytes = Buffer.from(image.split(',')[1], 'base64');
  if (bytes.length > 2 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('头像图片无效或超过 2 MB');
  fs.writeFileSync(resolveUnderRoot(root, 'avatar.png'), bytes);
}

function plain(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/^>.*$/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`#]/g, '').replace(/^[-=]{3,}$/gm, '').trim();
}
function soulItems(soul: string, pattern: RegExp, fallback: string, bulletsFirst = false): Array<{ title: string; text: string }> {
  const blocks = soul.split(/(?=^##\s+)/m);
  const block = blocks.find(item => pattern.test(item.split('\n')[0]));
  if (!block) return [{ title: '资料说明', text: fallback }];
  const body = block.slice(block.indexOf('\n') + 1);
  const bullets = body.split('\n').filter(line => /^\s*[-*]\s+/.test(line)).slice(0, 3).map(line => {
    const text = plain(line.replace(/^\s*[-*]\s+/, ''));
    const bold = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*\s*[：:]?\s*(.*)$/);
    return bold ? { title: plain(bold[1]), text: plain(bold[2]) } : { title: text.split(/[，,：:]/)[0].slice(0, 50), text };
  });
  if (bulletsFirst && bullets.length) return bullets;
  const sections = body.split(/(?=^###\s+)/m).filter(item => /^###\s+/.test(item) && !/示例|口头禅/.test(item.split('\n')[0])).slice(0, 3).map(item => ({ title: plain(item.split('\n')[0]), text: plain(item.slice(item.indexOf('\n') + 1)).split(/\n\s*\n/)[0].slice(0, 650) }));
  return sections.length ? sections : bullets.length ? bullets : [{ title: '资料说明', text: plain(body).split(/\n\s*\n/)[0].slice(0, 650) || fallback }];
}

export class ExpertLibrary {
  private db: Database.Database;
  private pending = new Map<string, { root: string; preview: ImportPreview }>();
  private avatarsRoot: string;
  private importedRoot: string;
  private customRoot: string;
  private stagingRoot: string;
  constructor(private resourceRoot: string, private profileRoot: string) {
    fs.mkdirSync(profileRoot, { recursive: true });
    this.avatarsRoot = path.join(profileRoot, 'avatars');
    this.importedRoot = path.join(profileRoot, 'expert-packs');
    this.customRoot = path.join(profileRoot, 'role-drafts');
    this.stagingRoot = path.join(profileRoot, 'import-staging');
    for (const root of [this.avatarsRoot, this.importedRoot, this.customRoot, this.stagingRoot]) fs.mkdirSync(root, { recursive: true });
    this.db = new Database(path.join(profileRoot, 'soul.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS experts (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, installed_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS expert_active_name ON experts(name COLLATE NOCASE) WHERE archived=0;
      CREATE TABLE IF NOT EXISTS hidden_experts (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS expert_groups (id TEXT PRIMARY KEY, value TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);`);
  }
  close(): void {
    for (const token of [...this.pending.keys()]) this.discardImport(token);
    this.db.close();
  }
  private packs(): Pack[] {
    return ([['bundled', path.join(this.resourceRoot, 'expert-packs')], ['imported', this.importedRoot], ['custom', this.customRoot]] as const).flatMap(([source, root]) =>
      fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith('.')).map(item => {
        const folder = resolveUnderRoot(root, item.name);
        return { id: item.name, root: folder, meta: metadata(folder), source };
      })).sort((left, right) => {
        const rank = (pack: Pack) => pack.source === 'bundled' ? catalogueOrder.indexOf(pack.id) : catalogueOrder.length;
        return rank(left) - rank(right);
      });
  }
  private instance(id: string): Instance | undefined {
    return this.db.prepare('SELECT * FROM experts WHERE id=? AND archived=0').get(portableId(id)) as Instance | undefined;
  }
  private record(pack: Pack, instance?: Instance): ExpertRecord {
    const root = instance ? resolveUnderRoot(this.avatarsRoot, instance.id) : pack.root;
    const files = packFiles(root);
    return {
      id: instance?.id ?? pack.id, templateId: pack.id, name: instance?.name ?? displayName(pack.meta.name),
      description: instance?.description ?? pack.meta.description, role: pack.meta.name.replace(/[（(][^）)]+[）)]$/, ''),
      domain: pack.meta.domain, version: pack.meta.version, author: pack.meta.author, redline: pack.meta.redline,
      defaultModel: pack.meta.defaultModel ?? 'Auto', avatar: avatar(root), source: pack.source,
      sourceLabel: instance ? `avatars/${instance.id}` : `${pack.source === 'custom' ? 'role-drafts' : 'expert-packs'}/${pack.id}`,
      installed: Boolean(instance), installedAt: instance?.installed_at ?? null, draft: pack.meta.draft === true,
      installable: pack.meta.installable !== false, knowledgeFiles: files.filter(item => item.relative.startsWith('knowledge' + path.sep) && item.relative.endsWith('.md')).length,
    };
  }
  list(): LibrarySnapshot {
    const packs = this.packs();
    const instances = this.db.prepare('SELECT * FROM experts WHERE archived=0 ORDER BY installed_at').all() as Instance[];
    const hidden = new Set((this.db.prepare('SELECT id FROM hidden_experts').all() as Array<{ id: string }>).map(item => item.id));
    const experts = packs.filter(pack => !hidden.has(pack.id)).map(pack => this.record(pack, instances.find(item => item.id === pack.id)));
    for (const instance of instances.filter(item => !packs.some(pack => pack.id === item.id))) {
      const pack = packs.find(item => item.id === instance.template_id);
      if (!pack) throw new Error(`已安装专家的模板丢失：${instance.id}`);
      experts.push(this.record(pack, instance));
    }
    const active = new Set(experts.filter(expert => expert.installed).map(expert => expert.id));
    const groups = this.db.prepare('SELECT value FROM expert_groups WHERE archived=0').all().map(row => {
      const group = JSON.parse((row as { value: string }).value) as ExpertGroup;
      const members = group.members.filter(member => active.has(member.expertId));
      return { ...group, members, leader: members.some(member => member.expertId === group.leader) ? group.leader : members[0]?.expertId ?? '' };
    }).filter(group => group.members.length);
    const removed = new Set([...hidden, ...(this.db.prepare('SELECT id FROM experts WHERE archived=1').all() as Array<{ id: string }>).map(item => item.id)]).size + (this.db.prepare('SELECT count(*) AS count FROM expert_groups WHERE archived=1').get() as { count: number }).count;
    return { experts, templates: packs.map(pack => this.record(pack)), groups, removed };
  }
  private resolve(id: string): { expert: ExpertRecord; root: string; pack: Pack } {
    portableId(id);
    const instance = this.instance(id);
    const pack = this.packs().find(item => item.id === (instance?.template_id ?? id));
    if (!pack) throw new Error('专家不存在');
    return { expert: this.record(pack, instance), root: instance ? resolveUnderRoot(this.avatarsRoot, id) : pack.root, pack };
  }
  detail(id: string): ExpertDetail {
    const { expert, root } = this.resolve(id);
    const soul = readText(resolveUnderRoot(root, 'soul.md'));
    const config: unknown = parse(readText(resolveUnderRoot(root, 'skills/skill-index.yaml')), { maxAliasCount: 50 });
    const data = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {};
    const skills = new Map<string, SkillReference>();
    const priority = { local: 3, shared: 2, community: 1 };
    for (const entries of Object.values(data).filter(Array.isArray)) for (const item of entries) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.path !== 'string') continue;
      const source: SkillReference['source'] = item.source === 'shared' || item.source === 'community' ? item.source : 'local';
      const absolute = resolveUnderRoot(source === 'local' ? root : this.resourceRoot, item.path);
      const entry = { id: item.name, name: item.name, path: item.path, source, domain: typeof item.domain === 'string' ? item.domain : '', available: fs.existsSync(absolute) && fs.statSync(absolute).isFile() };
      if (!skills.has(entry.id) || priority[source] > priority[skills.get(entry.id)!.source]) skills.set(entry.id, entry);
    }
    const memoryFile = resolveUnderRoot(root, 'memory/MEMORY.md');
    return { ...expert, about: [
      { title: '擅长', source: 'soul.md · Background', items: soulItems(soul, /Background|专业背景/, expert.description, true) },
      { title: '工作风格', source: 'soul.md · Style', items: soulItems(soul, /Style|我怎么说话/, '请查看人格原文', true) },
      { title: '工作模式', source: 'soul.md · Workflow', items: soulItems(soul, /Workflow|我怎么工作/, '请查看操作规则原文') },
    ], skills: [...skills.values()], memory: { text: readText(memoryFile), source: `${expert.sourceLabel}/memory/MEMORY.md` },
      archives: ['expert-pack.json', 'soul.md', 'AGENTS.md', 'CLAUDE.md', 'knowledge/README.md', 'skills/skill-index.yaml', 'memory/MEMORY.md', 'avatar.config.json'].filter(file => fs.existsSync(resolveUnderRoot(root, file))),
      testCases: fs.existsSync(resolveUnderRoot(root, 'tests/cases')) ? fs.readdirSync(resolveUnderRoot(root, 'tests/cases')).filter(file => file.endsWith('.md')).length : 0 };
  }
  archive(id: string, file: string): ArchiveFile {
    const detail = this.detail(id);
    const skill = detail.archives.includes(file) ? undefined : detail.skills.find(item => item.id === file);
    if (!detail.archives.includes(file) && !skill) throw new Error('只能读取专家档案或声明的技能文件');
    const { root } = this.resolve(id);
    const relative = skill?.path ?? file;
    const origin = skill && skill.source !== 'local' ? this.resourceRoot : root;
    const absolute = resolveUnderRoot(origin, relative);
    if (!fs.existsSync(absolute)) throw new Error(`尚未提供技能文件：${relative}`);
    return { path: relative, source: skill && skill.source !== 'local' ? relative : `${detail.sourceLabel}/${relative}`, content: readText(absolute) };
  }
  private availableName(name: string, except?: string): string {
    const clean = field(name, '专家名称', 24);
    const archived = this.db.prepare('SELECT id,name FROM experts WHERE archived=1').all() as Array<{ id: string; name: string }>;
    const hidden = (this.db.prepare('SELECT id FROM hidden_experts').all() as Array<{ id: string }>).filter(item => !archived.some(expert => expert.id === item.id));
    const reserved = this.packs().filter(pack => hidden.some(item => item.id === pack.id)).map(pack => this.record(pack));
    if ([...this.list().experts, ...archived, ...reserved].some(item => item.id !== except && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) throw new Error('专家名称已存在，请恢复已移除的专家或换一个名称');
    return clean;
  }
  private install(pack: Pack, id: string, name: string, description: string, image: string | null = null): void {
    if (!pack.meta.installable) throw new Error('这个角色仍为草案，完善资料并审核后再安装');
    const target = resolveUnderRoot(this.avatarsRoot, portableId(id));
    if (fs.existsSync(target)) throw new Error('专家运行目录已存在，请先恢复已移除的专家');
    const staged = resolveUnderRoot(this.avatarsRoot, `.install-${crypto.randomUUID()}`);
    const installedAt = new Date().toISOString();
    try {
      copyPack(pack.root, staged);
      if (image) writeAvatar(staged, image);
      fs.writeFileSync(resolveUnderRoot(staged, 'avatar.config.json'), JSON.stringify({ name, description, defaultModel: pack.meta.defaultModel ?? 'Auto', expertPack: { id: pack.meta.id, version: pack.meta.version, installedAt } }, null, 2));
      fs.renameSync(staged, target);
      try { this.db.prepare('INSERT INTO experts (id,template_id,name,description,installed_at) VALUES (?,?,?,?,?)').run(id, pack.id, name, description, installedAt); }
      catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
    } finally { fs.rmSync(staged, { recursive: true, force: true }); }
  }
  installExpert(id: string): LibrarySnapshot {
    const { pack, expert } = this.resolve(id);
    if (expert.installed) return this.list();
    this.availableName(expert.name, id);
    this.install(pack, id, expert.name, expert.description);
    return this.list();
  }
  createExpert(input: CreateExpertInput): LibrarySnapshot {
    const name = this.availableName(input.name);
    const description = field(input.description, '简介', 2000, true);
    const pack = this.packs().find(item => item.id === input.templateId);
    if (!pack) throw new Error('请选择有效的角色模板');
    this.install(pack, `expert-${crypto.randomUUID()}`, name, description || pack.meta.description, input.avatar);
    return this.list();
  }
  renameExpert(id: string, name: string): LibrarySnapshot {
    const value = this.availableName(name, id);
    if (!this.instance(id)) this.installExpert(id);
    const { root } = this.resolve(id);
    const config = JSON.parse(readText(resolveUnderRoot(root, 'avatar.config.json'))) as Record<string, unknown>;
    const file = resolveUnderRoot(root, 'avatar.config.json');
    const previous = fs.readFileSync(file);
    const temporary = resolveUnderRoot(root, `.config-${crypto.randomUUID()}.json`);
    fs.writeFileSync(temporary, JSON.stringify({ ...config, name: value }, null, 2));
    fs.renameSync(temporary, file);
    try { this.db.prepare('UPDATE experts SET name=? WHERE id=? AND archived=0').run(value, id); }
    catch (error) { fs.writeFileSync(file, previous); throw error; }
    return this.list();
  }
  removeExpert(id: string): LibrarySnapshot {
    this.resolve(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE experts SET archived=1 WHERE id=?').run(id);
      this.db.prepare('INSERT OR IGNORE INTO hidden_experts VALUES (?)').run(id);
    })();
    return this.list();
  }
  restoreExperts(): LibrarySnapshot {
    try { this.db.transaction(() => { this.db.prepare('UPDATE experts SET archived=0').run(); this.db.prepare('DELETE FROM hidden_experts').run(); this.db.prepare('UPDATE expert_groups SET archived=0').run(); })(); }
    catch { throw new Error('恢复的专家名称与现有专家重复，请先修改现有名称'); }
    return this.list();
  }
  previewImport(source: string): ImportPreview {
    const token = crypto.randomUUID();
    const target = resolveUnderRoot(this.stagingRoot, token);
    try {
      copyPack(source, target);
      const meta = metadata(target);
      if (this.packs().some(pack => pack.id.toLocaleLowerCase() === meta.id.toLocaleLowerCase() || pack.meta.id.toLocaleLowerCase() === meta.id.toLocaleLowerCase())) throw new Error('这个专家包 ID 已存在');
      const pack: Pack = { id: meta.id, root: target, meta, source: 'imported' };
      const expert = this.record(pack);
      this.availableName(expert.name);
      const files = packFiles(target);
      const preview = { token, expert, files: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0) };
      this.pending.set(token, { root: target, preview });
      return preview;
    } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
  }
  discardImport(token: string): void {
    const staged = this.pending.get(token);
    if (staged) { fs.rmSync(staged.root, { recursive: true, force: true }); this.pending.delete(token); }
  }
  importExpert(token: string): LibrarySnapshot {
    const staged = this.pending.get(token);
    if (!staged) throw new Error('导入预览已过期，请重新选择专家包目录');
    const id = staged.preview.expert.id;
    if (this.packs().some(pack => pack.id.toLocaleLowerCase() === id.toLocaleLowerCase())) throw new Error('专家包 ID 已存在');
    this.availableName(staged.preview.expert.name);
    fs.renameSync(staged.root, resolveUnderRoot(this.importedRoot, id));
    this.pending.delete(token);
    return this.list();
  }
  saveGroup(input: ExpertGroup): LibrarySnapshot {
    const id = input.id ? portableId(input.id) : `group-${crypto.randomUUID()}`;
    const name = field(input.name, '群组名称', 40);
    if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 50) throw new Error('请选择 1–50 位专家');
    const experts = this.list().experts;
    const seen = new Set<string>();
    const members = input.members.map(member => {
      if (!experts.some(expert => expert.id === member.expertId && expert.installed && !expert.draft) || seen.has(member.expertId)) throw new Error('群组成员必须为不重复的已安装专家');
      seen.add(member.expertId);
      const directory = field(member.directory, '工作目录', 1000, true);
      if (directory && (!path.isAbsolute(directory) || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) throw new Error('工作目录须为已存在的绝对目录');
      return { expertId: member.expertId, model: field(member.model, '模型', 120), directory };
    });
    if (!seen.has(input.leader)) throw new Error('Leader 必须是已选择的专家');
    const groups = this.db.prepare('SELECT value FROM expert_groups').all().map(row => JSON.parse((row as { value: string }).value) as ExpertGroup);
    if (groups.some(group => group.id !== id && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('群组名称已存在，请恢复已移除的群组或换一个名称');
    this.db.prepare('INSERT INTO expert_groups (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,archived=0').run(id, JSON.stringify({ id, name, leader: input.leader, members }));
    return this.list();
  }
  removeGroup(id: string): LibrarySnapshot {
    this.db.prepare('UPDATE expert_groups SET archived=1 WHERE id=?').run(portableId(id));
    return this.list();
  }
  createRole(input: RoleInput): LibrarySnapshot {
    const name = this.availableName(input.name);
    const description = field(input.description, '一句话定位', 2000);
    const fields = { identity: field(input.identity, '核心职责', 8000), style: field(input.style, '工作风格', 8000), workflow: field(input.workflow, '工作流程', 8000) };
    const id = `role-${crypto.randomUUID()}`;
    const root = resolveUnderRoot(this.customRoot, id);
    const templates = path.join(this.resourceRoot, 'templates');
    const template = (name: string) => readText(resolveUnderRoot(templates, name)).replace(/\r\n?/g, '\n');
    let soul = template('soul-template.md').replaceAll('[分身名称]', name).replaceAll('[名字]', name).replaceAll('YYYY-MM-DD', new Date().toISOString().slice(0, 10));
    for (const [chapter, content] of [[1, fields.identity], [3, fields.style], [5, fields.workflow]] as const) {
      const pattern = new RegExp(`(## ${chapter}\\. [^\\n]+\\n)([\\s\\S]*?)(?=\\n## ${chapter + 1}\\.)`);
      soul = soul.replace(pattern, (_match, heading: string) => `${heading}\n${content}\n\n---\n`);
    }
    const values: Record<string, string> = { AGENT_NAME: id, AVATAR_ID: id, AGENT_DISPLAY_NAME: name, AGENT_DESCRIPTION_CN: description, AGENT_DESCRIPTION_EN: 'User-authored role draft', ROLE_DESCRIPTION: fields.identity, DOMAIN: description, KNOWLEDGE_DIR: `avatars/${id}/knowledge/` };
    const expand = (source: string) => source.replace(/\{\{([A-Z_0-9]+)\}\}/g, (match, key: string) => values[key] ?? match);
    const agents = expand(template('agent-template.md'));
    const readme = expand(template('knowledge-readme-template.md'));
    const testTemplate = template('test-case-template.md').match(/```markdown\n([\s\S]*?)\n```/)?.[1];
    if (!testTemplate) throw new Error('测试用例模板不可用');
    try {
      for (const dir of ['knowledge', 'skills', 'memory', 'tests/cases']) fs.mkdirSync(resolveUnderRoot(root, dir), { recursive: true });
      for (const [file, content] of [['soul.md', soul], ['AGENTS.md', agents], ['CLAUDE.md', agents], ['knowledge/README.md', readme], ['skills/skill-index.yaml', 'skills: []\n'], ['memory/MEMORY.md', '']] as const) fs.writeFileSync(resolveUnderRoot(root, file), content);
      if (input.avatar) writeAvatar(root, input.avatar);
      for (const [caseId, category] of [['redline-001', '红线合规'], ['redline-002', '红线合规'], ['knowledge-001', '知识库约束'], ['traceability-001', '数据溯源'], ['personality-001', '人格一致性']]) fs.writeFileSync(resolveUnderRoot(root, `tests/cases/${caseId}.md`), testTemplate.replace('{category}-{number}', caseId).replace('红线合规 | 人格一致性 | 技能验证', category).replace('简短描述测试目标', () => `${name} · ${category}（待补充）`));
      fs.writeFileSync(resolveUnderRoot(root, 'expert-pack.json'), JSON.stringify({ id, name, description, domain: description, version: '0.1.0-draft', author: '用户', sourceAvatarId: id, redline: '角色草案待审核；知识、示例与测试待补充，尚不可运行', installable: false, draft: true, defaultModel: 'Auto' }, null, 2));
      return this.list();
    } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  }
}
