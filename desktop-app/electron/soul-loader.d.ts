export interface AvatarConfig {
    id: string;
    name: string;
    systemPrompt: string;
}
export declare class SoulLoader {
    private avatarsPath;
    constructor(avatarsPath: string);
    loadAvatar(avatarId: string): AvatarConfig;
    private readFile;
    private readDirectory;
    private extractAvatarName;
}
