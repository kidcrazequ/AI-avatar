import type { RoleInput } from '../shared/contracts';
import type { ExpertLibrary } from './expert-library';
import type { ResourceStore } from './resources';
import { required } from './task-repository';
import { validateRole } from './role-definition';
import type { LearningSource } from '../shared/recording';
import { memoryGroups } from './resources';

export class PersonalAvatar {
  constructor(private library: ExpertLibrary, private resources: ResourceStore) {}
  validate(input: RoleInput | undefined, memory: string) {
    if (!input || input.reviewed !== true || input.skills?.length || input.connectors?.length || input.avatar) throw new Error('请复核人格；个人学习不自动新增技能、连接器或头像');
    required(memory, '个人记忆', 10000, true);
    return validateRole(input, this.library.resourceLocation(this.library.list().templates[0].id).root);
  }
  publish(operation: string, role: RoleInput, memory: string, sources: LearningSource[]): string {
    const config = this.validate(role, memory);
    memory = required(memory, '个人记忆', 10000, true);
    const hasGroup = memory.split(/\r?\n/).some(line => memoryGroups.some(group => line.trim() === '## ' + group));
    const memoryFile = memory && !hasGroup ? `# 个人分身记忆\n\n## 长期反馈\n\n${memory}\n` : memory;
    const id = this.library.createPersonal(config, operation);
    const collection = 'expert:' + id, fileName = '个人学习来源.md';
    const provenance = `# 个人学习来源\n\n学习记录：${operation}。以下内容经本人复核，仅供个人工作分身使用；不代表对外消息代发授权。\n\n## 已复核工作信息\n\n${memory || '没有确认的额外工作记忆。'}\n\n## 授权资料指纹\n\n${sources.map(item => `- ${item.name} · ${item.type} · SHA256 ${item.hash}`).join('\n')}\n`;
    if (this.resources.documents(collection, id).some(item => item.id === fileName)) { if (this.resources.readDocument(collection, fileName, id).content !== provenance) throw new Error('个人来源已有用户修改，未覆盖'); }
    else this.resources.saveDocument({ collectionId: collection, id: '', name: fileName, content: provenance, revision: '' }, id);
    const file = this.resources.read(id).memory!;
    if (file.content !== memoryFile) { if (file.content.trim()) throw new Error('个人记忆已有用户修改，保护当前文件'); this.resources.saveMemory(id, memoryFile, file.revision, ''); }
    return id;
  }
}
