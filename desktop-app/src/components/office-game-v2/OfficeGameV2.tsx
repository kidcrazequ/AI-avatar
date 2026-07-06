import { useEffect, useMemo, useRef } from 'react'
import {
  getNpcSnapshot,
  getNpcSnapshots,
  getStaticNpcSnapshot,
  OFFICE_GAME_WORLD,
  type NpcSnapshot,
} from './officeGameV2Model'
import { OFFICE_GAME_MAP } from './officeGameV2Map'
import { getSpriteDefinition } from './officeGameV2Sprites'

type OfficeGameV2Props = {
  avatars: Avatar[]
  activeAvatarId?: string
  onEnterAvatar: (avatarId: string) => void
}

type LoadedImages = {
  mapBack: HTMLImageElement
  mapFront: HTMLImageElement
  spriteSheet: HTMLImageElement
}

type StageRect = {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  scale: number
}

const NPC_SCALE = 1.1

export default function OfficeGameV2({ avatars, activeAvatarId, onEnterAvatar }: OfficeGameV2Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastNpcsRef = useRef<NpcSnapshot[]>([])
  const gameAvatars = useMemo(() => avatars.slice(0, 4), [avatars])
  const primaryAvatar = useMemo(
    () => avatars.find((avatar) => avatar.id === activeAvatarId) ?? avatars[0] ?? null,
    [activeAvatarId, avatars],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let disposed = false
    let frameId = 0
    let stage: StageRect = { x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0, scale: 1 }
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const loadImages = async (): Promise<LoadedImages> => {
      const [mapBack, mapFront, spriteSheet] = await Promise.all([
        loadImage(OFFICE_GAME_MAP.layers.back),
        loadImage(OFFICE_GAME_MAP.layers.front),
        loadImage(getSpriteDefinition('idle_front').imageUrl),
      ])
      return { mapBack, mapFront, spriteSheet }
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const scale = Math.max(rect.width / OFFICE_GAME_WORLD.width, rect.height / OFFICE_GAME_WORLD.height)
      const width = OFFICE_GAME_WORLD.width * scale
      const height = OFFICE_GAME_WORLD.height * scale
      stage = {
        x: (rect.width - width) / 2,
        y: (rect.height - height) / 2,
        width,
        height,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        scale,
      }
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    resize()

    const handleClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const screenX = event.clientX - rect.left
      const screenY = event.clientY - rect.top
      let target: NpcSnapshot | null = null
      let targetDistance = Number.POSITIVE_INFINITY

      for (const npc of lastNpcsRef.current) {
        const npcX = stage.x + npc.point.x * stage.scale
        const npcY = stage.y + npc.point.y * stage.scale
        const distance = Math.hypot(screenX - npcX, screenY - npcY)
        if (distance < targetDistance) {
          target = npc
          targetDistance = distance
        }
      }

      if (target && targetDistance <= 54 * stage.scale) {
        onEnterAvatar(target.avatar.id)
      }
    }
    canvas.addEventListener('click', handleClick)

    loadImages().then((images) => {
      if (disposed) return
      const startedAt = performance.now()

      const tick = (now: number) => {
        if (disposed) return
        const elapsedMs = now - startedAt
        const walkEnabled = isOfficeGameWalkEnabled()
        const snapshots = isOfficeGameMultiNpcEnabled()
          ? getNpcSnapshots(gameAvatars, activeAvatarId, elapsedMs)
          : primaryAvatar
            ? [walkEnabled ? getNpcSnapshot(primaryAvatar, elapsedMs) : getStaticNpcSnapshot(primaryAvatar)]
            : []
        const focusNpc = snapshots.find((snapshot) => snapshot.avatar.id === activeAvatarId) ?? snapshots[0]
        if (focusNpc) stage = focusStageOnPoint(stage, focusNpc.point)
        lastNpcsRef.current = snapshots
        drawGame(ctx, images, snapshots, elapsedMs, stage, getOfficeGameDebugFlags())
        frameId = window.requestAnimationFrame(tick)
      }

      frameId = window.requestAnimationFrame(tick)
    })

    return () => {
      disposed = true
      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      canvas.removeEventListener('click', handleClick)
    }
  }, [activeAvatarId, gameAvatars, onEnterAvatar, primaryAvatar])

  return <canvas ref={canvasRef} className="office-game-v2-canvas" aria-label="AI 分身像素办公室游戏场景" />
}

