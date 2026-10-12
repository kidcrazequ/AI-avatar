import type { ModelEntry, RoleInput, TaskRound } from './contracts';
export type LearningKind = 'recording' | 'personal';
export type LearningState = 'capturing' | 'ready' | 'analyzing' | 'draft' | 'applying' | 'saved' | 'failed' | 'cancelled' | 'rejected';
export interface LearningSetting { enabled: boolean; revision: number }
export interface LearningSource { name: string; type: string; hash: string; bytes: number }
export interface LearningRecord {
  id: string; kind: LearningKind; expertId: string; name: string; taskId: string; taskTitle: string;
  created: string; updated: string; revision: number; state: LearningState; sources: LearningSource[];
  duration: number; frames: number; model: string; vision: boolean; error: string; note: string;
  content: string; role?: RoleInput; memory: string; publishedKey: string; publishedExpert: string;
  usage?: TaskRound['usage']; usageUnknown?: boolean; approved?: { content: string; role?: RoleInput; memory: string };
}
export interface LearningInput { kind: LearningKind; expertId: string; name: string; taskId: string; text: string; sourceType: 'demonstration' | 'chat' | 'meeting' | 'document'; consented: boolean }
export interface LearningSnapshot { setting: LearningSetting; records: LearningRecord[]; models: ModelEntry[]; platform: string; capturePermission: string }
export interface RecordingAPI {
  read(kind: LearningKind, expertId: string): Promise<LearningSnapshot>;
  configure(expertId: string, revision: number, enabled: boolean): Promise<void>;
  create(input: LearningInput): Promise<string>;
  chooseText(): Promise<{ name: string; content: string } | null>;
  chooseVideo(expertId: string, name: string, taskId: string): Promise<string | null>;
  source(id: string): Promise<{ text: string; frames: string[] }>;
  media(id: string): Promise<void>;
  sources(): Promise<Array<{ id: string; name: string }>>;
  begin(expertId: string, name: string, taskId: string, sourceId: string, consented: boolean): Promise<string>;
  append(id: string, bytes: Uint8Array): Promise<void>;
  finish(id: string, text: string, frames: string[], duration: number): Promise<void>;
  analyze(id: string, revision: number, model: string, vision: boolean, text: string, consented: boolean): Promise<void>;
  resolve(id: string, revision: number, content: string, role: RoleInput | undefined, memory: string, accepted: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
