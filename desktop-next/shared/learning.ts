import type { ModelEntry, SkillItem, TaskUsage } from './contracts';

export interface EvolutionSetting { enabled: boolean; since: string; revision: number }
export interface EvolutionDraft {
  id: string; expertId: string; taskId: string; taskTitle: string; sourceRevision: string;
  model: string; targetKey: string; targetRevision: string; created: string; updated: string;
  state: 'generating' | 'draft' | 'failed' | 'cancelled' | 'rejected' | 'applying' | 'applied';
  name: string; description: string; content: string; note: string; error: string;
  usage?: TaskUsage; usageUnknown?: boolean; publishedKey?: string;
}
export interface EvolutionSkill { item: SkillItem; allowed: boolean; versions: EvolutionDraft[] }
export interface EvolutionSnapshot { setting: EvolutionSetting; skills: EvolutionSkill[]; drafts: EvolutionDraft[]; tasks: Array<{ id: string; title: string; revision: string }>; models: ModelEntry[] }
export interface EvolutionInput { expertId: string; taskId: string; model: string; targetKey: string; requestId: string }
export interface EvolutionAPI {
  read(expertId: string): Promise<EvolutionSnapshot>;
  configure(expertId: string, revision: number, enabled: boolean): Promise<void>;
  allow(expertId: string, key: string, enabled: boolean): Promise<void>;
  generate(input: EvolutionInput): Promise<string>;
  resolve(id: string, updated: string, content: string, accepted: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
