import { useCallback, useEffect, useState } from 'react';
import type { IntegrationSnapshot } from '../shared/integrations';
import { Modal } from './primitives';
export const statusName = (state: string) => ({ idle: '未连接', connecting: '连接中', reconnecting: '重连中', connected: '已连接', error: '连接失败', failed: '失败', pairing: '待配对', received: '已接收', running: '执行中', ready: '待发送审批', sent: '已发送', unknown: '结果未知', rejected: '已拒绝' }[state] ?? state);
export function useIntegrations(scope: string) {
  const [data, setData] = useState<IntegrationSnapshot>(), [error, setError] = useState('');
  const refresh = useCallback(() => { window.soulDesktop.integrations.read(scope).then(setData).catch(cause => setError(String(cause))); }, [scope]);
  useEffect(() => { refresh(); return window.soulDesktop.integrations.onChanged(refresh); }, [refresh]);
  return { data, error, refresh };
}
export function Switch({ label, checked, disabled = false, small = false, onChange }: { label: string; checked: boolean; disabled?: boolean; small?: boolean; onChange(): void }) { return <button className={`switch${small ? ' small' : ''}`} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onChange} />; }
export function ConfirmRemove({ title, onClose, remove }: { title: string; onClose(): void; remove(): Promise<unknown> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <Modal title={title} className="compact-dialog" onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await remove(); onClose(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }}>移除</button></>}><div className="dialog-body"><h2>{title}</h2><p className="resource-note">已有任务保留历史记录。移除后该配置无法用于新的任务。</p>{error && <p role="alert">{error}</p>}</div></Modal>;
}
