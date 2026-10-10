export interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}

export interface Expert {
  id: string;
  name: string;
  description: string;
  domain: string;
  knowledgeFiles: number;
}

export interface RuntimeStatus {
  version: string;
  platform: string;
  arch: string;
  sourceSha: string;
  checks: Check[];
  experts: Expert[];
  resources: { files: number; bytes: number; sha256: string };
  persistenceRun: number;
}

export interface DesktopAPI {
  readStatus(): Promise<RuntimeStatus>;
  readLibrary(): Promise<LibrarySnapshot>;
  readExpert(id: string): Promise<ExpertDetail>;
  readArchive(id: string, file: string): Promise<ArchiveFile>;
  installExpert(id: string): Promise<LibrarySnapshot>;
  createExpert(input: CreateExpertInput): Promise<LibrarySnapshot>;
  renameExpert(id: string, name: string): Promise<LibrarySnapshot>;
  removeExpert(id: string): Promise<LibrarySnapshot>;
  restoreExperts(): Promise<LibrarySnapshot>;
  chooseExpertImport(): Promise<ImportPreview | null>;
  importExpert(token: string): Promise<LibrarySnapshot>;
  discardImport(token: string): Promise<void>;
  saveGroup(input: ExpertGroup): Promise<LibrarySnapshot>;
  removeGroup(id: string): Promise<LibrarySnapshot>;
  createRole(input: RoleInput): Promise<LibrarySnapshot>;
  chooseAvatar(): Promise<string | null>;
  chooseRoleText(): Promise<string | null>;
  saveRoleTemplate(): Promise<boolean>;
  chooseDirectory(): Promise<string | null>;
  resources: ResourceAPI;
  tasks: TaskAPI;
}

export interface ExpertRecord extends Expert {
  role: string;
  version: string;
  author: string;
  redline: string;
  defaultModel: string;
  avatar: string;
  source: 'bundled' | 'imported' | 'custom';
  sourceLabel: string;
  installed: boolean;
  installedAt: string | null;
  draft: boolean;
  installable: boolean;
  templateId: string;
}

export interface SkillReference {
  id: string;
  name: string;
  domain: string;
  source: 'local' | 'shared' | 'community';
  path: string;
  available: boolean;
}

export interface ExpertDetail extends ExpertRecord {
  about: Array<{ title: string; source: string; items: Array<{ title: string; text: string }> }>;
  skills: SkillReference[];
  archives: string[];
  memory: { text: string; source: string };
  testCases: number;
}

export interface ArchiveFile { path: string; source: string; content: string }
export interface GroupMember { expertId: string; model: string; directory: string }
export interface ExpertGroup { id: string; name: string; leader: string; members: GroupMember[] }
export interface LibrarySnapshot { experts: ExpertRecord[]; groups: ExpertGroup[]; templates: ExpertRecord[]; removed: number }
export interface CreateExpertInput { templateId: string; name: string; description: string; avatar: string | null }
export interface ImportPreview { token: string; expert: ExpertRecord; files: number; bytes: number }
export interface RoleInput { name: string; description: string; identity: string; style: string; workflow: string; avatar?: string | null }

