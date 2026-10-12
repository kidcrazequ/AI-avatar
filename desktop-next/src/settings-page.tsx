import { useCallback, useEffect, useState } from 'react';
import type { AppPreferences, SettingsSnapshot } from '../shared/integrations';
import { Icon, Modal } from './primitives';
import { Switch } from './integration-ui';
import { ModelDialog } from './task-dialogs';
import { UpdatesPanel } from './updates-panel';
import './integrations.css';
const pages = [['settings','偏好设置','preferences'],['project','系统设置','system'],['connector','网络诊断','network'],['folder','管理环境与设备','environments'],['download','更新应用','updates']];
export function applyTheme(theme: AppPreferences['theme']) { const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }
function Row({ title, description, control }: { title: string; description: string; control?: React.ReactNode }) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div>{control}</div>; }
export function SettingsPage({ page, notice }: { page: string; notice(text: string): void }) {
  const [data, setData] = useState<SettingsSnapshot>(), [error, setError] = useState('');
  const [model, setModel] = useState(false), [busy, setBusy] = useState(false), [rename, setRename] = useState(false), [deviceName, setDeviceName] = useState('');
  const [diagnostics, setDiagnostics] = useState<Array<{ name: string; ok: boolean; detail: string }>>();
  const refresh = useCallback(() => { window.soulDesktop.settings.read().then(value => { setData(value); setError(''); }).catch(c => setError(String(c))); }, []);
  useEffect(refresh, [refresh, page]);
  const save = async (input: AppPreferences) => {
    setBusy(true); setError('');
    try { await window.soulDesktop.settings.save(input); applyTheme(input.theme); refresh(); notice('设置已生效'); return true; }
    catch (c) { setError(String(c)); return false; }
    finally { setBusy(false); }
  };
  const pref = data?.preferences, active = pages.some(p => p[2] === page) ? page : 'preferences';
  const title = active === 'environments' ? '环境与设备' : pages.find(p => p[2] === active)![1];
  const description = ({ preferences: '语言、回复语言和主题等全局生效的个人偏好', system: '控制 Soul 在本机运行时的系统级行为', network: '检查本机资源、持久存储和模型服务连接', environments: '管理本地设备：连接状态、应用版本，以及各环境上安装的专家。', updates: '查看当前版本、检查新版本，并在已下载更新后重启应用' } as Record<string, string>)[active];
  return <>
    <aside className="expert-sidebar app-settings-sidebar" aria-label="通用">
      <button className="back" onClick={() => { location.hash = 'expert-management'; }}><Icon name="back" small />返回</button>
      <nav>{pages.map(([icon, label, key]) => <button key={key} aria-current={active === key ? 'page' : undefined} className={`side-tab ${active === key ? 'active' : ''}`} onClick={() => { location.hash = `app-settings/${key}`; }}><Icon name={icon} small />{label}</button>)}</nav>
    </aside>
    <main className="resource-main app-settings-main" data-ued-node={`settings.${active}`} data-settings-ready={Boolean(data)}>
      <div className="resource-page app-settings-header">
        <header className="resource-header"><div><h1>{title}</h1><p>{description}</p></div>
          {active === 'environments' && <div className="settings-device-actions"><button className="btn" onClick={refresh}><Icon name="history" small />刷新</button><button className="btn" disabled title="远程设备服务未接入"><Icon name="plus" small />添加本地设备</button><button className="btn primary" disabled title="Soul 未接入云电脑购买服务">购买云电脑</button></div>}
        </header>
        {!data && !error && <p role="status">正在读取设置…</p>}
        {pref && (active === 'preferences' ? <>
          <section className="settings-card">
            <Row title="界面语言" description="当前中文版本；英文界面尚未提供" control={<button className="btn" disabled>中文<Icon name="collapse" small /></button>} />
            <Row title="AI 回复语言" description="设置新任务中 AI 默认使用的回复语言" control={<div className="settings-select"><select aria-label="AI 回复语言" disabled={busy} value={pref.reply} onChange={e => save({ ...pref, reply: e.target.value as AppPreferences['reply'] })}>{['中文', 'English', '跟随任务'].map(s => <option key={s}>{s}</option>)}</select><Icon name="collapse" small /></div>} />
          </section>
          <section className="settings-card"><Row title="主题亮暗" description="选择浅色、深色，或跟随系统外观" control={<div className="settings-select"><select aria-label="主题亮暗" disabled={busy} value={pref.theme} onChange={e => save({ ...pref, theme: e.target.value as AppPreferences['theme'] })}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select><Icon name="collapse" small /></div>} /></section>
        </> : active === 'system' ? <>
          <section className="settings-card">
            <Row title="开机自动启动" description={`系统登录时启动 Soul；系统当前${data.startupActual ? '已启用' : '未启用'}`} control={<Switch label="开机自动启动" checked={data.startupActual} disabled={busy} onChange={() => save({ ...pref, startup: !data.startupActual })} />} />
            <Row title="保持系统唤醒" description={`任务运行期间防止自动睡眠；当前${data.awakeActive ? '正在保持唤醒' : '未占用唤醒锁'}`} control={<Switch label="保持系统唤醒" checked={pref.awake} disabled={busy} onChange={() => save({ ...pref, awake: !pref.awake })} />} />
            <Row title="允许远端配置管理" description="当前为本机管理；远端配置服务尚未接入" control={<Switch label="允许远端配置管理" checked={false} disabled onChange={() => {}} />} />
          </section>
          <details className="settings-local-config"><summary>本机工作配置</summary><section className="settings-card">
            <Row title="模型设置" description={`${data.models.length} 个已保存模型；密钥通过系统加密保存`} control={<button className="btn" onClick={() => setModel(true)}>配置模型</button>} />
            <Row title="默认工作目录" description={pref.directory || '未指定'} control={<div className="settings-device-actions"><button className="btn" disabled={busy} onClick={async () => { try { const directory = await window.soulDesktop.chooseDirectory(); if (directory) await save({ ...pref, directory }); } catch (c) { notice(String(c)); } }}>选择目录</button>{pref.directory && <button className="btn" disabled={busy} onClick={() => save({ ...pref, directory: '' })}>清除</button>}</div>} />
          </section></details>
        </> : active === 'network' ? <>
          <section className="settings-card"><Row title="网络诊断" description="运行一次本机诊断，检查资源、凭据加密、数据库与模型服务可达性" control={<button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setDiagnostics(await window.soulDesktop.settings.diagnose()); } catch (c) { setError(String(c)); } finally { setBusy(false); } }}>{busy ? '诊断中…' : '开始诊断'}</button>} /></section>
          {diagnostics && <><table className="resource-table diagnostics"><thead><tr><th>检查项</th><th>结果</th><th>详情</th></tr></thead><tbody>{diagnostics.map(d => <tr key={d.name}><td>{d.name}</td><td>{d.ok ? '通过' : '待检查'}</td><td>{d.detail}</td></tr>)}</tbody></table><button className="btn settings-log-action" onClick={() => window.soulDesktop.settings.openLogs().catch(c => notice(String(c)))}>打开诊断日志</button></>}
        </> : active === 'environments' ? <>
          <section className="settings-cloud-state" aria-label="云电脑"><Icon name="project" /><span>云电脑服务尚未接入</span></section>
          <article className="settings-device-card">
            <div className="settings-device-icon"><Icon name="project" /></div>
            <div className="settings-device-main"><div className="settings-device-name"><span className="settings-local-tag">本地</span><strong title={data.host}>{pref.deviceName || data.host.replace(/\.local$/, '')}</strong><button className="icon-button" aria-label="重命名设备" onClick={() => { setDeviceName(pref.deviceName || data.host.replace(/\.local$/, '')); setRename(true); }}><Icon name="edit" small /></button><span className="settings-current-device">当前设备</span></div><div className="settings-device-meta"><span><Icon name="user" small />{data.installedExperts} 个专家</span><span>应用版本 {data.version}</span></div></div>
            <span className="settings-device-online">本机已连接</span>
          </article>
          <details className="settings-device-details"><summary>本机资源与数据位置</summary><section className="settings-card"><Row title="用户数据目录" description={data.profile} /><Row title="打包资源" description={`${data.status.experts.length} 个专家包 · ${data.status.resources.files} 份资源 · ${data.platform}/${data.arch}`} /></section></details>
        </> : <UpdatesPanel />)}
        {error && <p className="resource-error" role="alert">{error}</p>}
      </div>
    </main>
    {model && data && <ModelDialog models={data.models} onClose={() => setModel(false)} saved={refresh} notice={notice} />}
    {rename && pref && <Modal title="重命名设备" className="compact-dialog" onClose={() => setRename(false)} footer={<><button className="btn" onClick={() => setRename(false)}>取消</button><button className="btn primary" disabled={busy || !deviceName.trim()} onClick={async () => { if (await save({ ...pref, deviceName })) setRename(false); }}>保存</button></>}><div className="dialog-body"><h2>重命名设备</h2><p className="resource-note">用于 Soul 中显示，保存后不改变操作系统主机名。</p><label className="field">设备显示名称<input aria-label="设备显示名称" maxLength={80} value={deviceName} onChange={e => setDeviceName(e.target.value)} /></label>{error && <p className="resource-error" role="alert">{error}</p>}</div></Modal>}
  </>;
}

