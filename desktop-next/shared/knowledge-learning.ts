import type { KnowledgeReference } from './knowledge-lookup';
import type { TaskUsage } from './contracts';

export interface LearningInput { collectionId: string; documentId: string; scope: string; model: string; lineStart: number; lineEnd: number }
export interface LearningNote { text: string; quote: string; lineStart: number; lineEnd: number }
export interface LearningChunk { lineStart: number; lineEnd: number; state: 'queued' | 'started' | 'received' | 'done' | 'unknown' | 'failed'; notes: LearningNote[]; gaps: string[]; usage?: TaskUsage; rawResponse?: string; finishReason?: string; error: string }
export const learningOutputLimit = 8192;
export const learningPromptVersion = 'soul-grounded-notes-v2';
export interface LearningPreview { token: string; sourceId: string; sourceName: string; version: string; bodySha256: string; model: string; promptVersion: string; lineStart: number; lineEnd: number; chunks: number; inputTokenUpperEstimate: number; outputTokenLimit: number; cost: string }
export interface LearningJob extends LearningPreview { id: string; scope: string; collectionId: string; documentId: string; reference: KnowledgeReference; created: string; updated: string; state: 'running' | 'completed' | 'interrupted'; parts: LearningChunk[] }
export interface LearningAPI {
  preview(input: LearningInput): Promise<LearningPreview>;
  start(token: string, scope: string): Promise<LearningJob>;
  list(collectionId: string, documentId: string, scope: string): Promise<LearningJob[]>;
  read(id: string, scope: string): Promise<LearningJob>;
  cancel(id: string, scope: string): Promise<void>;
}
