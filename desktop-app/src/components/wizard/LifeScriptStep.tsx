/**
 * @file LifeScriptStep.tsx — 创建分身向导第 5 步「人生剧本」
 *
 * 功能：让用户决定是否为新分身设计完整人生（plan 4.1 节 ASCII 图）。
 *   - 默认 ✓ 启用人生（推荐）
 *   - 年龄输入 3-65（默认 30）
 *   - timeScale 4 选 1（1× / 12× / 52× / 冻结，默认 1×）
 *   - 额外要求 textarea（可选）
 *   - 显示预估「80~100 个事件 · 8~10 万字 · 5~10 分钟」
 *   - creationModel.apiKey 缺失时显示黄色 fallback 提示带"去设置配置"链接
 *
 * 设计要点：
 *   - 受控组件：值由父级 CreateAvatarWizard 持有
 *   - 不直接调 IPC：仅采集表单数据，IPC 在父级 handleCreate 触发
 *   - 4 选 1 timeScale 用 union type LifeTimeScale（来自 life-service）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { LifeTimeScale } from '../../services/life-service'

interface Props {
  /** 是否启用人生（默认 true） */
  lifeEnabled: boolean
  setLifeEnabled: (v: boolean) => void

  /** 3-65 之间的整数岁数（默认 30） */
  lifeAge: number
  setLifeAge: (v: number) => void

  /** 4 选 1 时间生长速度（默认 1） */
  lifeTimeScale: LifeTimeScale
  setLifeTimeScale: (v: LifeTimeScale) => void

  /** 用户额外要求（可空） */
  lifeExtraHints: string
  setLifeExtraHints: (v: string) => void

  /** 人生经历姓名策略 */
  lifeNameMode: 'avatar' | 'custom'
  setLifeNameMode: (v: 'avatar' | 'custom') => void
  lifePersonaName: string
  setLifePersonaName: (v: string) => void
  avatarName: string

  /** 创作模型是否已配置（缺失时显示黄色 fallback 提示） */
  hasCreationApiKey: boolean

  /** 用户点击"去设置配置创作模型"时切换面板的回调（可选；
   *  在向导内部触发会先关闭向导再切到设置） */
  onOpenSettings?: () => void
}

const TIME_SCALE_OPTIONS: Array<{ value: LifeTimeScale; label: string; hint: string }> = [
  { value: 1, label: '真实同步', hint: '1 月 → 1 月，最自然，推荐' },
  { value: 12, label: '加速 12×', hint: '1 月 → 1 年，快速看到分身长大' },
  { value: 52, label: '加速 52×', hint: '1 周 → 1 年，仅适合短期实验' },
  { value: 0, label: '冻结', hint: '不随真实时间生长' },
]

