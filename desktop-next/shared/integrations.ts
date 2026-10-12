import type { ModelEntry, RuntimeStatus } from './contracts';
export type Policy = 'allow' | 'ask' | 'deny';
export interface PermissionConfig { tools: boolean; files: boolean; builtin: boolean; model: boolean; paths: string[]; policies: Record<string, Policy>; models: string[] }
export interface ConnectorConfig { id: string; expertId: string; catalog: string; name: string; transport: 'http' | 'sse' | 'stdio' | 'github'; url: string; command: string; args: string[]; mode: 'ask' | 'read' | 'off' }
export interface ConnectorInput extends ConnectorConfig { secret: string }
export interface ConnectorView extends ConnectorConfig { state: 'idle' | 'connecting' | 'connected' | 'error'; error: string; tools: Array<{ name: string; description: string; readonly: boolean }> }
export type IMProvider = 'feishu' | 'dingtalk' | 'wecom' | 'qq';
export interface ChannelInput { id: string; name: string; appId: string; secret: string; enabled: boolean; provider?: IMProvider }
export interface ChannelView extends Omit<ChannelInput, 'secret'> { state: string; error: string }
export interface IMParticipant { expertId: string; directory: string; model: string }
export interface IMAccessRule { channelId: string; enabled: boolean; mode: 'pairing' | 'open'; participants: IMParticipant[]; confirmers: string[]; allowModelOverride: boolean; instructions: string }
export interface IMSession { id: string; channelId: string; chatId: string; senderId: string; name: string; type: 'group' | 'direct'; expertId: string; groupId: string; directory: string; model: string; enabled: boolean; participants?: IMParticipant[]; allowModelOverride?: boolean; instructions?: string }
export interface IMEvent { id: string; channelId: string; chatId: string; senderId: string; messageId: string; type: 'group' | 'direct'; text: string; state: 'pairing' | 'rejected' | 'received' | 'running' | 'ready' | 'sent' | 'unknown' | 'failed'; taskId: string; taskIds?: string[]; response: string; receipt: string; error: string; at: string; pairingCode?: string; expires?: string; codeState?: 'unsent' | 'sent' | 'unknown' }
export interface IntegrationSnapshot { connectors: ConnectorView[]; channels: ChannelView[]; sessions: IMSession[]; events: IMEvent[]; permissions: PermissionConfig; imRules?: IMAccessRule[] }
export interface IntegrationAPI {
  read(scope: string): Promise<IntegrationSnapshot>;
  saveConnector(input: ConnectorInput): Promise<void>;
  connect(id: string): Promise<void>;
  removeConnector(id: string): Promise<void>;
  savePermissions(scope: string, config: PermissionConfig): Promise<void>;
  saveChannel(input: ChannelInput): Promise<void>;
  removeChannel(id: string): Promise<void>;
  saveIMRule(input: IMAccessRule): Promise<void>;
  sendPairingCode(id: string): Promise<void>;
  saveSession(input: IMSession): Promise<void>;
  removeSession(id: string): Promise<void>;
  pair(id: string, session: IMSession | null): Promise<void>;
  sendReply(id: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
export interface AppPreferences { theme: 'light' | 'dark' | 'system'; reply: '中文' | 'English' | '跟随任务'; startup: boolean; awake: boolean; directory: string; deviceName?: string }
export interface SettingsSnapshot { preferences: AppPreferences; host: string; installedExperts: number; platform: string; arch: string; version: string; profile: string; models: ModelEntry[]; awakeActive: boolean; startupActual: boolean; status: RuntimeStatus }
export interface SettingsAPI { read(): Promise<SettingsSnapshot>; save(input: AppPreferences): Promise<void>; diagnose(): Promise<Array<{ name: string; ok: boolean; detail: string }>>; openLogs(): Promise<void> }
