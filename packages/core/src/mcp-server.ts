/**
 * @file Soul MCP server — 把分身的知识/技能 read-only 暴露给外部 Claude Code
 *
 * 借鉴 colbymchenry/codegraph：用 MCP stdio 暴露已索引的资源，避免外部消费方
 * 重新建索引。Soul 这边的资源是 KnowledgeRetriever（BM25/RRF chunk）、
 * KnowledgeManager（文件树）、AvatarManager（分身元数据）、SkillManager（技能列表）。
 *
 * 设计原则：
 *   - read-only：暴露 list/get/search，不暴露 write/execute（写操作 + 技能执行
 *     涉及 LLM/副作用，留给后续切片）
 *   - 复用现成实现：不在 server 里重写检索逻辑，直接 new KnowledgeRetriever
 *   - coverage 透传：search_chunks 把 [coverage:xxx] 头部一起返给消费方，让外部
 *     LLM 也能识别 empty/low 召回信号而不是闷头编答案
 *   - 路径安全：所有 avatarId 走 assertSafeSegment，禁止 ../ 注入
 *
 * @author zhi.qu
 * @date 2026-05-25
 */

import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AvatarManager } from './avatar-manager'
import { KnowledgeManager } from './knowledge-manager'
import { KnowledgeRetriever } from './knowledge-retriever'
import { SkillManager } from './skill-manager'
import { assertSafeSegment } from './utils/path-security'

export interface SoulMcpServerOptions {
  /** 分身根目录绝对路径（如 /path/to/soul/avatars） */
  avatarsPath: string
  /** 模板目录绝对路径，AvatarManager 需要（默认 avatarsPath/../templates） */
  templatesPath?: string
  /** server 在 listTools 暴露的服务标识，默认 'soul' */
  serverName?: string
  /** server 版本，默认 '1.0.0' */
  serverVersion?: string
}

/**
 * 构造 Soul MCP server。
 * 返回未连接 transport 的 McpServer 实例，由调用方决定 stdio / http 接入。
 */
