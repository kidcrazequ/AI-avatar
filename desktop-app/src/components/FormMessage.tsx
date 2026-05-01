/**
 * questions_v2 表单消息：渲染 LLM 通过 questions_v2 工具发起的结构化提问，
 * 用户填完点击 SUBMIT，把答案作为下一条 user 消息送出（由父组件处理）。
 *
 * 支持的 kind：
 *   - text / textarea / number / date / email / url
 *   - single-select / multi-select
 *   - bool（开关）
 *   - file-path（让用户输入 workspace 内的相对路径）
 *
 * 设计原则：
 *   - 严格按 payload.questions 的顺序渲染，不擅自合并
 *   - required 标红
 *   - submit 时基础校验（必填/非空），不通过时禁用提交并提示
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import { useMemo, useState } from 'react'

export interface FormQuestionOption {
  value: string
  label: string
}

export interface FormQuestion {
  id: string
  kind: 'text' | 'textarea' | 'number' | 'date' | 'email' | 'url' | 'single-select' | 'multi-select' | 'bool' | 'file-path'
  title: string
  description?: string
  required?: boolean
  placeholder?: string
  options?: FormQuestionOption[]
  default?: unknown
}

export interface FormPayload {
  title?: string
  description?: string
  questions: FormQuestion[]
  submitLabel?: string
}

interface Props {
  payload: FormPayload
  onSubmit: (answers: Record<string, unknown>) => void
  onCancel?: () => void
  disabled?: boolean
}

export default function FormMessage({ payload, onSubmit, onCancel, disabled }: Props) {
  const initial = useMemo(() => {
    const obj: Record<string, unknown> = {}
    for (const q of payload.questions ?? []) {
      if (q.default !== undefined) obj[q.id] = q.default
      else if (q.kind === 'bool') obj[q.id] = false
      else if (q.kind === 'multi-select') obj[q.id] = []
      else obj[q.id] = ''
    }
    return obj
  }, [payload.questions])

  const [values, setValues] = useState<Record<string, unknown>>(initial)
  const [submitted, setSubmitted] = useState(false)

  const setVal = (id: string, v: unknown): void => {
    setValues((prev) => ({ ...prev, [id]: v }))
  }

  const validate = (): string[] => {
    const errs: string[] = []
    for (const q of payload.questions ?? []) {
      const v = values[q.id]
      if (q.required) {
        if (v === undefined || v === null || v === '') errs.push(`「${q.title}」必填`)
        if (Array.isArray(v) && v.length === 0) errs.push(`「${q.title}」必填`)
      }
      if (q.kind === 'email' && typeof v === 'string' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        errs.push(`「${q.title}」邮箱格式无效`)
      }
      if (q.kind === 'url' && typeof v === 'string' && v && !/^https?:\/\//i.test(v)) {
        errs.push(`「${q.title}」URL 必须以 http(s) 开头`)
      }
      if (q.kind === 'number' && typeof v === 'string' && v && Number.isNaN(Number(v))) {
        errs.push(`「${q.title}」需为数字`)
      }
    }
    return errs
  }

  const errors = validate()

  const handleSubmit = (): void => {
    setSubmitted(true)
    if (errors.length > 0) return
    // 标准化数字值
    const out: Record<string, unknown> = {}
    for (const q of payload.questions ?? []) {
      const v = values[q.id]
      if (q.kind === 'number' && typeof v === 'string' && v !== '') {
        out[q.id] = Number(v)
      } else {
        out[q.id] = v
      }
    }
    onSubmit(out)
  }

  return (
    <div className="border border-px-border bg-px-surface rounded p-3 max-w-[520px]">
      {payload.title && (
        <div className="font-game text-[12px] mb-1">{payload.title}</div>
      )}
      {payload.description && (
        <div className="text-[11px] text-px-text-dim mb-3 leading-relaxed">{payload.description}</div>
      )}

      <div className="space-y-3">
        {(payload.questions ?? []).map((q) => (
          <div key={q.id} className="flex flex-col gap-1">
            <label htmlFor={`q-${q.id}`} className="text-[11px] font-medium">
              {q.title}
              {q.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            {q.description && <div className="text-[10px] text-px-text-dim">{q.description}</div>}
            {renderInput(q, values[q.id], setVal, !!disabled)}
          </div>
        ))}
      </div>

      {submitted && errors.length > 0 && (
        <div className="mt-3 border border-red-400 bg-red-50 text-red-700 text-[11px] p-2 rounded">
          {errors.map((e, i) => <div key={i}>· {e}</div>)}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {onCancel && (
          <button type="button" className="px-3 py-1 text-[11px] border border-px-border bg-px-bg" onClick={onCancel} disabled={disabled}>
            CANCEL
          </button>
        )}
        <button
          type="button"
          className="px-3 py-1 text-[11px] border border-px-border bg-px-accent text-px-bg disabled:opacity-50"
          onClick={handleSubmit}
          disabled={disabled}
        >
          {payload.submitLabel ?? 'SUBMIT'}
        </button>
      </div>
    </div>
  )
}

function renderInput(
  q: FormQuestion,
  value: unknown,
  set: (id: string, v: unknown) => void,
  disabled: boolean,
) {
  const id = `q-${q.id}`
  const baseClass = 'border border-px-border bg-px-bg text-[11px] px-2 py-1 w-full'
  switch (q.kind) {
    case 'textarea':
      return (
        <textarea
          id={id}
          className={`${baseClass} min-h-[80px] resize-y`}
          value={String(value ?? '')}
          placeholder={q.placeholder}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
    case 'number':
      return (
        <input
          id={id}
          type="number"
          className={baseClass}
          value={String(value ?? '')}
          placeholder={q.placeholder}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
    case 'date':
      return (
        <input
          id={id}
          type="date"
          className={baseClass}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
    case 'email':
      return (
        <input
          id={id}
          type="email"
          className={baseClass}
          value={String(value ?? '')}
          placeholder={q.placeholder}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
    case 'url':
      return (
        <input
          id={id}
          type="url"
          className={baseClass}
          value={String(value ?? '')}
          placeholder={q.placeholder ?? 'https://...'}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
    case 'single-select':
      return (
        <select
          id={id}
          className={baseClass}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        >
          <option value="">--</option>
          {(q.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
    case 'multi-select': {
      const arr = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="flex flex-wrap gap-1">
          {(q.options ?? []).map((o) => {
            const checked = arr.includes(o.value)
            return (
              <label key={o.value} className={`px-2 py-0.5 border text-[11px] cursor-pointer ${checked ? 'border-px-accent text-px-accent' : 'border-px-border text-px-text-dim'}`}>
                <input
                  type="checkbox"
                  className="hidden"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    const next = checked ? arr.filter((x) => x !== o.value) : [...arr, o.value]
                    set(q.id, next)
                  }}
                />
                {o.label}
              </label>
            )
          })}
        </div>
      )
    }
    case 'bool':
      return (
        <label className="inline-flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={!!value}
            disabled={disabled}
            onChange={(e) => set(q.id, e.target.checked)}
          />
          <span>{q.placeholder ?? '是'}</span>
        </label>
      )
    case 'file-path':
      return (
        <input
          id={id}
          type="text"
          className={baseClass}
          value={String(value ?? '')}
          placeholder={q.placeholder ?? 'src/Hero.tsx'}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
    case 'text':
    default:
      return (
        <input
          id={id}
          type="text"
          className={baseClass}
          value={String(value ?? '')}
          placeholder={q.placeholder}
          disabled={disabled}
          onChange={(e) => set(q.id, e.target.value)}
        />
      )
  }
}
