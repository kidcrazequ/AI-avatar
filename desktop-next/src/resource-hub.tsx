import type { ReactNode } from 'react';
import { Icon } from './primitives';
import './resource-hub.css';

const entries = [
  ['plugins', '插件', '探索与扩展专家能力', 'sparkles'],
  ['skills', 'Skills', '探索与安装 Skill', 'skill'],
  ['connectors', '连接器', '连接外部工具与服务', 'connector'],
  ['knowledge', '知识库', '沉淀与共享知识', 'book'],
  ['flows', 'SoulFlow', '编排可复用工作流', 'flow'],
  ['projects', '公开项目', '管理专家共享项目', 'folder'],
];
export function ResourceHub({ page, children }: { page: string; children: ReactNode }) {
  return <main className="resource-hub" data-ued-node="resource.hub"><header className="resource-hub-heading"><h1>能力与资源</h1><p>释放你的专家潜能，解锁更多可能</p></header><nav className="resource-hub-tabs" role="tablist" aria-label="能力与资源页签" onKeyDown={event => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']; if (!keys.includes(event.key)) return;
    event.preventDefault(); const index = entries.findIndex(entry => entry[0] === page);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length;
    const key = entries[next][0]; document.getElementById(`resource-tab-${key}`)?.focus(); location.hash = `resources/${key}`;
  }}>{entries.map(([key, title, description, icon]) => <a key={key} id={`resource-tab-${key}`} role="tab" tabIndex={page === key ? 0 : -1} aria-selected={page === key} className={page === key ? 'active' : ''} href={`#resources/${key}`}><span className="hub-tab-title"><Icon name={icon} small />{title}</span><span className="hub-tab-description">{description}</span><span className="hub-tab-arrow"><Icon name="arrowup" small /></span></a>)}</nav><div className="resource-hub-content" role="tabpanel" aria-labelledby={`resource-tab-${page}`}>{children}</div></main>;
}
