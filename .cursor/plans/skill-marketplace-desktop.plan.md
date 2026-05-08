# 桌面端技能管理模块设计方案

> 状态：已完成（2026-05-08）
> 作者：zhi.qu
> 日期：2026-05-08

## 一、背景

Soul 项目已建立三级技能体系（local → shared → community），但当前社区技能安装需要手动编辑 YAML + 跑脚本，对非技术用户不友好。本方案在桌面端增加技能管理 UI。

## 二、现有基础（无需重建）

### 已有 IPC 接口
```
get-skills / get-skill / update-skill / toggle-skill / create-skill / delete-skill
write-skill-file / generate-skill-draft / install-default-skills
```

### 已有 Skill 类型
```typescript
// global.d.ts
interface Skill {
  id: string; name: string; level: string; version: string;
  description: string; enabled: boolean; filePath: string;
  content: string; isBuiltin: boolean;
}
```

### 已有 UI 组件
- `SkillsPanel.tsx` — 已有技能列表 + 编辑 + 新建 + 删除 + AI 生成
- `App.tsx` 的 `activePanel` 已包含 `'skills'` 面板切换

### 已有核心模块
- `@soul/core/skill-router.ts` — SkillRouter 解析 skill-index.yaml
- `@soul/core` — SkillIndexEntry / SkillIndex / RouteResult 类型
- `electron/main.ts` — `installDefaultSkillsSync` 安装默认技能

### 已有文件基础设施
- `shared/skills/sources.yaml` — 外部技能来源清单
- `shared/skills/community/` — 社区技能安装目录
- `scripts/soul-sync.sh` — CLI 同步脚本
- `templates/skill-manifest-template.yaml` — 发布者模板

## 三、需要新增的能力

### 3.1 数据模型扩展

```typescript
// 新增类型（global.d.ts）

/** 社区技能源 */
interface CommunitySkillSource {
  name: string              // 本地目录名
  repo: string              // Git 仓库 URL
  ref: string               // tag / branch / commit
  path?: string             // 仓库内技能目录
  file?: string             // 单文件模式
  skills?: string[]         // 选择性安装
}

/** 已安装的社区技能包 */
interface InstalledCommunityPack {
  name: string
  repo: string
  ref: string
  commit: string            // 实际 commit hash
  syncedAt: string          // ISO 时间
  skillCount: number        // 安装的技能数
  skills: CommunitySkillInfo[]
}

/** 社区技能信息 */
interface CommunitySkillInfo {
  name: string
  file: string              // 相对路径
  description: string       // 从 frontmatter 提取
  domain: string
}

/** Skill 类型扩展 */
interface Skill {
  // ... 现有字段
  source: 'local' | 'shared' | 'community'   // 新增
  origin?: string                              // 新增：community 来源 URL
}
```

### 3.2 新增 IPC 接口

| IPC 频道 | 方向 | 用途 |
|---|---|---|
| `community:list-sources` | R→M→R | 读取 sources.yaml 返回源列表 |
| `community:add-source` | R→M | 添加新的技能源到 sources.yaml |
| `community:remove-source` | R→M | 从 sources.yaml 移除技能源 |
| `community:sync` | R→M→R | 执行同步（等同于 soul-sync.sh） |
| `community:sync-progress` | M→R | 同步进度推送 |
| `community:list-installed` | R→M→R | 列出已安装的社区技能包 |
| `community:get-manifest` | R→M→R | 获取某个 GitHub 仓库的 skill-manifest |
| `community:enable-for-avatar` | R→M | 为某分身启用指定社区技能 |
| `community:disable-for-avatar` | R→M | 为某分身禁用指定社区技能 |

### 3.3 主进程新增模块

```
desktop-app/electron/community-skill-manager.ts
```

职责：
1. 读写 `shared/skills/sources.yaml`（用正则解析，不引入 js-yaml）
2. Git clone / checkout（调用 `child_process.spawn('git', ...)`)
3. 解析 `skill-manifest.yaml`
4. 校验技能文件 frontmatter
5. 更新 `sources.lock`
6. 更新分身 `skill-index.yaml`（添加/移除 community 技能引用）

### 3.4 渲染端 UI 变更

#### 方案：扩展现有 SkillsPanel，增加 Tab 切换

```
┌─────────────────────────────────────────────┐
│  技能管理                              [×]  │
├─────────────────────────────────────────────┤
│  [本地技能]  [公共技能]  [社区技能]          │
├─────────────────────────────────────────────┤
│                                             │
│  （根据选中 Tab 显示不同内容）                │
│                                             │
└─────────────────────────────────────────────┘
```

**Tab 1：本地技能**（现有 SkillsPanel 功能）
- 已有的技能列表 + 编辑 + 新建 + 删除 + AI 生成
- 新增 `source` 标签显示技能来源

**Tab 2：公共技能**（新增）
- 列出 `shared/skills/` 下的 17 个公共技能
- 显示哪些已被当前分身启用
- 启用/禁用开关

