/**
 * AskQuestionCard：ask_question 工具触发的多选卡片。
 *
 * 与 questions_v2 表单（FormMessage）的差异：
 *   - 单题 + 选项点选式（不需要长输入），交互更轻
 *   - 用户点选后立即作为下一条 user 消息送出（前缀 "[ask_question answer]"）
 *   - 支持 allow_custom：true 时显示"自定义答案"输入框
 *
 * 数据来源：
 *   - main.ts 在 LLM 调用 ask_question 后发送 chat:ask-question 事件
 *   - 通过 window.electronAPI.onChatAskQuestion 订阅
 *
 * 显示逻辑：
 *   - card 仅当 ChatWindow 收到 ask-question 事件后才渲染
 *   - 用户点选 / 提交后立即调用 onAnswer，并清掉本地 state（一次性卡片）
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import { useState } from 'react'

interface Props {
  question: string
  options: string[]
  allowCustom: boolean
  /** 用户提交答案后回调（answer 已 trim） */
  onAnswer: (answer: string) => void
  /** 用户取消（点 X 关闭） */
  onCancel: () => void
}

export default function AskQuestionCard({ question, options, allowCustom, onAnswer, onCancel }: Props) {
  const [customText, setCustomText] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  const handleSelect = (option: string): void => {
    onAnswer(option.trim())
  }

  const handleSubmitCustom = (): void => {
    const trimmed = customText.trim()
    if (!trimmed) return
    onAnswer(trimmed)
  }

  return (
    <div className="mx-4 my-2 border-2 border-px-primary bg-px-elevated">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-px-border-dim bg-px-surface/50">
        <span className="font-game text-[12px] text-px-primary tracking-wider">
          ASK QUESTION
        </span>
        <button
          onClick={onCancel}
          className="font-game text-[14px] text-px-text-dim hover:text-px-danger px-2"
          aria-label="取消提问"
          title="取消（不回答）"
        >
          ✕
        </button>
      </div>

      {/* 问题 */}
      <div className="px-4 py-3">
        <p className="font-game text-[13px] text-px-text mb-3 leading-relaxed">
          {question}
        </p>

        {/* 选项按钮列表 */}
        <div className="space-y-1.5">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => handleSelect(opt)}
              className="w-full text-left px-3 py-2 border border-px-border bg-px-surface
                hover:border-px-primary hover:bg-px-primary/10 transition-colors
                font-game text-[12px] text-px-text"
            >
              <span className="text-px-text-dim mr-2">{String.fromCharCode(65 + i)}.</span>
              {opt}
            </button>
          ))}
        </div>

        {/* 自定义答案输入框（仅 allow_custom=true 时） */}
        {allowCustom && (
          <div className="mt-3 pt-3 border-t border-px-border-dim">
            {!showCustom ? (
              <button
                onClick={() => setShowCustom(true)}
                className="font-game text-[11px] text-px-text-dim hover:text-px-primary"
              >
                + 自定义答案
              </button>
            ) : (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitCustom() }}
                  placeholder="输入自定义答案后回车提交..."
                  className="pixel-input flex-1 font-game text-[12px]"
                  autoFocus
                />
                <button
                  onClick={handleSubmitCustom}
                  disabled={!customText.trim()}
                  className="pixel-btn-primary px-3 disabled:opacity-50"
                >
                  提交
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