export function UsagePopover({ onClose }: { onClose(): void }) {
  const [usage,setUsage]=useState({ input:0,output:0,rounds:0,unknown:0 }), [error,setError]=useState('');
  const refresh=useCallback(()=>window.soulDesktop.tasks.read().then(s=>{const rounds=s.tasks.flatMap(t=>t.rounds);setUsage({input:rounds.reduce((sum,r)=>sum+(r.usage?.inputTokens??0),0),output:rounds.reduce((sum,r)=>sum+(r.usage?.outputTokens??0),0),rounds:rounds.length,unknown:rounds.filter(r=>!r.usage).length});setError('');}).catch(()=>setError('用量读取失败，请刷新')),[]);
  useEffect(()=>{refresh();const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};const outside=(e:PointerEvent)=>{if(!(e.target as Element).closest('.usage-popover')&&!(e.target as Element).closest('[aria-label="用量"]'))onClose();};document.addEventListener('keydown',key);document.addEventListener('pointerdown',outside);const unsubscribe=window.soulDesktop.tasks.onChanged(refresh);return()=>{unsubscribe();document.removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside);};},[refresh,onClose]);
  return <div className="usage-popover" role="dialog" aria-label="Soul 用量"><header><h2>Soul 用量</h2><button className="icon-button" aria-label="刷新用量" onClick={refresh}><Icon name="history" small /></button></header><div className="usage-body"><div className="flex">Token 用量 <span className="tiny">本机任务记录</span></div><div className="usage-bar" /><div className="flex"><span>输入 {usage.input.toLocaleString()} / 输出 {usage.output.toLocaleString()}</span></div></div><footer>{error && <span role="alert">{error} · </span>}{usage.rounds} 个调用轮次；{usage.unknown} 轮用量未知。不代表账户额度或费用。</footer></div>;
}
