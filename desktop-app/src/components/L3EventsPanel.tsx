/**
 * L3 事件汇总面板：把主进程通过 IPC 推到渲染进程的桌面能力事件
 * 渲染成可交互卡片，落在 ChatWindow 输入区上方。
 *
 * 当前覆盖：
 *   - questions_v2 表单（FormMessage）：提交后作为下一条 user 消息送出
 *   - inspector 选中元素：变成 attachment chip，用户可一键引用
 *   - verifier 结果：成功/失败 + 截图缩略
 *   - 下载卡片：present_fs_item_for_download
 *   - Canva 上传引导
 *   - GitHub PAT 输入弹窗
 *   - snip 登记提示
 *
 * 设计原则：
 *   - 同会话内的事件不互相覆盖，逐条堆叠
 *   - 切换会话时清空（按 conversationId 过滤）
 *   - 用户操作后移除卡片，避免占据空间
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import { useEffect, useState, useCallback } from 'react'
import FormMessage, { type FormPayload } from './FormMessage'

type L3Event =
  | { kind: 'form'; id: string; payload: FormPayload }
  | { kind: 'block'; id: string; payload: PreviewBlockReflectPayload }
  | { kind: 'verifier'; id: string; payload: VerifierResultPayload }
  | { kind: 'download'; id: string; payload: ChatDownloadCardPayload }
  | { kind: 'canva'; id: string; payload: { exportPath?: string } }
  | { kind: 'github-pat'; id: string }
  | { kind: 'snip'; id: string; fromId: string; toId: string }

let eventSeq = 0
const nextEventId = (): string => `l3-${Date.now()}-${++eventSeq}`

interface Props {
  conversationId: string
  onInjectPrompt: (text: string) => void
}

export default function L3EventsPanel({ conversationId, onInjectPrompt }: Props) {
  const [events, setEvents] = useState<L3Event[]>([])

  const removeEvent = useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id))
  }, [])

  // 切换会话时清空旧卡片
  useEffect(() => {
    setEvents([])
  }, [conversationId])

  // 订阅所有 L3 推送
  useEffect(() => {
    const offForm = window.electronAPI.onChatFormRequest((p) => {
      if (p.conversationId !== conversationId) return
      const formPayload = p.payload as FormPayload
      if (!formPayload || !Array.isArray(formPayload.questions)) return
      setEvents((prev) => [...prev, { kind: 'form', id: nextEventId(), payload: formPayload }])
    })
    const offBlock = window.electronAPI.onPreviewBlockSelected((payload: PreviewBlockReflectPayload) => {
      if (payload.conversationId !== conversationId) return
      setEvents((prev) => [...prev, { kind: 'block', id: nextEventId(), payload }])
    })
    const offVerifier = window.electronAPI.onVerifierResult((payload: VerifierResultPayload) => {
      if (payload.conversationId !== conversationId) return
      setEvents((prev) => [...prev, { kind: 'verifier', id: nextEventId(), payload }])
    })
    const offDownload = window.electronAPI.onChatDownloadCard((payload) => {
      if (payload.conversationId !== conversationId) return
      setEvents((prev) => [...prev, { kind: 'download', id: nextEventId(), payload }])
    })
    const offCanva = window.electronAPI.onChatCanvaUploadCard((payload) => {
      if (payload.conversationId !== conversationId) return
      setEvents((prev) => [...prev, { kind: 'canva', id: nextEventId(), payload: { exportPath: payload.exportPath } }])
    })
    const offGithub = window.electronAPI.onChatRequestGithubPat((payload) => {
      if (payload.conversationId !== conversationId) return
      setEvents((prev) => [...prev, { kind: 'github-pat', id: nextEventId() }])
    })
    const offSnip = window.electronAPI.onChatSnipAdded((payload) => {
      if (payload.conversationId !== conversationId) return
      setEvents((prev) => [...prev, { kind: 'snip', id: nextEventId(), fromId: payload.fromId, toId: payload.toId }])
    })
    return () => {
      offForm()
      offBlock()
      offVerifier()
      offDownload()
      offCanva()
      offGithub()
      offSnip()
    }
  }, [conversationId])

  if (events.length === 0) return null

  return (
    <div className="border-t border-px-border bg-px-surface/30 px-4 py-2 max-h-[40vh] overflow-y-auto space-y-2">
      {events.map((evt) => {
        if (evt.kind === 'form') {
          return (
            <FormMessage
              key={evt.id}
              payload={evt.payload}
              onSubmit={(answers) => {
                onInjectPrompt(`[questions_v2 answers]\n${JSON.stringify(answers, null, 2)}`)
                removeEvent(evt.id)
              }}
              onCancel={() => removeEvent(evt.id)}
            />
          )
        }
        if (evt.kind === 'block') {
          const p = evt.payload
          return (
            <div key={evt.id} className="border border-px-border bg-px-surface text-[11px] p-2 rounded">
              <div className="flex items-center justify-between mb-1">
                <span className="font-game text-px-accent">INSPECT · {p.ccId}</span>
                <button className="text-px-text-dim hover:text-px-primary" onClick={() => removeEvent(evt.id)}>×</button>
              </div>
              <div className="text-px-text-dim">
                &lt;{p.tag}&gt; {p.id ? `#${p.id}` : ''} {p.classes ? `.${p.classes.split(/\s+/).slice(0, 3).join('.')}` : ''}
                {p.reactComponentName ? ` · React: ${p.reactComponentName}` : ''}
              </div>
              {p.text && <div className="mt-1 text-px-text-sec line-clamp-2">"{p.text}"</div>}
              <div className="mt-2 flex gap-2">
                <button
                  className="px-2 py-0.5 border border-px-border bg-px-bg hover:bg-px-accent hover:text-px-bg"
                  onClick={() => {
                    const lines: string[] = [`@${p.ccId}`, `tag=${p.tag}`]
                    if (p.reactComponentName) lines.push(`component=${p.reactComponentName}`)
                    if (p.id) lines.push(`id=${p.id}`)
                    if (p.classes) lines.push(`classes="${p.classes}"`)
                    if (p.sourceHint) lines.push(`source=${p.sourceHint.file}:${p.sourceHint.line}`)
                    onInjectPrompt(`请帮我修改这个元素：\n${lines.join('\n')}`)
                    removeEvent(evt.id)
                  }}
                >
                  USE IN PROMPT
                </button>
              </div>
            </div>
          )
        }
        if (evt.kind === 'verifier') {
          const p = evt.payload
          return (
            <div key={evt.id} className="border border-px-border bg-px-surface text-[11px] p-2 rounded">
              <div className="flex items-center justify-between mb-1">
                <span className={`font-game ${p.ok ? 'text-px-primary' : 'text-px-danger'}`}>
                  VERIFIER · {p.ok ? 'PASS' : 'FAIL'} · {p.elapsedMs}ms
                </span>
                <button className="text-px-text-dim hover:text-px-primary" onClick={() => removeEvent(evt.id)}>×</button>
              </div>
              <div className="text-px-text-dim line-clamp-2">{p.message}</div>
              {p.errors.length > 0 && (
                <ul className="mt-1 text-px-danger">
                  {p.errors.slice(0, 3).map((e, i) => <li key={i}>· {e.text}</li>)}
                </ul>
              )}
              <div className="mt-1 flex gap-2 flex-wrap">
                {p.shots.map((s, i) => (
                  <span key={i} className="px-1.5 py-0.5 border border-px-border text-px-text-dim">
                    {s.viewport.name} {s.viewport.width}×{s.viewport.height}
                  </span>
                ))}
              </div>
            </div>
          )
        }
        if (evt.kind === 'download') {
          const p = evt.payload
          return (
            <div key={evt.id} className="border border-px-border bg-px-surface text-[11px] p-2 rounded flex items-center gap-2">
              <span className="font-game text-px-accent">DOWNLOAD</span>
              <span className="text-px-text-sec flex-1">{p.relativePath} ({(p.sizeBytes / 1024).toFixed(1)} KB)</span>
              <button
                className="px-2 py-0.5 border border-px-border bg-px-bg hover:bg-px-accent hover:text-px-bg"
                onClick={() => removeEvent(evt.id)}
              >
                OK
              </button>
            </div>
          )
        }
        if (evt.kind === 'canva') {
          return (
            <div key={evt.id} className="border border-px-border bg-px-surface text-[11px] p-2 rounded">
              <div className="flex items-center justify-between mb-1">
                <span className="font-game text-px-accent">CANVA · UPLOAD</span>
                <button className="text-px-text-dim hover:text-px-primary" onClick={() => removeEvent(evt.id)}>×</button>
              </div>
              <div className="text-px-text-dim">
                浏览器已打开 Canva 上传页。
                {evt.payload.exportPath && (
                  <>把已导出的文件 <code className="bg-px-bg px-1">{evt.payload.exportPath}</code> 拖入 Canva 即可继续编辑。</>
                )}
              </div>
            </div>
          )
        }
        if (evt.kind === 'github-pat') {
          return <GitHubPatPrompt key={evt.id} onClose={() => removeEvent(evt.id)} />
        }
        if (evt.kind === 'snip') {
          return (
            <div key={evt.id} className="border border-px-border bg-px-surface text-[11px] p-2 rounded flex items-center gap-2">
              <span className="font-game text-px-accent">SNIP</span>
              <span className="text-px-text-sec flex-1">已登记上下文裁剪：{evt.fromId} → {evt.toId}（下次发送时生效）</span>
              <button className="px-2 py-0.5 border border-px-border bg-px-bg" onClick={() => removeEvent(evt.id)}>
                OK
              </button>
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function GitHubPatPrompt({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [login, setLogin] = useState<string | null>(null)

  const handleConnect = async (): Promise<void> => {
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const r = await window.electronAPI.githubConnect(token.trim())
      setLogin(r.login)
      setTimeout(onClose, 1200)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border border-px-border bg-px-surface text-[11px] p-2 rounded">
      <div className="flex items-center justify-between mb-1">
        <span className="font-game text-px-accent">GITHUB · CONNECT</span>
        <button className="text-px-text-dim hover:text-px-primary" onClick={onClose}>×</button>
      </div>
      {login ? (
        <div className="text-px-primary">已连接 GitHub 账户：{login}</div>
      ) : (
        <>
          <div className="text-px-text-dim mb-1">
            粘贴 GitHub Personal Access Token（需要 repo 范围）：
            <a className="ml-1 underline" href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">创建 PAT →</a>
          </div>
          <input
            type="password"
            className="border border-px-border bg-px-bg px-2 py-1 w-full"
            placeholder="github_pat_..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {errorMsg && <div className="text-px-danger mt-1">{errorMsg}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <button className="px-2 py-0.5 border border-px-border bg-px-bg" onClick={onClose} disabled={submitting}>取消</button>
            <button
              className="px-2 py-0.5 border border-px-border bg-px-accent text-px-bg disabled:opacity-50"
              onClick={handleConnect}
              disabled={submitting || token.trim().length < 10}
            >
              {submitting ? '验证中...' : '连接'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
