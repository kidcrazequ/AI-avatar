/**
 * @file ImportAvatarPackPanel.tsx — 导入/安装外部分身包（.soulpack.zip 无损 / .soulpack.json）
 *
 * 后端链路：soulPackPreview（弹原生文件框 → 摘要 + targetExists + 一次性 token）→
 * soulPackImportFromFile（核验 token/指纹 → 落地到 avatars/）。
 *
 * 同名分身已存在时提供两种模式：
 *   - 覆盖更新（mode='update'，默认）：更新人设/技能/知识库，保留本机记忆、配置与本地数据
 *   - 完全重置（force=true）：清空整个分身目录后按包重写
 *
 * token 一次性消费且 5 分钟过期，导入失败也会消费 token，因此任何一次导入尝试后
 * 都需重新选择文件——失败时回到选择页并保留用户已设的选项（模式/恢复记忆/改名）。
 */
import { useState } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  onClose: () => void
  /** 导入成功后回调（刷新分身列表等） */
  onImported: (avatarId: string) => Promise<void> | void
  /** 进入某个分身 */
  onOpenAvatar: (avatarId: string) => Promise<void> | void
  showToast?: (message: string, type?: 'success' | 'error') => void
}

type Preview = Extract<Awaited<ReturnType<typeof window.electronAPI.soulPackPreview>>, { ok: true }>
type ImportResult = Awaited<ReturnType<typeof window.electronAPI.soulPackImportFromFile>>