function focusStageOnPoint(stage: StageRect, point: { x: number; y: number }): StageRect {
  const x = stage.width <= stage.viewportWidth
    ? (stage.viewportWidth - stage.width) / 2
    : clamp(stage.viewportWidth / 2 - point.x * stage.scale, stage.viewportWidth - stage.width, 0)
  const y = stage.height <= stage.viewportHeight
    ? (stage.viewportHeight - stage.height) / 2
    : clamp(stage.viewportHeight / 2 - point.y * stage.scale, stage.viewportHeight - stage.height, 0)

  return {
    ...stage,
    x,
    y,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

type OfficeGameDebugFlags = {
  labels: boolean
  geometry: boolean
  routes: boolean
}

function getOfficeGameDebugFlags(): OfficeGameDebugFlags {
  try {
    const params = new URLSearchParams(window.location.search)
    return {
      labels: params.get('officeGameDebug') === '1' || window.localStorage.getItem('soul:office-game-debug') === '1',
      geometry: params.get('officeGameGeometryDebug') === '1' || window.localStorage.getItem('soul:office-game-geometry-debug') === '1',
      routes: isOfficeGameFlagEnabled('officeGameRoutes', 'soul:office-game-routes'),
    }
  } catch {
    return {
      labels: false,
      geometry: false,
      routes: false,
    }
  }
}

function isOfficeGameMultiNpcEnabled(): boolean {
  return isOfficeGameFlagEnabled('officeGameMultiNpc', 'soul:office-game-multi-npc')
}

function isOfficeGameWalkEnabled(): boolean {
  return isOfficeGameFlagEnabled('officeGameWalk', 'soul:office-game-walk')
}

function isOfficeGameFlagEnabled(queryName: string, storageName: string): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    const queryValue = params.get(queryName)
    if (queryValue === '1') return true
    if (queryValue === '0') return false
    return window.localStorage.getItem(storageName) === '1'
  } catch {
    return false
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`图片加载失败：${src}`))
    image.src = src
  })
}

function drawGame(
  ctx: CanvasRenderingContext2D,
  images: LoadedImages,
  snapshots: NpcSnapshot[],
  elapsedMs: number,
  stage: StageRect,
  debug: OfficeGameDebugFlags,
) {
  const canvas = ctx.canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#1d2430'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.translate(stage.x, stage.y)
  ctx.scale(stage.scale, stage.scale)

  drawMapBack(ctx, images)
  if (debug.geometry) drawDebugGeometry(ctx)
  if (debug.labels) drawDebugRoutesAndPoints(ctx, debug.routes)
  for (const snapshot of [...snapshots].sort((a, b) => a.point.y - b.point.y)) {
    drawNpc(ctx, images.spriteSheet, snapshot, elapsedMs)
  }
  drawMapFront(ctx, images)
  if (debug.labels) drawDebugOverlay(ctx, snapshots)

  ctx.restore()
}

function drawMapBack(ctx: CanvasRenderingContext2D, images: LoadedImages) {
  ctx.drawImage(images.mapBack, 0, 0, OFFICE_GAME_WORLD.width, OFFICE_GAME_WORLD.height)
}

