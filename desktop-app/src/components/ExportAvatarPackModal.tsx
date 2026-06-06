/**
 * @file ExportAvatarPackModal.tsx — 把当前分身导出为可分享的分身包（.soulpack.json）
 *
 * 复用已就绪的后端 soulPackExportToFile（主进程弹原生保存框 → 写 .soulpack.json）。
 * 别人拿到该文件用「导入分身包」即可安装。后端零改动。
 *
 * 默认偏隐私保守：不含记忆 / 不含人生数据（这些是个人私有），含 wiki（属专业能力）。
 */
import { useState } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  avatarName: string
  onClose: () => void
  showToast?: (message: string, type?: 'success' | 'error') => void
}

type ExportOk = Extract<Awaited<ReturnType<typeof window.electronAPI.soulPackExportToFile>>, { ok: true }>

export default function ExportAvatarPackModal({ avatarId, avatarName, onClose, showToast }: Props) {
  const [includeMemory, setIncludeMemory] = useState(false)
  const [includeLife, setIncludeLife] = useState(false)
  const [includeWiki, setIncludeWiki] = useState(true)
  const [displayName, setDisplayName] = useState(avatarName)
  const [description, setDescription] = useState('')
  const [createdBy, setCreatedBy] = useState('')
  const [phase, setPhase] = useState<'config' | 'exporting' | 'done'>('config')
  const [result, setResult] = useState<ExportOk | null>(null)

  const handleExport = async () => {
    setPhase('exporting')
    try {
      const res = await window.electronAPI.soulPackExportToFile(avatarId, {
        includeMemory,
        includeLife,
        includeWiki,
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        createdBy: createdBy.trim() || undefined,
      })
      if (!res.ok) {
        if (!res.canceled) showToast?.(`导出失败：${res.error ?? '未知错误'}`, 'error')
        setPhase('config') // 取消/失败：回到配置页
        return
      }
      setResult(res)
      setPhase('done')
      showToast?.('分身包已导出', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast?.(`导出失败：${msg}`, 'error')
      setPhase('config')
    }
  }

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <PanelHeader
        title="导出分身包"
        subtitle={`把「${avatarName}」打包成 .soulpack.json，分享给别人`}
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto p-6 bg-px-bg">
        {phase !== 'done' ? (
          <div className="max-w-2xl mx-auto">
            <div className="border-2 border-px-border bg-px-surface/70 p-5 space-y-4">
              <div className="font-game text-[12px] text-px-text-dim tracking-wider">打包内容</div>
              <label className="flex items-center gap-3 font-game text-[12px] text-px-text cursor-pointer">
                <input type="checkbox" checked={includeWiki} onChange={(e) => setIncludeWiki(e.target.checked)} />
                包含 Wiki（编译后的专业问答，属能力一部分）
              </label>
              <label className="flex items-center gap-3 font-game text-[12px] text-px-text cursor-pointer">
                <input type="checkbox" checked={includeMemory} onChange={(e) => setIncludeMemory(e.target.checked)} />
                包含记忆（你与该分身的私有记忆，分享前请确认无隐私）
              </label>
              <label className="flex items-center gap-3 font-game text-[12px] text-px-text cursor-pointer">
                <input type="checkbox" checked={includeLife} onChange={(e) => setIncludeLife(e.target.checked)} />
                包含人生数据（life 时间线/情景，个人化内容）
              </label>
            </div>

            <div className="mt-5 border-2 border-px-border bg-px-surface/70 p-5 space-y-4">
              <div className="font-game text-[12px] text-px-text-dim tracking-wider">分发信息（可选，展示给导入者）</div>
              <div>
                <div className="font-game text-[11px] text-px-text-dim mb-2">展示名称</div>
                <input
                  type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-px-bg border-2 border-px-border px-3 py-2 text-[12px] text-px-text font-game outline-none focus:border-px-primary"
                />
              </div>
              <div>
                <div className="font-game text-[11px] text-px-text-dim mb-2">简介</div>
                <textarea
                  value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                  placeholder="一句话介绍这个分身的专长"
                  className="w-full bg-px-bg border-2 border-px-border px-3 py-2 text-[12px] text-px-text font-game outline-none focus:border-px-primary resize-none"
                />
              </div>
              <div>
                <div className="font-game text-[11px] text-px-text-dim mb-2">作者署名</div>
                <input
                  type="text" value={createdBy} onChange={(e) => setCreatedBy(e.target.value)}
                  placeholder="你的名字 / 团队"
                  className="w-full bg-px-bg border-2 border-px-border px-3 py-2 text-[12px] text-px-text font-game outline-none focus:border-px-primary"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={onClose} className="pixel-btn-outline-muted px-4 py-2 text-[11px]">取消</button>
              <button type="button" disabled={phase === 'exporting'} onClick={handleExport} className="pixel-btn-primary px-5 py-2 text-[11px] disabled:opacity-50">
                {phase === 'exporting' ? '导出中...' : '导出为文件'}
              </button>
            </div>
          </div>
        ) : result && (
          <div className="max-w-2xl mx-auto">
            <div className="border-2 border-px-primary/60 bg-px-surface/95 p-5">
              <div className="font-game text-[15px] text-px-text font-bold">导出成功</div>
              <div className="font-game text-[12px] text-px-text-sec mt-3 break-all">
                文件：<span className="text-px-primary">{result.outputFilePath}</span>
              </div>
              <div className="font-game text-[11px] text-px-text-dim mt-2">
                {(result.size / 1024).toFixed(1)} KB · {result.filesCount} 个文件 · {result.binaryRefsCount} 个二进制资源
                {result.memoryIncluded ? ' · 含记忆' : ''}
              </div>
              <p className="font-game text-[11px] text-px-text-dim mt-4 leading-relaxed">
                把这个 .soulpack.json 发给对方，对方用「导入分身包」即可安装。
              </p>
            </div>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={onClose} className="pixel-btn-primary px-5 py-2 text-[11px]">完成</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
