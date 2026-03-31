export interface AvatarConfig {
    id: string;
    name: string;
    systemPrompt: string;
}
export interface ElectronAPI {
    ping: () => Promise<string>;
    loadAvatar: (avatarId: string) => Promise<AvatarConfig>;
}
declare global {
    interface Window {
        electronAPI: ElectronAPI;
    }
}