export interface ProjectSource { type: 'local' | 'git'; path: string }
export interface ResourceProject { id: string; name: string; description: string; expertId: string; sources: ProjectSource[]; updated: string }
export interface KnowledgeCollection { id: string; title: string; source: string; documents: number; builtin: boolean; writable: boolean }
export interface ResourceDocument { id: string; name: string; path: string; bytes: number; placeholder: boolean }
export interface ResourceFile extends ArchiveFile { revision: string }
export interface SkillItem extends SkillReference { key: string; description: string; title: string; category: string; configured: boolean }
export interface ResourceSnapshot { projects: ResourceProject[]; collections: KnowledgeCollection[]; bindings: string[]; skills: SkillItem[]; memory: ResourceFile | null; settings: ResourceFile | null; versions: ResourceVersion[]; quality: QualityReport | null }
export interface ResourceVersion { id: number; at: string; reason: string; file: string; content: string }
export interface QualityReport { at: string; checks: Array<{ name: string; ok: boolean; source: string }>; cases: ResourceDocument[]; knowledge: number; professional: '未执行' }
export interface DocumentInput { collectionId: string; id: string; name: string; content: string; revision: string }
export interface ResourceAPI {
  read(expertId: string): Promise<ResourceSnapshot>;
  saveProject(input: ResourceProject, scope: string): Promise<void>;
  removeProject(id: string, scope: string): Promise<void>;
  saveCollection(id: string, title: string): Promise<void>;
  removeCollection(id: string): Promise<void>;
  restoreTrash(scope: string): Promise<void>;
  bind(expertId: string, ids: string[]): Promise<void>;
  documents(collectionId: string, scope: string): Promise<ResourceDocument[]>;
  readDocument(collectionId: string, id: string, scope: string): Promise<ResourceFile>;
  saveDocument(input: DocumentInput, scope: string): Promise<void>;
  removeDocument(collectionId: string, id: string, revision: string, scope: string): Promise<void>;
  chooseText(kind: 'document' | 'skill'): Promise<{ name: string; content: string } | null>;
  saveMemory(expertId: string, text: string, revision: string, group: string): Promise<void>;
  restoreVersion(expertId: string, id: number, revision: string): Promise<void>;
  readSkill(expertId: string, key: string): Promise<ResourceFile>;
  configureSkill(expertId: string, key: string, enabled: boolean): Promise<void>;
  uploadSkill(expertId: string, text: string): Promise<void>;
  saveSettings(expertId: string, name: string, description: string, model: string): Promise<LibrarySnapshot>;
  saveSoul(expertId: string, text: string, revision: string): Promise<void>;
  checkQuality(expertId: string): Promise<QualityReport>;
  readCase(expertId: string, file: string): Promise<ResourceFile>;
}

export type TaskStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'stopped' | 'interrupted' | 'failed';
export interface ModelEntry { id: string; label: string; model: string; baseUrl: string; protocol: 'openai' | 'anthropic'; configured: boolean }
export interface ModelInput { id: string; label: string; model: string; baseUrl: string; protocol: 'openai' | 'anthropic'; apiKey: string }
export interface TaskFile { id: string; name: string; source: string; content: string; hash: string }
export interface TaskMember { expertId: string; name: string; avatar: string; model: string; directory: string; system: string; knowledge: TaskFile[]; skills: TaskFile[] }
export interface TaskMessage { id: string; role: 'user' | 'assistant'; text: string; expertId: string; at: string; attachments?: TaskFile[] }
export interface TaskEvent { at: string; text: string; kind: string }
export interface WireCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface WireMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: WireCall[]; tool_call_id?: string; reasoning_content?: string }
export interface TaskUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
export interface TaskRound { id: string; member: number; kind: 'normal' | 'repair'; state: 'started' | 'done' | 'unknown' | 'failed'; text: string; reasoning?: string; calls: WireCall[]; usage?: TaskUsage }
export interface TaskApproval { id: string; taskId: string; expertId: string; state: 'pending' | 'approved' | 'rejected' | 'cancelled'; requested: string; resolved?: string; destination: string; content: string; hash: string; note: string; callId: string; roundId: string }
export interface TaskCheckpoint { member: number; wire: WireMessage[]; calls: WireCall[]; callIndex: number; repairing: boolean; memberRounds: number }
export interface TaskRecord { id: string; title: string; expertId: string; groupId: string; owner: string; status: TaskStatus; created: string; updated: string; project: ResourceProject | null; members: TaskMember[]; messages: TaskMessage[]; events: TaskEvent[]; approvals: TaskApproval[]; rounds: TaskRound[]; checkpoint: TaskCheckpoint; artifacts: Array<{ path: string; hash: string }>; error: string }
export type TaskView = Omit<TaskRecord, 'checkpoint' | 'members'> & { members: Array<Pick<TaskMember, 'expertId' | 'name' | 'avatar' | 'model' | 'directory'>> };
export interface TaskSnapshot { tasks: TaskView[]; models: ModelEntry[] }
export interface TaskSendInput { requestId: string; taskId: string; expertId: string; groupId: string; model: string; directory: string; projectId: string; text: string; attachments: TaskFile[] }
export interface TaskAPI {
  read(): Promise<TaskSnapshot>;
  send(input: TaskSendInput): Promise<string>;
  resume(id: string, requestId: string): Promise<void>;
  cancel(id: string, requestId: string): Promise<void>;
  approve(id: string, approvalId: string, approved: boolean, note: string, requestId: string): Promise<void>;
  saveModel(input: ModelInput): Promise<ModelEntry[]>;
  importModels(): Promise<ModelEntry[]>;
  chooseAttachments(): Promise<TaskFile[]>;
  exportResult(id: string): Promise<boolean>;
  onChanged(listener: () => void): () => void;
}
