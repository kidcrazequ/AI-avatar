# Soul 项目编码规范（跨模块横切关注点）

本文件记录项目中已统一的横切模式规则。
**新增代码必须遵守这些规则**，审查时如发现违反须同步修正。

---

## 1. 日期格式化

**规则**：所有需要 `YYYY-MM-DD` 格式日期字符串的地方，必须使用 `localDateString()`，**禁止**直接调用 `toISOString().slice(0, 10)`。

**原因**：`toISOString()` 返回 UTC 日期。在 UTC+8 时区，晚 20:00 后调用会得到比本地日期早一天的字符串，导致日志文件命名、Wiki 时间戳不符合用户直觉，且难以排查。

**导入路径**：
- Node/Electron 模块：`import { localDateString } from '@soul/core'`
- React 组件：`import { localDateString } from '@soul/core'`

**例外**：纯用于显示（非存储、非文件命名）的 `toLocaleDateString('zh-CN')` 和 `toLocaleString('zh-CN')` 保持原样，这类调用不影响数据一致性。

```typescript
// ✅ 正确
import { localDateString } from '@soul/core'
const today = localDateString()              // "2026-04-10"
const backupName = `soul-${localDateString()}.db`

// ❌ 错误（UTC 日期，晚间 UTC+8 偏差一天）
const today = new Date().toISOString().slice(0, 10)
```

---

## 2. 网络请求超时

**规则**：所有 `fetch` 调用必须携带 `signal: AbortSignal.timeout(ms)`，禁止裸露的 `fetch`（无 signal 参数）发起网络请求。

**原因**：无超时保护的 `fetch` 在网络故障或服务端挂起时会永久阻塞，导致应用界面冻结、进程/线程资源泄漏。

**推荐超时时长**：
| 场景 | 超时 |
|------|------|
| LLM/Embedding 后台索引构建、RAG | `180_000`（3分钟） |
| 连接测试、ping 类接口 | `15_000`（15秒） |
| 普通 API 调用 | `60_000`（1分钟） |

**LLM/Embedding 调用**：必须通过 `desktop-app/electron/llm-factory.ts` 中的 `createLLMFn` / `createEmbeddingFn` 工厂函数创建，禁止内联 `fetch` 实现 LLM 调用。

```typescript
// ✅ 正确 - 使用 AbortSignal.timeout
const response = await fetch(url, {
  method: 'POST',
  headers: { ... },
  body: JSON.stringify(...),
  signal: AbortSignal.timeout(180_000),
})

// ✅ 正确 - 使用工厂函数（已内置超时）
import { createLLMFn, createEmbeddingFn } from './llm-factory'
const callLLM = createLLMFn(apiKey, baseUrl, model)

// ❌ 错误 - 无超时保护
const response = await fetch(url, { method: 'POST', body: ... })
```

---

## 3. 递归目录遍历

**规则**：所有递归扫描文件系统目录的代码，必须使用 `packages/core/src/utils/common.ts` 中的 `collectFilesRecursive()`，或传入 `depth` 参数并设置最大深度限制。

**原因**：没有深度上限的目录递归在遇到符号链接环路时会导致栈溢出崩溃。此问题在生产环境中静默发生，极难调试。

**导入路径**：
```typescript
import { collectFilesRecursive, DEFAULT_MAX_DIR_DEPTH } from '@soul/core'
// 或在 core 包内部
import { collectFilesRecursive, DEFAULT_MAX_DIR_DEPTH } from './utils/common'
```

**例外**：`SoulLoader.readDirectory` 因需同时读取文件内容，保持独立实现，但已使用 `DEFAULT_MAX_DIR_DEPTH` 常量。

```typescript
// ✅ 正确 - 使用共享工具函数
const mdFiles = collectFilesRecursive(knowledgePath, '.md')

// ✅ 正确 - 有深度限制的自定义递归
function scan(dir: string, depth = 0): string[] {
  if (depth > DEFAULT_MAX_DIR_DEPTH) return []
  // ...
  results.push(...scan(sub, depth + 1))
}

// ❌ 错误 - 无深度限制的递归
function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) results.push(...collectFiles(path.join(dir, e.name)))
  }
}
```

---

## 4. React 异步操作卸载安全

**规则**：React 组件中运行时间超过约 1 秒的异步操作（如文档导入、LLM 调用、批量文件操作），必须使用以下至一种保护模式：