export function buildSoulMcpServer(options: SoulMcpServerOptions): McpServer {
  const avatarsPath = path.resolve(options.avatarsPath)
  const templatesPath = path.resolve(
    options.templatesPath ?? path.join(avatarsPath, '..', 'templates'),
  )
  if (!fs.existsSync(avatarsPath)) {
    throw new Error(`avatarsPath 不存在：${avatarsPath}`)
  }

  const avatarManager = new AvatarManager(avatarsPath, templatesPath)
  const skillManager = new SkillManager(avatarsPath)
  // KnowledgeManager / KnowledgeRetriever 是 per-avatar 的（每个分身一份 knowledge/），
  // 用 LRU-less 简单缓存就够 —— MCP server 进程通常短命且单分身访问聚簇。
  const knowledgeManagerCache = new Map<string, KnowledgeManager>()
  const knowledgeRetrieverCache = new Map<string, KnowledgeRetriever>()

  function getKnowledgeManager(avatarId: string): KnowledgeManager {
    assertSafeSegment(avatarId, '分身ID')
    let km = knowledgeManagerCache.get(avatarId)
    if (!km) {
      km = new KnowledgeManager(path.join(avatarsPath, avatarId, 'knowledge'))
      knowledgeManagerCache.set(avatarId, km)
    }
    return km
  }

  function getKnowledgeRetriever(avatarId: string): KnowledgeRetriever {
    assertSafeSegment(avatarId, '分身ID')
    let kr = knowledgeRetrieverCache.get(avatarId)
    if (!kr) {
      kr = new KnowledgeRetriever(path.join(avatarsPath, avatarId, 'knowledge'))
      knowledgeRetrieverCache.set(avatarId, kr)
    }
    return kr
  }

  const server = new McpServer({
    name: options.serverName ?? 'soul',
    version: options.serverVersion ?? '1.0.0',
  })

  // ── 1. soul_list_avatars ──────────────────────────────────────
  server.registerTool(
    'soul_list_avatars',
    {
      description:
        '列出当前 Soul 仓库下所有分身（avatar）。返回 id / name / description / createdAt。' +
        '用于外部消费方先发现有哪些分身可用，再调 soul_search_chunks/get_avatar 进一步操作。',
      inputSchema: {},
    },
    () => {
      const avatars = avatarManager.listAvatars().map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        createdAt: new Date(a.createdAt).toISOString(),
      }))
      return {
        content: [{ type: 'text', text: JSON.stringify(avatars, null, 2) }],
      }
    },
  )

  // ── 2. soul_get_avatar ────────────────────────────────────────
  server.registerTool(
    'soul_get_avatar',
    {
      description:
        '获取指定分身的元数据 + soul.md / CLAUDE.md 内容片段（各前 4KB）。' +
        '用于外部消费方了解分身的人格定位、知识库约束、调用风格。',
      inputSchema: {
        avatarId: z.string().describe('分身 ID（avatars/ 下的目录名）'),
      },
    },
    ({ avatarId }) => {
      assertSafeSegment(avatarId, '分身ID')
      const avatarDir = path.join(avatarsPath, avatarId)
      if (!fs.existsSync(avatarDir)) {
        return {
          content: [{ type: 'text', text: `分身不存在：${avatarId}` }],
          isError: true,
        }
      }
      const readSnippet = (rel: string, maxBytes = 4096): string | null => {
        const p = path.join(avatarDir, rel)
        if (!fs.existsSync(p)) return null
        const buf = fs.readFileSync(p)
        return buf.subarray(0, maxBytes).toString('utf-8')
      }
      const payload = {
        id: avatarId,
        soulMd: readSnippet('soul.md'),
        claudeMd: readSnippet('CLAUDE.md'),
        hasKnowledge: fs.existsSync(path.join(avatarDir, 'knowledge')),
        hasSkills: fs.existsSync(path.join(avatarDir, 'skills')),
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      }
    },
  )

  // ── 3. soul_search_chunks ─────────────────────────────────────
  server.registerTool(
    'soul_search_chunks',
    {
      description:
        '在指定分身的知识库做 chunk 级 BM25 检索，返回 top-k 片段 + 召回完整度信号' +
        '（empty/low/partial/high）。完整度=empty 或 low 时外部消费方应主动拒答而非编造，' +
        '与 desktop search_knowledge 工具的语义一致。',
      inputSchema: {
        avatarId: z.string().describe('分身 ID'),
        query: z.string().describe('检索 query（自然语言或关键词）'),
        k: z.number().int().min(1).max(20).optional()
          .describe('返回 chunk 数上限，默认 5'),
      },
    },
    ({ avatarId, query, k }) => {
      const kr = getKnowledgeRetriever(avatarId)
      const { chunks, coverage } = kr.searchChunksWithCoverage(query, k ?? 5)
      const header =
        `[coverage: hint=${coverage.hint} hits=${coverage.hits} ` +
        `topScore=${coverage.topScore.toFixed(3)} mode=${coverage.mode}]`
      const body = chunks.map((c, i) =>
        `--- #${i + 1} · ${c.file}${c.heading ? ' :: ' + c.heading : ''} (score=${c.score.toFixed(3)}) ---\n${c.content}`,
      ).join('\n\n')
      return {
        content: [{
          type: 'text',
          text: `${header}\n\n${body || '(无命中)'}`,
        }],
      }
    },
  )

  // ── 4. soul_search_files ──────────────────────────────────────
  server.registerTool(
    'soul_search_files',
    {
      description:
        '在指定分身的知识库做文件级文本检索，返回命中文件路径 + 匹配片段。' +
        '比 search_chunks 粗粒度，适合先定位文件再让消费方决定是否打开。',
      inputSchema: {
        avatarId: z.string().describe('分身 ID'),
        query: z.string().describe('检索 query'),
      },
    },
    ({ avatarId, query }) => {
      const km = getKnowledgeManager(avatarId)
      const hits = km.searchFiles(query)
      return {
        content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }],
      }
    },
  )

  // ── 5. soul_list_skills ───────────────────────────────────────
  server.registerTool(
    'soul_list_skills',
    {
      description:
        '列出指定分身可用的技能（avatar-local + shared + community 三层合并）。' +
        '只返回技能名 + description，不返回 prompt 正文（避免一次 dump 巨量内容）。',
      inputSchema: {
        avatarId: z.string().describe('分身 ID'),
      },
    },
    ({ avatarId }) => {
      assertSafeSegment(avatarId, '分身ID')
      const skills = skillManager.getSkills(avatarId).map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        level: s.level,
        enabled: s.enabled,
      }))
      return {
        content: [{ type: 'text', text: JSON.stringify(skills, null, 2) }],
      }
    },
  )

  return server
}
