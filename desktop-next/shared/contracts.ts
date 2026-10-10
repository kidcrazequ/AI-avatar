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
}