export default function LifeScriptStep({
  lifeEnabled, setLifeEnabled,
  lifeAge, setLifeAge,
  lifeTimeScale, setLifeTimeScale,
  lifeExtraHints, setLifeExtraHints,
  lifeNameMode, setLifeNameMode,
  lifePersonaName, setLifePersonaName,
  avatarName,
  hasCreationApiKey,
  onOpenSettings,
}: Props) {
  const ageInvalid = lifeEnabled && (!Number.isFinite(lifeAge) || lifeAge < 3 || lifeAge > 65)
  const nameInvalid = lifeEnabled && lifeNameMode === 'custom' && lifePersonaName.trim().length === 0

  return (
    <div className="space-y-5 max-w-xl">
      {/* 顶部说明 */}
      <div className="border-l-3 border-px-primary pl-4 py-1">
        <h3 className="font-game text-[14px] text-px-text tracking-wider">人生剧本（可选）</h3>
        <p className="font-game text-[13px] text-px-text-sec mt-1">
          为分身设计一段完整人生（0 → 现在），让对话风格、专业判断、价值观从这场人生里生长出来。
        </p>
      </div>

      {/* 启用开关 */}
      <label className="flex items-start gap-3 p-3 bg-px-elevated border-2 border-px-border cursor-pointer hover:border-px-primary transition-none">
        <input
          type="checkbox"
          checked={lifeEnabled}
          onChange={(e) => setLifeEnabled(e.target.checked)}
          className="mt-0.5 accent-px-primary w-4 h-4 cursor-pointer"
        />
        <div className="flex-1">
          <span className="font-game text-[14px] text-px-text tracking-wider">
            为分身设计一场完整人生（推荐）
          </span>
          <p className="font-game text-[12px] text-px-text-dim mt-1 leading-relaxed">
            创建后将在后台生成 80~100 个人生事件，分身可立即对话，人生会逐步成形。
            不勾选则跳过此步，后续可在「人生」面板补做。
          </p>
        </div>
      </label>

      {/* 姓名确认 */}
      <div className={lifeEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <label className="pixel-label">人生经历使用名 *</label>
        <div className="space-y-1.5">
          <label className={`flex items-center gap-3 px-3 py-2 border-2 cursor-pointer transition-none
            ${lifeNameMode === 'avatar' ? 'border-px-primary bg-px-primary/5' : 'border-px-border bg-px-elevated hover:border-px-primary/50'}`}
          >
            <input
              type="radio"
              name="wizard-life-name"
              checked={lifeNameMode === 'avatar'}
              onChange={() => setLifeNameMode('avatar')}
              className="accent-px-primary"
              disabled={!lifeEnabled}
            />
            <span className="font-game text-[13px] text-px-text-sec tracking-wider">
              使用分身名「{avatarName || '未命名分身'}」
            </span>
          </label>
          <label className={`flex items-center gap-3 px-3 py-2 border-2 cursor-pointer transition-none
            ${lifeNameMode === 'custom' ? 'border-px-primary bg-px-primary/5' : 'border-px-border bg-px-elevated hover:border-px-primary/50'}`}
          >
            <input
              type="radio"
              name="wizard-life-name"
              checked={lifeNameMode === 'custom'}
              onChange={() => setLifeNameMode('custom')}
              className="accent-px-primary"
              disabled={!lifeEnabled}
            />
            <span className="font-game text-[13px] text-px-text-sec tracking-wider">指定真实姓名</span>
          </label>
        </div>
        {lifeNameMode === 'custom' && (
          <input
            type="text"
            value={lifePersonaName}
            onChange={(e) => setLifePersonaName(e.target.value)}
            placeholder="例如：杜明。填写后将作为人生经历里的名字"
            className="pixel-input w-full mt-2"
            disabled={!lifeEnabled}
          />
        )}
        {nameInvalid && (
          <p className="mt-1 font-game text-[12px] text-px-danger tracking-wider">请填写已确认的人生经历姓名</p>
        )}
      </div>

      {/* 年龄 */}
      <div className={lifeEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <label className="pixel-label">分身现在的年龄 *</label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={3}
            max={65}
            value={Number.isFinite(lifeAge) ? lifeAge : ''}
            onChange={(e) => setLifeAge(parseInt(e.target.value, 10))}
            className="pixel-input w-24 text-center"
            disabled={!lifeEnabled}
          />
          <span className="font-game text-[12px] text-px-text-dim tracking-wider">岁（3 ~ 65）</span>
        </div>
        {ageInvalid && (
          <p className="mt-1 font-game text-[12px] text-px-danger tracking-wider">年龄须在 3~65 之间</p>
        )}
      </div>

      {/* 时间速度 */}
      <div className={lifeEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <label className="pixel-label">时间生长速度</label>
        <div className="space-y-1.5">
          {TIME_SCALE_OPTIONS.map((opt) => {
            const checked = lifeTimeScale === opt.value
            return (
              <label
                key={opt.value}
                className={`flex items-center gap-3 px-3 py-2 border-2 cursor-pointer transition-none
                  ${checked ? 'border-px-primary bg-px-primary/5' : 'border-px-border bg-px-elevated hover:border-px-primary/50'}`}
              >
                <input
                  type="radio"
                  name="wizard-time-scale"
                  checked={checked}
                  onChange={() => setLifeTimeScale(opt.value)}
                  className="accent-px-primary"
                  disabled={!lifeEnabled}
                />
                <span className="font-game text-[14px] text-px-text tracking-wider w-20">{opt.label}</span>
                <span className="font-game text-[12px] text-px-text-dim tracking-wider flex-1">{opt.hint}</span>
              </label>
            )
          })}
        </div>
      </div>

      {/* 额外要求 */}
      <div className={lifeEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <label className="pixel-label">额外要求（可选）</label>
        <textarea
          value={lifeExtraHints}
          onChange={(e) => setLifeExtraHints(e.target.value)}
          placeholder="例如：想让分身的人生有海外经历，专业起步早"
          rows={3}
          className="pixel-input w-full"
          disabled={!lifeEnabled}
        />
      </div>

      {/* 预估 */}
      {lifeEnabled && (
        <div className="border-2 border-px-border-dim bg-px-bg p-3">
          <p className="font-game text-[12px] text-px-text-sec tracking-wider leading-relaxed">
            <span className="text-px-primary">[预估]</span> 80~100 个事件 · 8~10 万字 · 5~10 分钟
            <br />
            <span className="text-px-text-dim">
              ⓘ 分身创建完成后会在后台开始"经历人生"，你可以先和它对话，人生会逐步成形。
            </span>
          </p>
        </div>
      )}

      {/* fallback 黄色提示（creationModel 缺失） */}
      {lifeEnabled && !hasCreationApiKey && (
        <div className="border-2 border-yellow-400/60 bg-yellow-400/10 p-3">
          <p className="font-game text-[12px] text-yellow-300 tracking-wider leading-relaxed">
            ⚠ 创作模型未配置，将使用对话模型生成人生
            {onOpenSettings && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="underline hover:text-yellow-200 transition-none"
                >
                  → 去设置配置
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  )
}
