import fs from 'fs';
import path from 'path';
export class SoulLoader {
    avatarsPath;
    constructor(avatarsPath) {
        this.avatarsPath = avatarsPath;
    }
    loadAvatar(avatarId) {
        const avatarPath = path.join(this.avatarsPath, avatarId);
        // 读取 CLAUDE.md
        const claudeMd = this.readFile(path.join(avatarPath, 'CLAUDE.md'));
        // 读取 soul.md
        const soulMd = this.readFile(path.join(avatarPath, 'soul.md'));
        // 读取 knowledge/ 目录下的所有文件
        const knowledgePath = path.join(avatarPath, 'knowledge');
        const knowledgeFiles = this.readDirectory(knowledgePath);
        // 读取 skills/ 目录下的所有文件
        const skillsPath = path.join(avatarPath, 'skills');
        const skillsFiles = this.readDirectory(skillsPath);
        // 组合成完整的 System Prompt
        const systemPrompt = [
            claudeMd,
            '\n\n---\n\n',
            soulMd,
            '\n\n---\n\n# 知识库\n\n',
            ...knowledgeFiles.map(f => f.content),
            '\n\n---\n\n# 技能定义\n\n',
            ...skillsFiles.map(f => f.content),
        ].join('');
        return {
            id: avatarId,
            name: this.extractAvatarName(claudeMd),
            systemPrompt,
        };
    }
    readFile(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf-8');
        }
        catch (error) {
            console.error(`读取文件失败: ${filePath}`, error);
            return '';
        }
    }
    readDirectory(dirPath) {
        const files = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    // 递归读取子目录
                    files.push(...this.readDirectory(fullPath));
                }
                else if (entry.isFile() && entry.name.endsWith('.md')) {
                    files.push({
                        path: fullPath,
                        content: this.readFile(fullPath),
                    });
                }
            }
        }
        catch (error) {
            console.error(`读取目录失败: ${dirPath}`, error);
        }
        return files;
    }
    extractAvatarName(claudeMd) {
        const match = claudeMd.match(/^#\s+(.+)$/m);
        return match ? match[1] : '未命名分身';
    }
}
