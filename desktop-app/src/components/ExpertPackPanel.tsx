/**
 * @file ExpertPackPanel.tsx — 可选专家包安装面板
 * @author zhi.qu
 * @date 2026-05-10
 */

import { useEffect, useState } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import AvatarImage from './AvatarImage'

interface Props {
  onClose: () => void
  onInstalled: (avatarId: string) => Promise<void> | void
  onOpenAvatar: (avatarId: string) => Promise<void> | void
  showToast?: (message: string, type?: 'success' | 'error') => void
}

export default function ExpertPackPanel({ onClose, onInstalled, onOpenAvatar, showToast }: Props) {
  const [packs, setPacks] = useState<ExpertPack[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [installingId, setInstallingId] = useState<string | null>(null)

  const loadPacks = async () => {
    setIsLoading(true)
    try {
      setPacks(await window.electronAPI.listExpertPacks())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast?.(`加载专家包失败：${msg}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadPacks 是 async + setState 在 await 后跑，规则误判
    loadPacks()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在面板打开时加载一次，安装后手动刷新
  }, [])

  const handleInstall = async (pack: ExpertPack) => {
    if (pack.installed && pack.installedAvatarId) {
      await onOpenAvatar(pack.installedAvatarId)
      onClose()
      return
    }

    setInstallingId(pack.id)
    try {
      const result = await window.electronAPI.installExpertPack(pack.id)
      await onInstalled(result.avatarId)
      showToast?.(result.installed ? `已安装 ${pack.name}` : `${pack.name} 已安装`, 'success')
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast?.(`安装失败：${msg}`, 'error')
    } finally {
      setInstallingId(null)
    }
  }

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <PanelHeader
        title="专家包市场"
        subtitle="按需安装通用专家，安装后进入“我的分身”"
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto p-6 bg-px-bg">
        {isLoading ? (
          <div className="font-game text-[13px] text-px-text-dim">正在加载专家包...</div>
        ) : packs.length === 0 ? (
          <div className="border-2 border-dashed border-px-border bg-px-surface/70 p-10 text-center">
            <div className="font-game text-[14px] text-px-text">暂无可选专家包</div>
            <div className="font-game text-[12px] text-px-text-dim mt-2">请确认 expert-packs 资源目录已随应用提供。</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {packs.map((pack) => (
              <div
                key={pack.id}
                className="border-2 border-px-border bg-px-surface/95 p-5 flex flex-col min-h-[220px]"
              >
                <div className="flex items-start gap-4">
                  <AvatarImage avatarImage={pack.avatarImage} name={pack.name} size="md" className="flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-game text-[15px] text-px-text font-bold leading-snug">{pack.name}</div>
                        <div className="font-game text-[10px] text-px-primary mt-2 tracking-wider">
                          {pack.domain} · v{pack.version}
                        </div>
                      </div>
                      <span className={`font-game text-[10px] border px-2 py-1 whitespace-nowrap ${
                        pack.installed
                          ? 'text-px-primary border-px-primary/70'
                          : 'text-px-text-dim border-px-border-dim'
                      }`}>
                        {pack.installed ? '已安装' : '可安装'}
                      </span>
                    </div>
                    <p className="font-game text-[12px] text-px-text-sec mt-4 leading-relaxed">{pack.description}</p>
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t border-px-border-dim/70 flex-1">
                  <div className="font-game text-[10px] text-px-text-dim tracking-wider mb-2">红线提示</div>
                  <p className="font-game text-[11px] text-px-text-dim leading-relaxed">{pack.redline}</p>
                </div>

                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    disabled={!pack.installable || installingId === pack.id}
                    onClick={() => handleInstall(pack)}
                    className="pixel-btn-primary px-4 py-2 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {installingId === pack.id
                      ? '安装中...'
                      : pack.installed
                        ? '进入分身'
                        : '安装专家包'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