export default function ImportAvatarPackPanel({ onClose, onImported, onOpenAvatar, showToast }: Props) {
  const [phase, setPhase] = useState<'idle' | 'preview' | 'importing' | 'done'>('idle')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 选项跨"重新选择"保留
  const [restoreMemory, setRestoreMemory] = useState(true)
  const [force, setForce] = useState(false)
  const [mode, setMode] = useState<'replace' | 'update'>('update')
  const [targetAvatarId, setTargetAvatarId] = useState('')

  // 同名分身已存在且未改名 → 走「覆盖更新 / 完全重置」二选一
  const updating = !!preview?.targetExists && !targetAvatarId.trim()

  const handlePickFile = async () => {
    setError(null)
    try {
      const res = await window.electronAPI.soulPackPreview()
      if (!res.ok) {
        if (!res.canceled) showToast?.(`读取分身包失败：${res.error ?? '未知错误'}`, 'error')
        return // 取消：留在当前页
      }
      setPreview(res)
      if (res.targetExists) {
        setMode('update') // 已装同名分身：默认覆盖更新，保留本机记忆
        setRestoreMemory(false)
      } else {
        setMode('replace')
        setRestoreMemory(res.memoryIncluded) // 全新导入：含记忆时默认恢复
      }
      setPhase('preview')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      showToast?.(`读取分身包失败：${msg}`, 'error')
    }
  }

  const handleImport = async () => {
    if (!preview) return
    setPhase('importing')
    setError(null)
    try {
      const customId = targetAvatarId.trim()
      const res = await window.electronAPI.soulPackImportFromFile(preview.token, {
        restoreMemory,
        targetAvatarId: customId || undefined,
        // 更新场景：update 模式不传 force；选完全重置时 radio 即确认，直接 force
        ...(updating
          ? (mode === 'update' ? { mode: 'update' as const } : { force: true })
          : { force }),
      })
      setResult(res)
      setPhase('done')
      await onImported(res.avatarId)
      showToast?.(res.mode === 'update' ? `已更新分身「${res.avatarId}」` : `已导入分身「${res.avatarId}」`, 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // token 已被消费，必须重新选择文件；保留选项让用户调整后再来一次
      setError(msg)
      setPreview(null)
      setPhase('idle')
      showToast?.(`导入失败：${msg}`, 'error')
    }
  }

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <PanelHeader
        title="导入分身包"
        subtitle="安装别人做好的分身（.soulpack.zip / .soulpack.json）到本机"
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto p-6 bg-px-bg">
        {/* ── 选择文件页 ── */}
        {phase === 'idle' && (
          <div className="max-w-xl mx-auto text-center">
            <div className="border-2 border-dashed border-px-border bg-px-surface/70 px-8 py-12">
              <div className="font-game text-[14px] text-px-text">选择一个分身包文件</div>
              <p className="font-game text-[12px] text-px-text-dim mt-3 leading-relaxed">
                分身包是 <span className="text-px-primary">.soulpack.zip</span>（自包含·含 Excel/PDF/图片等附件，无损）
                或 <span className="text-px-primary">.soulpack.json</span>（仅文本）文件，包含对方分身的人设、技能、
                知识与（可选）记忆。导入后会成为你本机的一个新分身。
              </p>
              {error && (
                <p className="font-game text-[11px] text-px-danger mt-4 leading-relaxed break-words">{error}</p>
              )}
              <button type="button" onClick={handlePickFile} className="pixel-btn-primary px-5 py-3 mt-6">
                选择分身包文件（.zip / .json）
              </button>
            </div>
          </div>
        )}

        {/* ── 预览 + 选项页 ── */}
        {phase === 'preview' && preview && (
          <div className="max-w-2xl mx-auto">
            <div className="border-2 border-px-border bg-px-surface/95 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-game text-[16px] text-px-text font-bold leading-snug">
                    {preview.display_name || preview.name}
                  </div>
                  <div className="font-game text-[10px] text-px-primary mt-2 tracking-wider">
                    {preview.domain ? `${preview.domain} · ` : ''}v{preview.pack_version}
                    {preview.created_by ? ` · by ${preview.created_by}` : ''}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`font-game text-[10px] px-2 py-1 whitespace-nowrap border ${preview.isZip ? 'text-px-primary border-px-primary/60' : 'text-px-text-dim border-px-border-dim'}`}>
                    {preview.isZip ? '自包含 zip · 含附件' : '单 JSON · 仅文本'}
                  </span>
                  <span className="font-game text-[10px] text-px-text-dim border border-px-border-dim px-2 py-1 whitespace-nowrap">
                    schema v{preview.schema_version}
                  </span>
                </div>
              </div>
              {preview.description && (
                <p className="font-game text-[12px] text-px-text-sec mt-4 leading-relaxed">{preview.description}</p>
              )}

              <div className="mt-5 pt-4 border-t border-px-border-dim/70 grid grid-cols-2 gap-x-6 gap-y-2 font-game text-[11px]">
                <div className="text-px-text-dim">文件数<span className="text-px-text ml-2">{preview.filesCount}</span></div>
                <div className="text-px-text-dim">二进制资源<span className="text-px-text ml-2">
                  {preview.isZip ? `${preview.blobsPresent}/${preview.binaryRefsCount}（含附件）` : `${preview.binaryRefsCount}（仅引用）`}
                </span></div>
                <div className="text-px-text-dim">含记忆<span className="text-px-text ml-2">{preview.memoryIncluded ? '是' : '否'}</span></div>
                <div className="text-px-text-dim">
                  外部技能依赖
                  <span className="text-px-text ml-2">
                    共享 {preview.externalSkillsShared} · 社区 {preview.externalSkillsCommunity}
                  </span>
                </div>
              </div>
              {preview.isZip && preview.blobsPresent < preview.binaryRefsCount && (
                <div className="mt-3 font-game text-[11px] text-px-warning leading-relaxed">
                  ⚠ zip 包内仅含 {preview.blobsPresent}/{preview.binaryRefsCount} 个二进制附件，缺失的资源导入后需手动补齐。
                </div>
              )}
            </div>

            {/* 选项 */}
            <div className="mt-5 border-2 border-px-border bg-px-surface/70 p-5 space-y-4">
              {updating ? (
                <div className="space-y-3">
                  <div className="font-game text-[12px] text-px-warning">
                    本机已存在分身「{preview.name}」
                    {preview.installedPackVersion ? `（已装包 v${preview.installedPackVersion} → 新包 v${preview.pack_version}）` : ''}
                  </div>
                  <label className="flex items-start gap-3 font-game text-[12px] text-px-text cursor-pointer">
                    <input type="radio" name="import-mode" className="mt-0.5" checked={mode === 'update'}
                      onChange={() => { setMode('update'); setRestoreMemory(false) }} />
                    <span>
                      覆盖更新（推荐）
                      <span className="block text-[11px] text-px-text-dim mt-1 leading-relaxed">
                        更新人设 / 技能 / 知识库；保留本机记忆、模型配置、原始资料（_raw）与你本地新增的文件
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 font-game text-[12px] text-px-text cursor-pointer">
                    <input type="radio" name="import-mode" className="mt-0.5" checked={mode === 'replace'}
                      onChange={() => { setMode('replace'); setRestoreMemory(preview.memoryIncluded) }} />
                    <span>
                      完全重置
                      <span className="block text-[11px] text-px-danger/90 mt-1 leading-relaxed">
                        清空整个分身目录后按包重写：本机记忆与导入后新增的数据会被删除
                        {preview.isZip ? '（二进制附件会从 zip 包无损恢复）' : '，原始二进制资料无法从包恢复'}
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <label className="flex items-center gap-3 font-game text-[12px] text-px-text cursor-pointer">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  若同名分身已存在则覆盖
                </label>
              )}
              {preview.memoryIncluded && (
                <label className="flex items-center gap-3 font-game text-[12px] text-px-text cursor-pointer">
                  <input type="checkbox" checked={restoreMemory} onChange={(e) => setRestoreMemory(e.target.checked)} />
                  {updating && mode === 'update' ? '用包内记忆覆盖本机记忆' : '恢复对方分身的记忆'}
                </label>
              )}
              <div className="font-game text-[12px] text-px-text">
                <div className="text-px-text-dim mb-2">自定义分身 ID（可选，留空用包内默认）</div>
                <input
                  type="text"
                  value={targetAvatarId}
                  onChange={(e) => setTargetAvatarId(e.target.value)}
                  placeholder="例如 my-finance-expert"
                  className="w-full bg-px-bg border-2 border-px-border px-3 py-2 text-[12px] text-px-text font-game outline-none focus:border-px-primary"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-between">
              <button type="button" onClick={() => { setPhase('idle'); setPreview(null) }} className="pixel-btn-outline-muted px-4 py-2 text-[11px]">
                重新选择
              </button>
              <button type="button" onClick={handleImport} className="pixel-btn-primary px-5 py-2 text-[11px]">
                {updating ? (mode === 'update' ? '覆盖更新' : '完全重置导入') : '确认导入'}
              </button>
            </div>
          </div>
        )}

        {phase === 'importing' && (
          <div className="font-game text-[13px] text-px-text-dim text-center py-16">正在导入分身包...</div>
        )}

        {/* ── 完成页 ── */}
        {phase === 'done' && result && (
          <div className="max-w-2xl mx-auto">
            <div className="border-2 border-px-primary/60 bg-px-surface/95 p-5">
              <div className="font-game text-[15px] text-px-text font-bold">{result.mode === 'update' ? '更新成功' : '导入成功'}</div>
              <div className="font-game text-[12px] text-px-text-sec mt-2">
                {result.mode === 'update' ? '已更新分身' : '新分身'}：<span className="text-px-primary">{result.avatarId}</span> · 写入 {result.filesWritten.length} 个文件
                {result.filesRemoved.length > 0 ? ` · 清理 ${result.filesRemoved.length} 个旧包文件` : ''}
                {result.memoryRestored
                  ? ' · 已恢复包内记忆'
                  : result.mode === 'update' ? ' · 本机记忆与本地数据已保留' : ''}
              </div>

              {result.warnings.length > 0 && (
                <div className="mt-4 pt-3 border-t border-px-border-dim/70">
                  <div className="font-game text-[10px] text-px-text-dim tracking-wider mb-2">提示</div>
                  <ul className="font-game text-[11px] text-px-text-dim leading-relaxed list-disc pl-5 space-y-1">
                    {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {result.binaryRefsWritten.length > 0 && (
                <div className="mt-4 pt-3 border-t border-px-border-dim/70">
                  <div className="font-game text-[10px] text-px-primary tracking-wider">
                    已从 zip 包校验并无损还原 {result.binaryRefsWritten.length} 个二进制资源（Excel/PDF/图片等）
                  </div>
                </div>
              )}

              {result.binaryRefsMissing.length > 0 && (
                <div className="mt-4 pt-3 border-t border-px-border-dim/70">
                  <div className="font-game text-[10px] text-px-warning tracking-wider mb-2">
                    缺失 {result.binaryRefsMissing.length} 个二进制资源（包内未含，相关文件可能不完整）
                  </div>
                  <ul className="font-game text-[11px] text-px-text-dim leading-relaxed list-disc pl-5 space-y-1 max-h-32 overflow-y-auto">
                    {result.binaryRefsMissing.slice(0, 20).map((b, i) => <li key={i} className="break-all">{b.path}</li>)}
                  </ul>
                </div>
              )}

              {(result.externalSkillsRequired.shared.length > 0 || result.externalSkillsRequired.community.length > 0) && (
                <div className="mt-4 pt-3 border-t border-px-border-dim/70">
                  <div className="font-game text-[10px] text-px-warning tracking-wider mb-2">需要的外部技能（请在「技能」里另行安装）</div>
                  <ul className="font-game text-[11px] text-px-text-dim leading-relaxed list-disc pl-5 space-y-1">
                    {result.externalSkillsRequired.shared.map((s) => <li key={`s-${s}`}>共享：{s}</li>)}
                    {result.externalSkillsRequired.community.map((c) => (
                      <li key={`c-${c.name}`}>社区：{c.name}（{c.repo}@{c.ref}）</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={onClose} className="pixel-btn-outline-muted px-4 py-2 text-[11px]">完成</button>
              <button
                type="button"
                onClick={async () => { await onOpenAvatar(result.avatarId); onClose() }}
                className="pixel-btn-primary px-5 py-2 text-[11px]"
              >
                进入分身
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