**Tab 3：社区技能**（新增，核心）
```
┌─────────────────────────────────────────────┐
│  社区技能                                    │
│                                             │
│  ┌─── 添加技能源 ───────────────────────┐   │
│  │ GitHub URL: [                    ] [添加]│   │
│  │ 版本/Tag:   [v1.0.0             ]       │   │
│  └─────────────────────────────────────────┘   │
│                                             │
│  ── 已安装 (2) ────────────────────────     │
│                                             │
│  📦 awesome-prompt  v1.2.0                  │
│     2 个技能 · 同步于 2026-05-08            │
│     ☑ prompt-engineering                    │
│     ☑ chain-of-thought                      │
│     [更新]  [卸载]                           │
│                                             │
│  📦 data-analysis   v2.0.1                  │
│     1 个技能 · 同步于 2026-05-06            │
│     ☑ pandas-analysis                       │
│     [已是最新]  [卸载]                       │
│                                             │
└─────────────────────────────────────────────┘
```

## 四、文件变更清单

### @soul/core（共享包）

| 文件 | 变更 |
|---|---|
| `packages/core/src/skill-router.ts` | `SkillIndexEntry` 增加 `source` / `origin` 可选字段；`loadIndex` 支持解析 `local_skills` / `shared_skills` / `local_overrides` 三个 section |
| `packages/core/src/community-skill-types.ts` | 新建：CommunitySkillSource / InstalledCommunityPack 等类型 |
| `packages/core/src/index.ts` | 导出新类型 |

### desktop-app/electron（主进程）

| 文件 | 变更 |
|---|---|
| `electron/community-skill-manager.ts` | 新建：社区技能管理器（源管理 + 同步 + 安装） |
| `electron/main.ts` | 注册 `community:*` IPC handlers |
| `electron/preload.ts` | 暴露 `community*` API 到 `window.electronAPI` |

### desktop-app/src（渲染进程）

| 文件 | 变更 |
|---|---|
| `src/global.d.ts` | Skill 类型增加 `source` / `origin`；新增 Community* 类型；ElectronAPI 增加 community* 方法 |
| `src/components/SkillsPanel.tsx` | 重构：增加 Tab 切换（本地/公共/社区），保留现有功能在"本地"Tab |
| `src/components/CommunitySkillTab.tsx` | 新建：社区技能 Tab 组件（添加源 + 已安装列表 + 操作） |
| `src/components/SharedSkillTab.tsx` | 新建：公共技能 Tab 组件（列表 + 启用开关） |

## 五、执行计划（按依赖顺序）

### Phase 1：核心类型与主进程（4 个子任务）

| # | 子任务 | 涉及文件 | 预估行数 |
|---|---|---|---|
| 1.1 | 新建 `community-skill-types.ts` + 导出 | `packages/core/src/` | ~50 行 |
| 1.2 | 扩展 `SkillIndexEntry` 支持 source 字段 | `packages/core/src/skill-router.ts` | ~20 行修改 |
| 1.3 | 新建 `community-skill-manager.ts` | `desktop-app/electron/` | ~300 行 |
| 1.4 | 注册 IPC + preload 暴露 | `electron/main.ts` + `electron/preload.ts` | ~60 行 |

### Phase 2：类型声明与 Skill 扩展（2 个子任务）

| # | 子任务 | 涉及文件 | 预估行数 |
|---|---|---|---|
| 2.1 | 更新 `global.d.ts` 类型 | `src/global.d.ts` | ~40 行 |
| 2.2 | 现有 `get-skills` handler 支持 source 字段 | `electron/main.ts` | ~15 行修改 |

### Phase 3：渲染端 UI（3 个子任务）

| # | 子任务 | 涉及文件 | 预估行数 |
|---|---|---|---|
| 3.1 | 重构 `SkillsPanel.tsx` 增加 Tab 框架 | `src/components/SkillsPanel.tsx` | ~50 行修改 |
| 3.2 | 新建 `SharedSkillTab.tsx` | `src/components/SharedSkillTab.tsx` | ~120 行 |
| 3.3 | 新建 `CommunitySkillTab.tsx` | `src/components/CommunitySkillTab.tsx` | ~200 行 |

### 总计：9 个子任务，预估 ~855 行代码

## 六、依赖关系

```
1.1 ─┬─→ 1.2 ─→ 1.3 ─→ 1.4
     │
     └─→ 2.1 ─→ 2.2
                  │
                  └─→ 3.1 ─→ 3.2
                         └─→ 3.3
```

Phase 1.1 和 2.1 可并行。Phase 3 依赖 Phase 1 + 2 完成。

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| skill-index.yaml 新格式（local_skills/shared_skills/local_overrides）与现有 SkillRouter 解析逻辑不兼容 | Phase 1.2 优先处理，做向下兼容（旧格式 `skills:` 仍可识别） |
| Git 操作在 Windows/macOS/Linux 行为差异 | `community-skill-manager.ts` 中用 `which git` 检测，失败给友好提示 |
| 无 js-yaml 依赖，解析 YAML 复杂 | sources.yaml 结构简单，用正则 + JSON 转换；复杂字段不支持 |
| 社区技能 prompt injection 风险 | UI 展示技能内容预览，安装前让用户确认 |

## 八、后续扩展（本期不做）

- 技能市场（需要注册中心 / GitHub Topic 索引）
- 技能评分 / 下载量统计
- 自动更新通知
- 技能依赖自动解析
