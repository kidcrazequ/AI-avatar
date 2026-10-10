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
