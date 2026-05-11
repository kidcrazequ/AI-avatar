/**
 * `life/generator` 单元测试。
 *
 * mock LLM 而非发真请求；覆盖：
 *   - Stage 0 → 3 全 Pipeline 跑完，落盘 manifest / timeline / 80 个 episodes / consolidated
 *   - 断点续传：Stage 2 中途模拟"已完成 N 个 episode"，重启只生成剩余的
 *   - fallback：creationConfigured=false → progress.usedFallback=true
 *   - cancel：abortSignal 在 Stage 2 中途取消，已完成的 episode 不丢
 *   - generateEpisode：Phase 2 grower 复用入口的独立单测
 *   - partitionAgeStages：年龄段切分边界
 *   - JSON 解析容错：LLM 加 markdown 代码块包装也能解析
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  generateEpisode,
  generateLife,
  partitionAgeStages,
} from '../life/generator'
import type { LifeLLMConfig, LifeUserParams } from '../life/generator'
import {
  listLifeEpisodeIds,
  readLifeConsolidated,
  readLifeManifest,
  readLifeProgress,
  readLifeTimeline,
  writeLifeEpisode,
  writeLifeManifest,
  writeLifeProgress,
  writeLifeTimeline,
} from '../life/store'
import type { LifeManifest, LifeProgress, LifeTimelineEntry } from '../life/types'

// ─── mock LLM 工厂 ──────────────────────────────────────────────────────────

const AVATAR_ID = 'test-avatar'

interface MockLLMFactoryOptions {
  /** 故意失败的 episode id 集合（Stage 2 时返回错误） */
  failEpisodeIds?: Set<string>
  /** 调用计数器（外部可读取） */
  counter?: { creation: number; chat: number }
  /** 监听每次调用，便于断言 abort 行为 */
  onCall?: (channel: 'creation' | 'chat', system: string, user: string) => void
}

/**
 * 构造一个完整的 mock LLMConfig：能正确响应 manifest / outline / episode / consolidated。
 * 通过 system/user prompt 的关键词区分阶段。
 */
function makeMockLLMs(opts: MockLLMFactoryOptions = {}): LifeLLMConfig {
  const counter = opts.counter ?? { creation: 0, chat: 0 }
  const fail = opts.failEpisodeIds ?? new Set<string>()

  const handler = (channel: 'creation' | 'chat') =>
    async (system: string, user: string): Promise<string> => {
      if (channel === 'creation') counter.creation += 1
      else counter.chat += 1
      opts.onCall?.(channel, system, user)

      if (system.includes('人生设计师')) {
        return JSON.stringify({
          personaName: '陈默',
          birthYear: 1991,
          birthMonth: 8,
          birthDay: 15,
          gender: '男',
          birthplace: '湖北十堰',
          familyBackground: '父亲是机械厂工程师，母亲是中学教师。家里堆满旧报纸和拆开一半的收音机。'.repeat(3),
          personalityArc: [
            { age: 7, shift: '从胆小转向好奇' },
            { age: 14, shift: '建立独立判断' },
            { age: 22, shift: '直面失败' },
            { age: 30, shift: '学会克制' },
          ],
          professionalSpine: [
            { age: 12, milestone: '第一次拆收音机' },
            { age: 20, milestone: '设计第一个产品' },
            { age: 28, milestone: '建立工程方法论' },
          ],
          majorRelationships: [
            { role: '祖父', name: '陈守诚', description: '退休铁路工人' },
            { role: '母亲', name: '李雅琴', description: '中学语文老师' },
            { role: '挚友', name: '林子明', description: '大学室友' },
          ],
        })
      }

      if (system.includes('人生编剧')) {
        // Stage 1：从 prompt 里抽 targetCount
        const m = user.match(/列出\s*(\d+)\s*个事件/)
        const target = m ? parseInt(m[1], 10) : 10
        const ageMatch = user.match(/(\d+)-(\d+)\s*岁阶段/)
        const ageFrom = ageMatch ? parseInt(ageMatch[1], 10) : 0
        const ageTo = ageMatch ? parseInt(ageMatch[2], 10) : 3
        const span = Math.max(1, ageTo - ageFrom)
        const items = Array.from({ length: target }, (_, i) => {
          const age = ageFrom + (i % span)
          return {
            age,
            year: 1991 + age,
            month: ((i % 12) + 1),
            title: `${ageFrom}-${ageTo}岁第${i + 1}件事`,
            summary: '一句话摘要',
            category: ['formative', 'daily', 'professional', 'joy'][i % 4],
            themes: ['好奇心', '机械'],
            importance: 5 + (i % 5),
            emotion: 4 + (i % 6),
            emotionType: ['wonder', 'joy', 'sorrow', 'love'][i % 4],
          }
        })
        return '```json\n' + JSON.stringify(items) + '\n```' // 测试代码块包装解析
      }

      if (system.includes('传记作者')) {
        // Stage 2：根据 prompt 里的 entry id 决定是否失败
        const idMatch = user.match(/事件「([^」]+)」/)
        const title = idMatch ? idMatch[1] : ''
        for (const id of fail) {
          if (id.includes(title) || title.includes(id)) {
            throw new Error(`mock LLM 故意失败: ${title}`)
          }
        }
        return `那是一个夏天的下午，我趴在地板上盯着收音机。\n${title} 的具体情景。\n` + '细节铺陈正文。'.repeat(50)
      }

      if (system.includes('深夜独白')) {
        return '## 机械的味道\n那种铁锈和电流的气味，我记到现在。\n\n## 祖父的沉默\n他从不解释，只让我自己拆。'
      }

      throw new Error(`mock LLM 未识别的 prompt: system=${system.slice(0, 60)}`)
    }

  return {
    creationLLM: handler('creation'),
    chatLLM: handler('chat'),
    creationConfigured: true,
  }
}