function drawNpc(ctx: CanvasRenderingContext2D, spriteSheet: HTMLImageElement, snapshot: NpcSnapshot, elapsedMs: number) {
  const sprite = getSpriteDefinition(snapshot.pose)
  const frameMs = snapshot.phase === 'walking' ? 160 : 300
  const frameIndex = sprite.frames.length > 0 ? Math.floor(elapsedMs / frameMs) % sprite.frames.length : 0
  const frame = sprite.frames[frameIndex] ?? sprite.frames[0]
  const x = Math.round(snapshot.point.x)
  const y = Math.round(snapshot.point.y)

  if (!frame) return

  ctx.save()
  ctx.translate(x, y)
  if (snapshot.pose !== 'sit_work') {
    ctx.fillStyle = snapshot.phase === 'walking' ? 'rgba(0,0,0,0.20)' : 'rgba(0,0,0,0.16)'
    ctx.beginPath()
    ctx.ellipse(0, -2, 20 * NPC_SCALE, 5 * NPC_SCALE, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.scale(NPC_SCALE, NPC_SCALE)
  ctx.drawImage(
    spriteSheet,
    frame.sx,
    frame.sy,
    frame.sw,
    frame.sh,
    -sprite.anchorX,
    -sprite.anchorY,
    sprite.frameWidth,
    sprite.frameHeight,
  )
  ctx.restore()
}

function drawMapFront(ctx: CanvasRenderingContext2D, images: LoadedImages) {
  ctx.drawImage(images.mapFront, 0, 0, OFFICE_GAME_WORLD.width, OFFICE_GAME_WORLD.height)
}

function drawDebugGeometry(ctx: CanvasRenderingContext2D) {
  ctx.save()
  ctx.lineWidth = 2

  for (const zone of OFFICE_GAME_MAP.walkableZones) {
    drawPolygon(ctx, zone.polygon, 'rgba(62, 186, 110, 0.12)', 'rgba(45, 142, 85, 0.55)')
  }

  for (const zone of OFFICE_GAME_MAP.collisionZones) {
    drawPolygon(ctx, zone.polygon, 'rgba(224, 76, 67, 0.14)', 'rgba(173, 48, 42, 0.55)')
  }

  ctx.restore()
}

function drawDebugRoutesAndPoints(ctx: CanvasRenderingContext2D, showRoutes: boolean) {
  ctx.save()
  if (showRoutes) {
    ctx.setLineDash([8, 8])
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255, 229, 133, 0.62)'
    for (const route of OFFICE_GAME_MAP.routes) {
      ctx.beginPath()
      route.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  for (const interaction of Object.values(OFFICE_GAME_MAP.interactionPoints)) {
    const marker = interaction.markerPoint ?? interaction.actionPoint
    ctx.fillStyle = interaction.kind === 'seat' ? 'rgba(83, 156, 237, 0.14)' : 'rgba(238, 179, 72, 0.16)'
    ctx.strokeStyle = interaction.kind === 'seat' ? 'rgba(58, 120, 196, 0.74)' : 'rgba(190, 124, 27, 0.78)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(marker.x - 16, marker.y)
    ctx.lineTo(marker.x + 16, marker.y)
    ctx.moveTo(marker.x, marker.y - 16)
    ctx.lineTo(marker.x, marker.y + 16)
    ctx.stroke()
    if (interaction.markerPoint) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.44)'
      ctx.setLineDash([4, 5])
      ctx.beginPath()
      ctx.moveTo(marker.x, marker.y)
      ctx.lineTo(interaction.actionPoint.x, interaction.actionPoint.y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    drawDebugAnchor(ctx, interaction.actionPoint, 'rgba(255, 255, 255, 0.78)')
    if (showRoutes) drawDebugAnchor(ctx, interaction.routePoint, 'rgba(255, 216, 102, 0.78)')
    drawDebugText(ctx, interaction.label, marker.x + 14, marker.y - 8)
  }

  ctx.restore()
}

function drawDebugAnchor(ctx: CanvasRenderingContext2D, point: { x: number; y: number }, strokeStyle: string) {
  ctx.save()
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(point.x - 7, point.y)
  ctx.lineTo(point.x + 7, point.y)
  ctx.moveTo(point.x, point.y - 7)
  ctx.lineTo(point.x, point.y + 7)
  ctx.stroke()
  ctx.restore()
}

function drawDebugOverlay(ctx: CanvasRenderingContext2D, snapshots: NpcSnapshot[]) {
  ctx.save()
  for (const snapshot of snapshots) {
    const x = Math.round(snapshot.point.x)
    const y = Math.round(snapshot.point.y)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x - 8, y)
    ctx.lineTo(x + 8, y)
    ctx.moveTo(x, y - 8)
    ctx.lineTo(x, y + 8)
    ctx.stroke()
    drawDebugText(
      ctx,
      `${snapshot.index + 1}:${snapshot.avatar.name ?? snapshot.avatar.id} ${snapshot.pose} ${snapshot.from}->${snapshot.to}`,
      x + 12,
      y + 12,
    )
    drawDebugText(ctx, snapshot.status, x + 12, y + 28)
  }
  ctx.restore()
}

function drawPolygon(
  ctx: CanvasRenderingContext2D,
  polygon: ReadonlyArray<{ x: number; y: number }>,
  fillStyle: string,
  strokeStyle: string,
) {
  if (polygon.length === 0) return
  ctx.fillStyle = fillStyle
  ctx.strokeStyle = strokeStyle
  ctx.beginPath()
  polygon.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

function drawDebugText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = '12px monospace'
  ctx.textBaseline = 'top'
  const width = ctx.measureText(text).width
  ctx.fillStyle = 'rgba(255, 255, 245, 0.86)'
  ctx.fillRect(x - 3, y - 2, width + 6, 16)
  ctx.fillStyle = 'rgba(19, 22, 26, 0.92)'
  ctx.fillText(text, x, y)
}
