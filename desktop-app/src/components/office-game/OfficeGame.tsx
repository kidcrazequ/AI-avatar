import { useEffect, useId, useMemo, useState } from 'react'
import officeBackground from '../../assets/office/pixel-office/soul-pixel-office-1080x780-prototype.png'
import { getSingleOfficeNpcSnapshot, selectOfficeNpcAvatar, type OfficeNpcSnapshot } from './officeNpcState'
import { getOfficeSprite, type OfficeSpriteDefinition } from './officeSprites'

const OFFICE_VIEW_BOX = '0 0 1080 780'

type OfficeGameProps = {
  avatars: Avatar[]
  activeAvatarId?: string
  onEnterAvatar: (avatarId: string) => void
}

export default function OfficeGame({ avatars, activeAvatarId, onEnterAvatar }: OfficeGameProps) {
  const npcAvatar = useMemo(() => selectOfficeNpcAvatar(avatars, activeAvatarId), [activeAvatarId, avatars])
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    setElapsedMs(0)
    if (!npcAvatar) return

    const start = performance.now()
    let frame = 0
    let lastPaint = 0
    const tick = (now: number) => {
      if (now - lastPaint >= 80) {
        setElapsedMs(now - start)
        lastPaint = now
      }
      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [npcAvatar?.id])

  const snapshot = useMemo(() => {
    if (!npcAvatar) return null
    return getSingleOfficeNpcSnapshot(npcAvatar, elapsedMs)
  }, [elapsedMs, npcAvatar])

  return (
    <div className="office-game-shell">
      <svg
        className="office-game-svg"
        viewBox={OFFICE_VIEW_BOX}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="AI 分身像素办公室"
      >
        <image href={officeBackground} x="0" y="0" width="1080" height="780" preserveAspectRatio="xMidYMid meet" />
        {snapshot && <OfficeGameNpc snapshot={snapshot} onEnterAvatar={onEnterAvatar} />}
        {snapshot?.phase === 'acting' && <OfficeNpcForeground snapshot={snapshot} />}
      </svg>
    </div>
  )
}

function OfficeGameNpc({
  snapshot,
  onEnterAvatar,
}: {
  snapshot: OfficeNpcSnapshot
  onEnterAvatar: (avatarId: string) => void
}) {
  const sprite = getOfficeSprite(snapshot.pose)
  const x = Math.round(snapshot.position.x)
  const y = Math.round(snapshot.position.y)
  const scale = snapshot.slot.scale
  const isWalking = snapshot.phase === 'walking'

  const handleEnter = () => onEnterAvatar(snapshot.avatar.id)

  return (
    <g
      className={`office-game-npc office-game-npc--${snapshot.phase} office-game-npc--${snapshot.pose}`}
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-label={`进入「${snapshot.avatar.name}」工作台`}
      onClick={handleEnter}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleEnter()
        }
      }}
    >
      <ellipse className="office-game-npc-shadow" cx="0" cy="-2" rx={22 * scale} ry={6 * scale} />
      <OfficeGameSprite sprite={sprite} scale={scale} walking={isWalking} />
      <g className="office-game-npc-label">
        <rect x="-78" y="-112" width="156" height="34" rx="4" />
        <text x="0" y="-99" textAnchor="middle" className="office-game-npc-label-name">
          {shortNpcName(snapshot.avatar.name)}
        </text>
        <text x="0" y="-86" textAnchor="middle" className="office-game-npc-label-status">
          {snapshot.status}
        </text>
      </g>
    </g>
  )
}

function OfficeNpcForeground({ snapshot }: { snapshot: OfficeNpcSnapshot }) {
  const clipId = useId()

  if (snapshot.pose === 'sit_work') {
    return (
      <g className="office-game-foreground office-game-foreground--desk" clipPath={`url(#${clipId})`}>
        <defs>
          <clipPath id={clipId}>
            <path d="M 132 428 L 430 428 L 456 500 L 120 500 Z" />
          </clipPath>
        </defs>
        <image href={officeBackground} x="0" y="0" width="1080" height="780" preserveAspectRatio="none" />
      </g>
    )
  }

  if (snapshot.pose === 'sit_sofa') {
    return (
      <g className="office-game-foreground office-game-foreground--sofa" clipPath={`url(#${clipId})`}>
        <defs>
          <clipPath id={clipId}>
            <path d="M 216 592 L 438 592 L 468 650 L 184 650 Z" />
          </clipPath>
        </defs>
        <image href={officeBackground} x="0" y="0" width="1080" height="780" preserveAspectRatio="none" />
      </g>
    )
  }

  if (snapshot.pose === 'sit_meeting') {
    return (
      <g className="office-game-foreground office-game-foreground--meeting" clipPath={`url(#${clipId})`}>
        <defs>
          <clipPath id={clipId}>
            <path d="M 552 500 L 798 500 L 826 560 L 520 560 Z" />
          </clipPath>
        </defs>
        <image href={officeBackground} x="0" y="0" width="1080" height="780" preserveAspectRatio="none" />
      </g>
    )
  }

  if (snapshot.pose === 'sit_rest') {
    return (
      <g className="office-game-foreground office-game-foreground--chair" clipPath={`url(#${clipId})`}>
        <defs>
          <clipPath id={clipId}>
            <path d="M 760 532 L 846 532 L 864 560 L 734 560 Z" />
          </clipPath>
        </defs>
        <image href={officeBackground} x="0" y="0" width="1080" height="780" preserveAspectRatio="none" />
      </g>
    )
  }

  return null
}

function OfficeGameSprite({
  sprite,
  scale,
  walking,
}: {
  sprite: OfficeSpriteDefinition
  scale: number
  walking: boolean
}) {
  const clipId = useId()
  const imageX = -sprite.anchorX + (sprite.offsetX ?? 0)
  const imageY = -sprite.anchorY + (sprite.offsetY ?? 0)
  const clipPath = sprite.crop ? `url(#${clipId})` : undefined

  return (
    <g className="office-game-sprite-wrap" transform={`scale(${scale})`}>
      {sprite.crop && (
        <defs>
          <clipPath id={clipId}>
            <rect x={imageX} y={imageY + sprite.crop.top} width={sprite.width} height={sprite.crop.height} />
          </clipPath>
        </defs>
      )}
      <g clipPath={clipPath}>
        {sprite.frames.map((frame, index) => (
          <svg
            key={`${frame.x}-${frame.y}`}
            x={imageX}
            y={imageY}
            width={sprite.width}
            height={sprite.height}
            viewBox={`${frame.x} ${frame.y} ${sprite.width} ${sprite.height}`}
            overflow="hidden"
            className={`office-game-sprite-frame office-game-sprite-frame--${index} ${sprite.frameClass}${walking ? ' office-game-sprite-frame--walk-cycle' : ''}`}
          >
            <image href={sprite.sheet} x="0" y="0" width={sprite.sheetWidth} height={sprite.sheetHeight} />
          </svg>
        ))}
      </g>
    </g>
  )
}

function shortNpcName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '小猪'
  return trimmed.length > 8 ? `${trimmed.slice(0, 8)}...` : trimmed
}
