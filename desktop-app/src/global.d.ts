/// <reference types="vite/client" />

declare module '*.css' {
  const content: string
  export default content
}

interface AvatarConfig {
  id: string
  name: string
  systemPrompt: string
}

interface Conversation {
  id: string
  title: string
  avatar_id: string
  created_at: number
  updated_at: number
}

interface DbMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  image_urls?: string
  created_at: number
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface SearchResult {
  path: string
  matches: string[]
}

/** 解析后的文档内容（GAP9a） */
interface ParsedDocument {
  text: string
  images: string[]
  fileName: string
  fileType: 'pdf' | 'word' | 'image' | 'text'
}

/** 统一 LLM 模型配置（OpenAI 兼容接口） */
interface ModelConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** 消息内容多模态类型 */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 工具函数定义 */
interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ElectronAPI {
  ping: () => Promise<string>
  loadAvatar: (avatarId: string) => Promise<AvatarConfig>

  // 会话管理
  createConversation: (title: string, avatarId: string) => Promise<string>
  getConversations: (avatarId?: string) => Promise<Conversation[]>
  getConversation: (id: string) => Promise<Conversation | undefined>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>

  // 消息管理
  saveMessage: (conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) => Promise<string>
  getMessages: (conversationId: string) => Promise<DbMessage[]>

  // 设置管理
  getSetting: (key: string) => Promise<string | undefined>
  setSetting: (key: string, value: string) => Promise<void>

  // 知识库管理
  getKnowledgeTree: (avatarId: string) => Promise<FileNode[]>
  readKnowledgeFile: (avatarId: string, relativePath: string) => Promise<string>
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => Promise<void>
  searchKnowledge: (avatarId: string, query: string) => Promise<SearchResult[]>
  // GAP7: 知识文件 CRUD
  createKnowledgeFile: (avatarId: string, relativePath: string, content?: string) => Promise<void>
  deleteKnowledgeFile: (avatarId: string, relativePath: string) => Promise<void>

  // 记忆管理（GAP2）
  readMemory: (avatarId: string) => Promise<string>
  writeMemory: (avatarId: string, content: string) => Promise<void>

  // 分身管理
  listAvatars: () => Promise<Avatar[]>
  createAvatar: (id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) => Promise<void>
  writeSkillFile: (avatarId: string, fileName: string, content: string) => Promise<void>
  deleteAvatar: (id: string) => Promise<void>

  // 测试管理
  getTestCases: (avatarId: string) => Promise<TestCase[]>
  getTestCase: (avatarId: string, caseId: string) => Promise<TestCase | undefined>
  createTestCase: (avatarId: string, testCase: Omit<TestCase, 'filePath'>) => Promise<string>
  deleteTestCase: (avatarId: string, caseId: string) => Promise<void>
  saveTestReport: (avatarId: string, report: TestReport) => Promise<string>
  getLatestReport: (avatarId: string) => Promise<TestReport | null>
  getReportList: (avatarId: string) => Promise<Array<{ fileName: string; timestamp: number; passed: number; total: number }>>
  // BUG6 修复：移除虚假 onProgress 回调参数
  runTests: (avatarId: string, caseIds: string[]) => Promise<TestCase[]>

  // 技能管理
  getSkills: (avatarId: string) => Promise<Skill[]>
  getSkill: (avatarId: string, skillId: string) => Promise<Skill | undefined>
  updateSkill: (avatarId: string, skillId: string, content: string) => Promise<void>
  toggleSkill: (avatarId: string, skillId: string, enabled: boolean) => Promise<void>

  // 工具调用（GAP4）
  executeToolCall: (avatarId: string, name: string, args: Record<string, unknown>) => Promise<{ content: string; error?: string }>

  // 知识检索（GAP1）
  searchKnowledgeChunks: (avatarId: string, query: string, topN?: number) => Promise<Array<{ file: string; heading: string; content: string; score: number }>>

  // 文档导入（GAP9a）
  showOpenDialog: (options: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) => Promise<{ canceled: boolean; filePaths: string[] }>
  parseDocument: (filePath: string) => Promise<ParsedDocument>

  // 定时自检（GAP14）
  startScheduledTest: (avatarId: string, intervalHours: number) => Promise<void>
  stopScheduledTest: () => Promise<void>
  notifyTestResult: (passed: number, total: number, failed: number) => Promise<void>
  onScheduledTestTrigger: (callback: (avatarId: string) => void) => void
  onTestResultBadge: (callback: (data: { passed: boolean; total: number; failed: number }) => void) => void
}

interface Avatar {
  id: string
  name: string
  description: string
  createdAt: number
}

interface TestCase {
  id: string
  name: string
  category: string
  timeout: number
  prompt: string
  rubrics: string[]
  mustContain: string[]
  mustNotContain: string[]
  filePath: string
}

interface TestResult {
  caseId: string
  caseName: string
  passed: boolean
  score: number
  response: string
  feedback: string
  timestamp: number
  duration: number
}

interface TestReport {
  avatarId: string
  totalCases: number
  passedCases: number
  failedCases: number
  averageScore: number
  results: TestResult[]
  timestamp: number
  duration: number
}

interface Skill {
  id: string
  name: string
  level: string
  version: string
  description: string
  enabled: boolean
  filePath: string
  content: string
}

interface Window {
  electronAPI: ElectronAPI
}
