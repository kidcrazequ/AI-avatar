import type { ModelEntry, TaskUsage } from './contracts';

export interface AssistantTurn { id: string; text: string; answer: string; model: string; at: string; state: 'running' | 'done' | 'failed' | 'cancelled'; error: string; usage?: TaskUsage; usageUnknown: boolean }
export interface AssistantChat { id: string; title: string; created: string; updated: string; revision: number; turns: AssistantTurn[] }
export interface AssistantNotification { id: string; title: string; detail: string; at: string; taskId: string; read: boolean }
export interface AssistantFeedback { id: string; text: string; email: string; images: string[]; version: string; at: string; state: 'local' }
export interface AssistantSnapshot { version: string; chats: AssistantChat[]; models: ModelEntry[]; notifications: AssistantNotification[]; feedback: AssistantFeedback[] }
export interface AssistantInput { chatId: string; requestId: string; revision: number; text: string; model: string }
export interface AssistantAPI {
  read(): Promise<AssistantSnapshot>;
  createChat(id: string): Promise<string>;
  send(input: AssistantInput): Promise<string>;
  cancel(chatId: string): Promise<void>;
  markRead(id: string): Promise<void>;
  feedback(input: { id: string; text: string; email: string; images: string[] }): Promise<void>;
  chooseImage(): Promise<string | null>;
  importImage(bytes: Uint8Array): Promise<string>;
  exportFeedback(id: string): Promise<boolean>;
  onChanged(listener: () => void): () => void;
}