**模式 A：`mountedRef`**（适用于单次长时异步操作，如文档导入）
```typescript
const mountedRef = useRef(true)
useEffect(() => {
  mountedRef.current = true
  return () => { mountedRef.current = false }
}, [])

// 在每个主要 await 之后检查
const result = await someSlowOperation()
if (!mountedRef.current) return   // 组件已卸载，不再触发 setState
setState(result)
```

**模式 B：`loadSeqRef`/`cancelled`**（适用于因 prop 切换触发的加载，如 avatarId 切换）
```typescript
const loadSeqRef = useRef(0)
const load = useCallback(async () => {
  const seq = ++loadSeqRef.current
  const result = await fetchData()
  if (loadSeqRef.current !== seq) return   // 已被更新的请求覆盖
  setData(result)
}, [dependency])
```

**不需要保护的情况**：仅由用户主动触发且组件不会在操作过程中卸载的简短操作（如保存文件 < 500ms）。

---

## 5. LLM/Embedding 客户端创建

**规则**：在 Electron 主进程中，所有调用 LLM 或 Embedding API 的代码，必须通过 `desktop-app/electron/llm-factory.ts` 的工厂函数，禁止在 IPC handler 中内联 `fetch` 发起 LLM/Embedding 请求。

**原因**：工厂函数统一管理超时配置（`BACKEND_API_TIMEOUT_MS`）和请求格式，避免各处实现遗漏超时保护或使用错误的 API 参数格式。

**适用范围**：`desktop-app/electron/` 下所有需要 LLM/Embedding API 的代码。

```typescript
// ✅ 正确
import { createLLMFn, createEmbeddingFn } from './llm-factory'
const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-turbo')
const callEmbedding = createEmbeddingFn(apiKey, baseUrl)

// ❌ 错误
async function callLLM(...) {
  const response = await fetch(`${baseUrl}/chat/completions`, { ... })  // 绕过工厂
}
```

---

## 执行检查清单

代码审查时，对每个 PR 检查以下项目：

- [ ] 所有 `YYYY-MM-DD` 日期字符串生成是否使用了 `localDateString()`？
- [ ] 所有 `fetch(...)` 调用是否携带了 `signal: AbortSignal.timeout(...)`？
- [ ] 是否有新的内联 `fetch` 调用 LLM/Embedding API（而非通过 `llm-factory.ts`）？
- [ ] 是否有新的递归目录遍历缺少深度限制？
- [ ] React 组件中是否有新的 1 秒以上异步操作，但缺少 `mountedRef`/`loadSeqRef` 保护？
- [ ] desktop-app 中是否有硬编码十六进制色值（而非 `--px-*` 变量 / Tailwind `px-*` 类）？

---

## 6. 主题色彩变量

**规则**：desktop-app 中所有颜色值必须通过 CSS 变量 `--px-*` 引用，禁止在组件中硬编码十六进制色值（`#xxxxxx`）。

**原因**：主题系统通过 `[data-theme]` 属性切换 CSS 变量实现运行时换肤。硬编码色值不会跟随主题变化，导致切换后出现色彩不一致。

**变量定义位置**：`src/index.css` 中的 `:root` / `[data-theme="..."\]` 块。

**Tailwind 引用**：`tailwind.config.js` 中 `colors.px.*` 已全部指向 CSS 变量，组件中使用 `bg-px-primary`、`text-px-text` 等 Tailwind 类即可。

**新增主题步骤**：
1. 在 `src/index.css` 中新增 `[data-theme="theme-id"]` 块，定义全部 `--px-*` 变量
2. 在 `src/stores/themeStore.ts` 的 `ThemeId` 类型和 `THEMES` 数组中注册
3. 运行 `python3` 相近度检查脚本，确保 primary 距离 > 30

**关键文件**：
| 文件 | 职责 |
|------|------|
| `src/index.css` | CSS 变量定义（81 个主题） |
| `src/stores/themeStore.ts` | Zustand 状态 + 主题元数据 |
| `tailwind.config.js` | Tailwind `colors.px.*` → CSS 变量映射 |
| `src/App.tsx` | 根节点 `data-theme={themeId}` 绑定 |
| `src/components/SettingsPanel.tsx` | THEME 标签页 UI |

```css
/* ✅ 正确 — 使用 CSS 变量 */
.my-component {
  background: var(--px-surface);
  color: var(--px-primary);
  box-shadow: 0 0 8px var(--px-glow);
}
```

```tsx
// ✅ 正确 — 使用 Tailwind 类
<div className="bg-px-surface text-px-primary" />

// ❌ 错误 — 硬编码色值
<div style={{ background: '#12121A', color: '#FFB0C8' }} />
```
