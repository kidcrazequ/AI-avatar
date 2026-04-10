/**
 * @file AvatarPicker.tsx — 分身头像选择器
 * @author zhi.qu
 * @date 2026-04-10
 *
 * 支持两种方式选择头像：
 * 1. 从预置像素风头像库中点击选择
 * 2. 上传本地图片，自动进行像素化处理后预览
 */

import { useState, useRef } from 'react'
import { DEFAULT_AVATARS } from './DefaultAvatars'
import { pixelateImage } from '../utils/pixelate'

interface Props {
  /** 当前头像值：data URL 或 "default:<key>"，undefined 表示未设置 */
  value?: string
  /** 头像变更回调 */
  onChange: (avatarImage: string) => void
}

export default function AvatarPicker({ value, onChange }: Props) {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 当前选中的是预置头像的 key */
  const selectedDefaultKey = value?.startsWith('default:') ? value.slice(8) : null

  const handleSelectDefault = (key: string) => {
    setUploadError('')
    onChange(`default:${key}`)
  }

  const handleUploadClick = () => {
    setUploadError('')
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setUploadError('请选择图片文件（JPG / PNG / WebP）')
      return
    }

    setIsUploading(true)
    setUploadError('')

    try {
      const dataUrl = await readFileAsDataUrl(file)
      const pixelated = await pixelateImage(dataUrl)
      onChange(pixelated)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setUploadError(`处理图片失败：${msg}`)
      window.electronAPI.logEvent('error', 'avatar-picker-upload', msg)
    } finally {
      setIsUploading(false)
      // 重置 input 允许重复选同一文件
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      <label className="pixel-label">分身头像（可选）</label>

      {/* 预置头像网格 */}
      <div className="border-2 border-px-border bg-px-elevated p-3">
        <p className="font-game text-[12px] text-px-text-dim mb-3 tracking-wider">预置头像</p>
        <div className="grid grid-cols-6 gap-2">
          {DEFAULT_AVATARS.map((avatar) => {
            const isSelected = selectedDefaultKey === avatar.key
            return (
              <button
                key={avatar.key}
                type="button"
                title={avatar.label}
                onClick={() => handleSelectDefault(avatar.key)}
                className={`w-10 h-10 border-2 flex items-center justify-center transition-none
                  ${isSelected
                    ? 'border-px-primary shadow-pixel-brand bg-px-primary/10'
                    : 'border-px-border hover:border-px-primary/60 bg-px-bg'
                  }`}
                aria-pressed={isSelected}
                aria-label={avatar.label}
              >
                <div className="w-8 h-8 [image-rendering:pixelated]">
                  {avatar.svg}
                </div>
              </button>
            )
          })}
        </div>
        {/* 选中头像名称 */}
        {selectedDefaultKey && (
          <p className="font-game text-[11px] text-px-primary mt-2 tracking-wider">
            已选：{DEFAULT_AVATARS.find(a => a.key === selectedDefaultKey)?.label}
          </p>
        )}
      </div>

      {/* 自定义上传区 */}
      <div className="border-2 border-px-border bg-px-elevated p-3">
        <div className="flex items-center justify-between">
          <p className="font-game text-[12px] text-px-text-dim tracking-wider">自定义图片</p>
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={isUploading}
            className="pixel-btn-outline-muted text-[12px] px-3 py-1.5"
          >
            {isUploading ? '处理中...' : '[↑] 上传图片'}
          </button>
        </div>

        {/* 自定义头像预览 */}
        {value && !value.startsWith('default:') && (
          <div className="mt-3 flex items-center gap-3">
            <img
              src={value}
              alt="自定义头像预览"
              className="w-12 h-12 border-2 border-px-primary [image-rendering:pixelated]"
            />
            <div>
              <p className="font-game text-[11px] text-px-primary tracking-wider">已上传（像素化）</p>
              <button
                type="button"
                onClick={() => onChange('')}
                className="font-game text-[11px] text-px-text-dim hover:text-px-danger mt-0.5"
              >
                移除
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <p className="font-game text-[12px] text-px-danger mt-2">{uploadError}</p>
        )}

        <p className="font-game text-[11px] text-px-text-dim mt-2">
          支持 JPG / PNG / WebP，自动转换为像素风格
        </p>
      </div>

      {/* 隐藏 input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        aria-hidden="true"
      />
    </div>
  )
}

/** 将 File 读取为 data URL */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const result = e.target?.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('文件读取结果格式异常'))
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}
