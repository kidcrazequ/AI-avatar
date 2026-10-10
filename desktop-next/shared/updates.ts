export interface UpdatePolicy { url: string; channel: 'latest' | 'candidate'; production: boolean }
export interface UpdateSnapshot {
  state: 'unconfigured' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'cancelled' | 'error';
  version: string; nextVersion: string; percent: number; transferred: number; total: number;
  checkedAt: string; error: string; automatic: boolean; channel: string; configured: boolean;
  installBlocked: string; backup: string;
}
export interface UpdateAPI {
  read(): Promise<UpdateSnapshot>; check(): Promise<void>; download(): Promise<void>;
  cancel(): Promise<void>; install(): Promise<void>; automatic(value: boolean): Promise<void>;
  onChanged(listener: () => void): () => void;
}