const FIXED_NOW = new Date('2026-05-09T03:00:00Z')

function makeUserParams(overrides: Partial<LifeUserParams> = {}): LifeUserParams {
  return {
    currentAge: 35,
    timeScale: 1,
    growthEnabled: true,
    extraHints: '',
    ...overrides,
  }
}

// ─── 测试主体 ──────────────────────────────────────────────────────────────

describe('life-generator', () => {
  let tmpRoot: string

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-life-gen-test-'))
  })

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    const caseDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'))
    fs.mkdirSync(path.join(caseDir, AVATAR_ID), { recursive: true })
    // 写一个简单的 soul.md / avatar.txt 让 generator 能读到
    fs.writeFileSync(path.join(caseDir, AVATAR_ID, 'soul.md'), '# 测试分身\n## Identity\n我是测试分身。')
    fs.writeFileSync(path.join(caseDir, AVATAR_ID, 'avatar.txt'), '一个用于测试 generator 的分身。')
    tmpRoot = caseDir
  })

  // ─── partitionAgeStages 边界 ───────────────────────────────────────────

  describe('partitionAgeStages', () => {
    it('35 岁切分为 6 段，覆盖 0-35', () => {
      const stages = partitionAgeStages(35)
      assert.ok(stages.length >= 5, `应有至少 5 段，实际 ${stages.length}`)
      assert.equal(stages[0].from, 0)
      assert.equal(stages[stages.length - 1].to, 35)
    })

    it('20 岁时不会越界', () => {
      const stages = partitionAgeStages(20)
      const lastTo = stages[stages.length - 1].to
      assert.ok(lastTo <= 20, `last.to=${lastTo} 不能超过 currentAge`)
    })
  })

  // ─── 全 Pipeline 跑通 ──────────────────────────────────────────────────

  describe('generateLife 全流程', () => {
    it('小规模（currentAge=10）能跑完 4 个 Stage 并落盘', async () => {
      const counter = { creation: 0, chat: 0 }
      const llms = makeMockLLMs({ counter })
      const params = makeUserParams({ currentAge: 10 })

      const progressLog: LifeProgress[] = []
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: params,
        llms,
        onProgress: (p) => progressLog.push(p),
        now: () => FIXED_NOW,
      })

      const manifest = await readLifeManifest(tmpRoot, AVATAR_ID)
      assert.ok(manifest)
      assert.equal(manifest.generationStatus, 'complete')
      assert.equal(manifest.displayName, '测试')
      assert.equal(manifest.personaName, '测试')
      assert.equal(manifest.realNameConfirmed, false)
      assert.equal(manifest.nameSource, 'avatarName')
      assert.equal(manifest.timeScale, 1)

      const timeline = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.ok(timeline.length > 0, '应至少生成一些事件')

      const episodeIds = await listLifeEpisodeIds(tmpRoot, AVATAR_ID)
      assert.equal(episodeIds.length, timeline.length, '每个 timeline 条目都应有 episode 文件')

      const consolidated = await readLifeConsolidated(tmpRoot, AVATAR_ID)
      assert.ok(consolidated.length > 0)
      assert.ok(consolidated.includes('# '), 'consolidated.md 应有主标题')

      const finalProgress = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.ok(finalProgress)
      assert.equal(finalProgress.stage, 'complete')
      assert.equal(finalProgress.lastError, '')
      assert.equal(finalProgress.failedEpisodes.length, 0)

      // 进度回调每个 stage 至少推一次
      const stages = new Set(progressLog.map(p => p.stage))
      assert.ok(stages.has('manifest'))
      assert.ok(stages.has('outline'))
      assert.ok(stages.has('episodes'))
      assert.ok(stages.has('forgetting'))
      assert.ok(stages.has('complete'))

      // 至少调过 creation LLM（因为 creationConfigured=true）
      assert.ok(counter.creation > 0)
      assert.equal(counter.chat, 0, 'creationConfigured=true 时不应该调用 chat LLM')
    })

    it('用户确认真实姓名时才允许覆盖分身展示名', async () => {
      const llms = makeMockLLMs()
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '小堵',
        userParams: makeUserParams({
          currentAge: 10,
          personaName: '杜明',
          personaNameConfirmed: true,
          nameSource: 'user',
        }),
        llms,
        now: () => FIXED_NOW,
      })

      const manifest = await readLifeManifest(tmpRoot, AVATAR_ID)
      assert.ok(manifest)
      assert.equal(manifest.displayName, '小堵')
      assert.equal(manifest.personaName, '杜明')
      assert.equal(manifest.realNameConfirmed, true)
      assert.equal(manifest.nameSource, 'user')
    })

    it('default:* 头像标识不会作为分身简介进入 Stage 0 prompt', async () => {
      fs.writeFileSync(path.join(tmpRoot, AVATAR_ID, 'avatar.txt'), 'default:data-analyst')
      let manifestPrompt = ''
      const llms = makeMockLLMs({
        onCall: (_ch, system, user) => {
          if (system.includes('人生设计师')) {
            manifestPrompt = user
          }
        },
      })

      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '小堵',
        userParams: makeUserParams({ currentAge: 10 }),
        llms,
        now: () => FIXED_NOW,
      })

      assert.ok(manifestPrompt.includes('## avatar.txt\n（空）'))
      assert.equal(manifestPrompt.includes('default:data-analyst'), false)
    })

    it('Stage 0 返回空人生骨架时应失败，避免继续生成跑偏经历', async () => {
      const llms: LifeLLMConfig = {
        creationConfigured: true,
        creationLLM: async (system: string) => {
          if (system.includes('人生设计师')) {
            return JSON.stringify({
              personaName: '小堵',
              birthYear: 1991,
              birthMonth: 5,
              birthDay: 15,
              gender: '男',
              birthplace: '湖北',
              familyBackground: '',
              personalityArc: [],
              professionalSpine: [],
              majorRelationships: [],
            })
          }
          throw new Error(`不应进入后续阶段: ${system.slice(0, 40)}`)
        },
        chatLLM: async () => 'unused',
      }

      await assert.rejects(
        () => generateLife({
          avatarsRoot: tmpRoot,
          avatarId: AVATAR_ID,
          avatarName: '小堵',
          userParams: makeUserParams({ currentAge: 10 }),
          llms,
          now: () => FIXED_NOW,
        }),
        /人生骨架生成失败.*professionalSpine/,
      )

      const progress = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.ok(progress)
      assert.equal(progress.stage, 'failed')
      assert.match(progress.lastError, /人生骨架生成失败/)
    })
  })

  // ─── T1.7 断点续传 ─────────────────────────────────────────────────────

  describe('断点续传 (T1.7)', () => {
    it('Stage 2 中途已落盘的 episode 在续跑时不再调用 LLM', async () => {
      // 先跑一次完整流程拿到 manifest + timeline
      const llms1 = makeMockLLMs()
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms: llms1,
        now: () => FIXED_NOW,
      })

      const timeline = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.ok(timeline.length >= 6)

      // 模拟"曾经在 Stage 2 中途崩溃"：删除 consolidated.md，把 progress 重置到 episodes 阶段
      // 并删掉一半的 episode 文件
      fs.unlinkSync(path.join(tmpRoot, AVATAR_ID, 'life', 'consolidated.md'))
      const halfPoint = Math.floor(timeline.length / 2)
      const toDelete = timeline.slice(halfPoint)
      for (const entry of toDelete) {
        fs.unlinkSync(path.join(tmpRoot, AVATAR_ID, 'life', 'episodes', `${entry.id}.md`))
      }
      const halfDoneProgress: LifeProgress = {
        stage: 'episodes',
        completedEpisodes: halfPoint,
        totalEpisodes: timeline.length,
        usedFallback: false,
        lastError: '',
        updatedAt: FIXED_NOW.toISOString(),
        failedEpisodes: [],
        consolidationLastTotalEpisodes: 0,
      }
      await writeLifeProgress(tmpRoot, AVATAR_ID, halfDoneProgress)

      // 用新 mock 跑续传，记录被实际调用的 episode
      const titlesAskedFor: string[] = []
      const llms2 = makeMockLLMs({
        onCall: (_ch, sys, user) => {
          if (sys.includes('传记作者')) {
            const m = user.match(/事件「([^」]+)」/)
            if (m) titlesAskedFor.push(m[1])
          }
        },
      })

      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms: llms2,
        now: () => FIXED_NOW,
      })

      // 续跑只应该问 LLM 写后半段
      assert.equal(titlesAskedFor.length, toDelete.length,
        `期望调 ${toDelete.length} 次 episode LLM, 实际 ${titlesAskedFor.length}`)
      // 标题应来自后半段
      const expectedTitles = new Set(toDelete.map(e => e.title))
      for (const asked of titlesAskedFor) {
        assert.ok(expectedTitles.has(asked), `不该重新生成已存在的 ${asked}`)
      }

      // 最终所有 episode 都齐
      const finalIds = await listLifeEpisodeIds(tmpRoot, AVATAR_ID)
      assert.equal(finalIds.length, timeline.length)
    })

    it('progress.stage=complete 时直接返回不再调用 LLM', async () => {
      // 先跑完一遍
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms: makeMockLLMs(),
        now: () => FIXED_NOW,
      })

      // 第二次跑应零调用
      const counter = { creation: 0, chat: 0 }
      const llms2 = makeMockLLMs({ counter })
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms: llms2,
        now: () => FIXED_NOW,
      })
      assert.equal(counter.creation, 0)
      assert.equal(counter.chat, 0)
    })
  })

  // ─── T1.8 fallback ──────────────────────────────────────────────────────

  describe('creationModel fallback (T1.8)', () => {
    it('creationConfigured=false → 走 chatLLM 且 progress.usedFallback=true', async () => {
      const counter = { creation: 0, chat: 0 }
      const baseLLMs = makeMockLLMs({ counter })
      const llms: LifeLLMConfig = {
        creationLLM: baseLLMs.creationLLM,
        chatLLM: baseLLMs.chatLLM,
        creationConfigured: false,
      }
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms,
        now: () => FIXED_NOW,
      })

      assert.equal(counter.creation, 0, '不该调创作模型')
      assert.ok(counter.chat > 0, '应调对话模型')

      const progress = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.ok(progress)
      assert.equal(progress.usedFallback, true)
    })

    it('creationConfigured=true → 不打 fallback 标', async () => {
      const llms = makeMockLLMs()
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms,
        now: () => FIXED_NOW,
      })
      const progress = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.ok(progress)
      assert.equal(progress.usedFallback, false)
    })
  })

  // ─── 取消 ──────────────────────────────────────────────────────────────

  describe('abortSignal 取消', () => {
    it('Stage 2 中途取消应抛 AbortError，已落盘 episode 保留', async () => {
      // 自定义 mock：第 1 个 episode 同步完成；后续 episodes 在 await 之后触发 abort，
      // 给第 1 个 episode 留出 microtask + fs.writeFile 时间，确保至少 1 个落盘。
      const ac = new AbortController()
      let stage2Calls = 0
      const llms: LifeLLMConfig = {
        creationConfigured: true,
        creationLLM: async (system: string, user: string) => {
          if (system.includes('人生设计师')) {
            return JSON.stringify({
              personaName: '陈默',
              birthYear: 2016,
              birthMonth: 5,
              birthDay: 15,
              gender: '男',
              birthplace: '湖北',
              familyBackground: '父亲是机械厂工程师，母亲是中学教师。家里堆满旧报纸和拆开一半的收音机。'.repeat(3),
              personalityArc: [
                { age: 1, shift: '从安静观察转向主动探索' },
                { age: 2, shift: '开始对物件结构产生好奇' },
                { age: 3, shift: '学会表达自己的判断' },
                { age: 4, shift: '面对陌生环境更稳定' },
              ],
              professionalSpine: [
                { age: 1, milestone: '第一次被机械声音吸引' },
                { age: 2, milestone: '观察父亲修理小家电' },
                { age: 3, milestone: '尝试拼装简单积木结构' },
              ],
              majorRelationships: [
                { role: '父亲', name: '陈建国', description: '机械厂工程师，常在家修理旧设备。' },
                { role: '母亲', name: '李雅琴', description: '中学教师，重视耐心表达和事实核对。' },
                { role: '邻居', name: '王师傅', description: '退休电工，常讲设备安全和用电常识。' },
              ],
            })
          }
          if (system.includes('人生编剧')) {
            const m = user.match(/列出\s*(\d+)\s*个事件/)
            const target = m ? parseInt(m[1], 10) : 4
            const items = Array.from({ length: target }, (_, i) => ({
              age: i, year: 2016 + i, month: 1,
              title: `事件${i}`, summary: 's',
              category: 'daily', themes: [], importance: 5,
              emotion: 5, emotionType: 'wonder',
            }))
            return JSON.stringify(items)
          }
          if (system.includes('传记作者')) {
            const myIdx = ++stage2Calls
            if (myIdx === 1) {
              // 第 1 个：sync return，让其在 abort 之前完成写盘
              return '正文'.repeat(100)
            }
            // 后续调用：等 50ms 让第 1 个 episode 完整 writeFile，再 abort
            await new Promise<void>(resolve => setTimeout(resolve, 50))
            if (!ac.signal.aborted) ac.abort()
            return '正文'.repeat(100)
          }
          if (system.includes('深夜独白')) {
            return '回忆'
          }
          throw new Error(`unexpected: ${system.slice(0, 40)}`)
        },
        chatLLM: async () => 'unused',
      }

      let caught: unknown = null
      try {
        await generateLife({
          avatarsRoot: tmpRoot,
          avatarId: AVATAR_ID,
          avatarName: '测试',
          userParams: makeUserParams({ currentAge: 4 }),
          llms,
          now: () => FIXED_NOW,
          abortSignal: ac.signal,
        })
      } catch (err) {
        caught = err
      }
      assert.ok(caught instanceof Error)
      assert.equal((caught as Error).name, 'AbortError')

      // 至少已经落盘的 episode 应保留
      const ids = await listLifeEpisodeIds(tmpRoot, AVATAR_ID)
      assert.ok(ids.length >= 1, `期望至少 1 个 episode 已落盘，实际 ${ids.length}`)
    })
  })

  // ─── generateEpisode 单事件 ───────────────────────────────────────────

  describe('generateEpisode (Phase 2 grower 复用)', () => {
    it('给定 manifest + timeline + entry 能产出非空 LifeEpisode', async () => {
      const manifest: LifeManifest = {
        schemaVersion: 1,
        displayName: '测试',
        personaName: '陈默',
        realNameConfirmed: true,
        nameSource: 'user',
        birthYear: 1991,
        birthMonth: 8,
        birthDay: 15,
        initialAge: 35,
        initialAgeBornAt: FIXED_NOW.toISOString(),
        timeScale: 1,
        lastAdvancedAt: FIXED_NOW.toISOString(),
        currentAgeMonths: 420,
        growthEnabled: true,
        gender: '男',
        birthplace: '湖北十堰',
        familyBackground: '一个普通家庭。',
        personalityArc: [],
        professionalSpine: [],
        majorRelationships: [],
        createdAt: '2026-05-09',
        totalEpisodes: 0,
        totalChars: 0,
        generationStatus: 'generating',
        lastConsolidatedAt: FIXED_NOW.toISOString(),
        consolidationCounter: 0,
      }
      const timeline: LifeTimelineEntry[] = [{
        id: 'ep-0001-test',
        age: 7,
        year: 1998,
        month: 6,
        title: '第一次拆收音机',
        summary: '童年好奇心',
        category: 'formative',
        themes: ['机械'],
        importance: 8,
        emotion: 7,
        emotionType: 'wonder',
        wordCount: 0,
        consolidationStatus: 'remembered',
        consolidationNote: '',
      }]

      const llms = makeMockLLMs()
      const ep = await generateEpisode({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        manifest,
        timeline,
        entry: timeline[0],
        callLLM: llms.creationLLM,
      })
      assert.equal(ep.id, 'ep-0001-test')
      assert.ok(ep.content.length > 50)
    })
  })

  // ─── 失败 episode 标记 ────────────────────────────────────────────────

  describe('Stage 2 单事件失败处理', () => {
    it('某个 episode 失败应记到 progress.failedEpisodes，不阻塞其他', async () => {
      // 准备：先跑 Stage 0+1 拿到 timeline，确定要"故意失败"的 id
      // 简化：先跑一次完整流程，然后清掉一半 episode 文件，再"故意"让其中一个失败
      const fullLLMs = makeMockLLMs()
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms: fullLLMs,
        now: () => FIXED_NOW,
      })

      const timeline = await readLifeTimeline(tmpRoot, AVATAR_ID)
      const victimEntry = timeline[0]
      // 删该 episode + 重置 progress 到 episodes 阶段
      fs.unlinkSync(path.join(tmpRoot, AVATAR_ID, 'life', 'episodes', `${victimEntry.id}.md`))
      fs.unlinkSync(path.join(tmpRoot, AVATAR_ID, 'life', 'consolidated.md'))
      await writeLifeProgress(tmpRoot, AVATAR_ID, {
        stage: 'episodes',
        completedEpisodes: timeline.length - 1,
        totalEpisodes: timeline.length,
        usedFallback: false,
        lastError: '',
        updatedAt: FIXED_NOW.toISOString(),
        failedEpisodes: [],
        consolidationLastTotalEpisodes: 0,
      })

      const failingLLMs = makeMockLLMs({ failEpisodeIds: new Set([victimEntry.title]) })
      await generateLife({
        avatarsRoot: tmpRoot,
        avatarId: AVATAR_ID,
        avatarName: '测试',
        userParams: makeUserParams({ currentAge: 10 }),
        llms: failingLLMs,
        now: () => FIXED_NOW,
      })

      const progress = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.ok(progress)
      // failedEpisodes 至少含 victim
      const hasVictim = progress.failedEpisodes.some(f => f.id === victimEntry.id)
      assert.ok(hasVictim, '失败 episode 应记入 failedEpisodes')
      // 全流程仍能走完到 complete（失败不阻塞）
      assert.equal(progress.stage, 'complete')
    })
  })
})
