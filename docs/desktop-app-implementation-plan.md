# 小堵桌面应用 - 完整实施计划

> **版本**: v1.0
> **日期**: 2026-03-30
> **目标**: 将 Soul 分身系统转化为跨平台桌面应用，让业务人员可以直接使用

---

## 一、项目背景

### 1.1 当前状态

**Soul 分身系统** 是一个基于文件的 AI 分身管理框架：
- 已有完整的分身「小堵」（工商储产品解决方案专家）
- 包含人格定义、知识库、技能系统、测试框架
- 需要通过 Claude Code / Trae IDE 使用

**问题**：
- 业务人员不会使用 IDE
- 无法部署企业微信机器人（没有后端服务器）
- 需要最简单、最直接的使用方式

### 1.2 解决方案

**开发跨平台桌面应用**：
- 双击打开即用，无需技术背景
- 支持 Windows 和 macOS
- 本地数据存储，安全可控
- 使用 DeepSeek API（用户自己配置 API Key）

---

## 二、技术架构

### 2.1 技术栈

```
框架：Electron 32+
前端：React 18 + TypeScript + Vite
UI 组件：Tailwind CSS + shadcn/ui
对话界面：react-markdown + react-syntax-highlighter
状态管理：Zustand
本地存储：SQLite（对话历史）+ 文件系统（知识库）
API 调用：Axios + Server-Sent Events（流式响应）
打包工具：electron-builder
```

### 2.2 系统架构

```
┌─────────────────────────────────────────────────────┐
│                   Electron 主进程                     │
│  - 窗口管理                                          │
│  - 文件系统访问（读取 soul/knowledge/skills）        │
│  - SQLite 数据库操作                                 │
│  - IPC 通信处理                                      │
└─────────────────────────────────────────────────────┘
                          ↕ IPC
┌─────────────────────────────────────────────────────┐
│                  Electron 渲染进程                    │
│  ┌─────────────────────────────────────────────┐   │
│  │  React 前端应用                              │   │
│  │  - 对话界面（ChatWindow）                    │   │
│  │  - 侧边栏（历史记录、知识库）                │   │
│  │  - 设置面板（API Key、模型选择）             │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                          ↕ HTTPS
┌─────────────────────────────────────────────────────┐
│              DeepSeek API (云端)                     │
│  - 模型：deepseek-chat                              │
│  - 流式响应：Server-Sent Events                     │
│  - API Key：用户自己配置                            │
└─────────────────────────────────────────────────────┘
```

### 2.3 目录结构

```
soul/
├── desktop-app/              ← 新建桌面应用目录
│   ├── electron/             ← Electron 主进程代码
│   │   ├── main.ts           ← 主进程入口
│   │   ├── preload.ts        ← 预加载脚本（IPC 桥接）
│   │   ├── ipc-handlers.ts   ← IPC 处理器
│   │   ├── database.ts       ← SQLite 数据库操作
│   │   ├── knowledge-manager.ts  ← 知识库文件管理
│   │   ├── soul-loader.ts    ← 加载分身 System Prompt
│   │   ├── avatar-manager.ts ← 分身管理
│   │   └── secure-storage.ts ← API Key 加密存储
│   ├── src/                  ← React 前端代码
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/       ← UI 组件
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── KnowledgePanel.tsx
│   │   │   ├── SkillsPanel.tsx
│   │   │   ├── TestPanel.tsx
│   │   │   ├── AvatarSelector.tsx
│   │   │   └── SettingsPanel.tsx
│   │   ├── services/         ← API 服务
│   │   │   ├── deepseek.ts
│   │   │   ├── self-test.ts
│   │   │   └── auto-test.ts
│   │   ├── stores/           ← Zustand 状态管理
│   │   │   ├── chatStore.ts
│   │   │   ├── knowledgeStore.ts
│   │   │   ├── avatarStore.ts
│   │   │   └── settingsStore.ts
│   │   └── types/            ← TypeScript 类型定义
│   ├── package.json
│   ├── vite.config.ts
│   ├── electron-builder.yml
│   └── tsconfig.json
├── avatars/                  ← 分身目录（现有）
│   └── ci-storage-expert/    ← 小堵
└── templates/                ← 模板（现有）
```

---

## 三、核心功能设计

### 3.1 分身文件结构

每个分身的标准目录结构：

```
avatars/[分身ID]/
├── CLAUDE.md          # 入口文件（引用其他文件）
├── soul.md            # 完整的人格定义
├── knowledge/         # 知识库
│   ├── [自定义结构]   # 用户可以自由组织
│   └── ...
├── skills/            # 技能定义
│   ├── skill-1.md
│   └── ...
├── memory/
│   └── MEMORY.md      # 长期记忆（初始为空）
└── tests/
    ├── cases/         # 测试用例
    └── reports/       # 测试报告
```

**文件说明：**

- **CLAUDE.md** — 入口文件，包含：
  - 人格执行要求（从 soul.md 提取的关键点）
  - 硬性红线（如果有）
  - 知识库索引（列出 knowledge/ 下的文件）
  - 技能索引（列出 skills/ 下的技能）
  - 记忆管理说明

- **soul.md** — 完整的人格定义，包含：
  - Identity（我是谁）
  - Background（专业背景）
  - Style（说话方式、语言特征、口头禅）
  - Principles（原则、红线）
  - Workflow（工作流程）
  - Commitment（承诺）

- **memory/MEMORY.md** — 长期记忆文件：
  - 初始为空模板
  - 分身在对话中学习到的内容会写入这里
  - 按主题组织（偏好、纠偏记录、项目记录、决策记录）
  - 每次对话前会读取，确保不重复犯错

### 3.2 知识库组织方式

用户创建新分身时，可以选择：

**方式 A：使用标准模板（推荐）**
- 系统提供标准目录结构（参考小堵的 knowledge/ 结构）
- 自动创建空模板文件（带注释说明）
- 适合：工商储、光伏、新能源等类似领域

**方式 B：自定义结构**
- 用户自己定义目录结构
- 上传文件时 AI 自动分类
- 适合：特殊领域、非标准知识结构

### 3.3 知识文件处理

**模式 1：快速导入**
- 直接提取文本转 .md
- 用户选择保存位置
- 速度快，不消耗 tokens

**模式 2：AI 智能提取**
- 调用 DeepSeek API 分析文档
- AI 识别文档类型并建议分类
- 结构化提取关键信息
- **自动生成测试用例**（3-5 个）
- 用户预览后确认保存

示例：
```
上传：《远景ENS-L262用户手册.pdf》(42页)
AI 分析：
  - 文档类型：产品手册
  - 建议分类：knowledge/products/envision-L262.md
  - 提取章节：产品概述、核心参数、安装要求、故障诊断

生成文件：
  - knowledge/products/envision-L262.md
  - tests/cases/knowledge-envision-L262-001.md（参数准确性测试）
  - tests/cases/knowledge-envision-L262-002.md（布局描述测试）
  - tests/cases/knowledge-envision-L262-003.md（安装要求测试）
```

### 3.4 自检与测试

**测试用例来源：**
1. 用户手动创建
2. AI 自动生成（上传知识文件时）
3. 系统预置（人格一致性、红线合规）

**定时自检：**
- 用户在设置中配置频率：每天/每周/每月
- 自动运行时机：
  - 应用启动时检查
  - 后台定时检查
  - 知识库更新后触发
- 结果通知：
  - 桌面通知
  - 应用内红点提示
  - 生成测试报告

### 3.5 API Key 管理

- **用户自己配置**，不内置在应用中
- 首次启动时引导输入 DeepSeek API Key
- 使用系统 Keychain 加密存储：
  - macOS: Keychain
  - Windows: Credential Manager
- 支持多个 API Key（用于不同分身或备用）
- 可以随时在设置中修改或删除

---

## 四、分步实施计划

### Phase 1: 项目初始化与基础框架（3-4 天）

**目标：** 搭建 Electron + React 项目骨架

**任务清单：**
- [ ] 创建 `desktop-app/` 目录结构
- [ ] 初始化 npm 项目，安装依赖
- [ ] 配置 Electron + Vite 开发环境
- [ ] 配置 TypeScript 编译
- [ ] 配置 Tailwind CSS
- [ ] 实现基础窗口（1200x800）
- [ ] 实现 IPC 通信基础架构
- [ ] 测试：运行 `npm run dev` 显示空白窗口

**验证标准：**
- ✅ 运行 `npm run dev` 可以启动应用
- ✅ 显示一个空白窗口，标题为"小堵 - 工商储专家"
- ✅ 主进程和渲染进程可以通过 IPC 通信

---

### Phase 2: DeepSeek API 集成与对话功能（4-5 天）

**目标：** 实现基础对话界面，接入 DeepSeek API

**任务清单：**
- [ ] 创建对话界面组件（ChatWindow、MessageList、MessageInput、MessageBubble）
- [ ] 实现 DeepSeek API 服务（支持流式响应）
- [ ] 实现 soul-loader（加载 CLAUDE.md + soul.md + knowledge/ + skills/）
- [ ] 实现对话状态管理（Zustand）
- [ ] 实现流式响应 UI（打字动画、Stop 按钮）
- [ ] 实现 Markdown 渲染（代码高亮、表格、列表）
- [ ] 错误处理（API 失败、网络超时）
- [ ] 测试：与小堵对话，验证人格和知识

**验证标准：**
- ✅ 输入"广东工商储现在值得做吗？"，小堵能以上海人口吻回复
- ✅ 回复内容实时流式显示（逐字出现）
- ✅ 支持多轮对话（上下文记忆）
- ✅ Markdown 格式正确渲染

---

### Phase 3: 对话历史与会话管理（3-4 天）

**目标：** 实现对话历史持久化，支持多会话管理

**任务清单：**
- [ ] 集成 SQLite 数据库
- [ ] 设计数据库表结构（conversations、messages、settings）
- [ ] 实现数据库操作层（Database 类）
- [ ] 创建侧边栏组件（Sidebar、ConversationList、ConversationItem）
- [ ] 实现会话切换逻辑
- [ ] 实现新建/删除会话
- [ ] 实现会话搜索
- [ ] 每个分身的会话历史独立存储
- [ ] 测试：创建多个会话，切换验证

**验证标准：**
- ✅ 创建多个会话，每个会话独立保存
- ✅ 切换会话时正确加载历史消息
- ✅ 删除会话后数据库中对应记录被删除
- ✅ 应用重启后历史记录仍然存在
- ✅ 每个分身的会话历史独立存储

---

### Phase 4: 知识库管理（3-4 天）

**目标：** 可视化查看和编辑分身的知识库

**任务清单：**
- [ ] 创建知识库浏览界面（KnowledgePanel、KnowledgeTree、KnowledgeViewer）
- [ ] 实现文件系统操作（KnowledgeManager 类）
- [ ] 实现 Markdown 编辑器（Monaco Editor）
- [ ] 实现编辑/预览模式切换
- [ ] 实现保存功能（Ctrl+S 快捷键）
- [ ] 实现全文搜索
- [ ] 测试：浏览、编辑、搜索知识库

**验证标准：**
- ✅ 可以浏览 knowledge/ 目录下所有文件
- ✅ 点击文件显示 Markdown 预览
- ✅ 编辑文件后保存，重新加载时内容已更新
- ✅ 搜索"峰谷电价"能找到相关文件

---

### Phase 5: 用户管理与设置（2-3 天）

**目标：** 实现 API Key 管理、模型选择、用户偏好设置

**任务清单：**
- [ ] 创建设置界面（SettingsPanel、ApiKeyInput、ModelSelector、ThemeSelector）
- [ ] 实现 API Key 加密存储（SecureStorage 类，使用系统 Keychain）
- [ ] 实现用户偏好管理（保存到 SQLite）
- [ ] 实现使用统计（对话次数、Token 使用量）
- [ ] 首次启动引导（输入 API Key）
- [ ] 测试：配置 API Key，切换模型

**验证标准：**
- ✅ 输入 DeepSeek API Key 后可以正常对话
- ✅ 切换模型后下次对话使用新模型
- ✅ 应用重启后设置保持不变
- ✅ 可以查看本月对话次数和 Token 使用量

---

### Phase 6: 分身管理与创建（4-5 天）

**目标：** 支持多分身切换、创建新分身

**任务清单：**
- [ ] 创建分身管理界面（AvatarSelector、AvatarList、AvatarCard）
- [ ] 实现分身加载系统（AvatarManager 类）
- [ ] 实现创建分身向导（CreateAvatarWizard，5 步表单）
  - [ ] 步骤 1：基本信息（名称、描述、头像）
  - [ ] 步骤 2：人格定义（表单填写或直接编辑 soul.md）
  - [ ] 步骤 3：知识库（上传文件，选择组织方式）
  - [ ] 步骤 4：技能定义（从模板选择或自定义）
  - [ ] 步骤 5：预览与测试
- [ ] 实现知识文件处理：
  - [ ] 快速导入模式（直接转 .md）
  - [ ] AI 智能提取模式（调用 DeepSeek 分析）
  - [ ] AI 自动分类和生成测试用例
- [ ] 实现分身切换（顶部下拉菜单）
- [ ] 实现分身目录结构自动生成
- [ ] 测试：创建新分身"小李 - 光伏专家"

**验证标准：**
- ✅ 可以看到「小堵」和其他已有分身
- ✅ 通过向导创建一个新分身"小李 - 光伏专家"
- ✅ 切换到新分身，对话风格符合定义
- ✅ 每个分身的对话历史独立保存
- ✅ 删除分身后，对应目录被删除
- ✅ 上传 PDF 文件，AI 自动提取并生成测试用例

---

### Phase 7: 自检与测试功能（3-4 天）

**目标：** 实现分身自检、测试用例管理、自动化测试

**任务清单：**
- [ ] 创建测试管理界面（TestPanel、TestCaseList、TestCaseEditor、TestRunner、TestReport）
- [ ] 实现自检功能（SelfTestService 类）
- [ ] 实现测试用例管理（读取 tests/cases/*.md）
- [ ] 实现测试运行器（单个/批量/全部）
- [ ] 实现测试报告（显示摘要、详情、导出）
- [ ] 实现测试用例创建（表单 + 模板）
- [ ] 实现基于知识库的测试用例自动生成
- [ ] 实现定时自检功能（AutoTestService 类）
- [ ] 在设置中配置自检频率
- [ ] 实现桌面通知和应用内提示
- [ ] 测试：运行自检，查看报告

**验证标准：**
- ✅ 点击"自检"按钮，自动运行所有测试用例
- ✅ 显示测试报告：45/47 通过
- ✅ 查看失败用例的详细信息
- ✅ 创建新测试用例"收益测算-三档场景"
- ✅ 运行新测试用例，验证小堵是否给出三档测算
- ✅ 上传知识文件时自动生成 3-5 个测试用例
- ✅ 定时自检自动运行并通知结果

---

### Phase 8: 技能树管理（2-3 天）

**目标：** 可视化管理分身的技能

**任务清单：**
- [ ] 创建技能管理界面（SkillsPanel、SkillCard、SkillEditor）
- [ ] 实现技能列表展示（读取 skills/*.md）
- [ ] 实现技能启用/禁用
- [ ] 实现技能编辑（Monaco Editor）
- [ ] 测试：禁用技能，验证效果

**验证标准：**
- ✅ 显示 7 个技能卡片（产品问答、方案设计、收益测算等）
- ✅ 禁用"标书辅助"技能后，小堵不再提供标书相关功能
- ✅ 编辑"收益测算"技能的流程后，下次对话按新流程执行

---

### Phase 9: 打包与发布（2-3 天）

**目标：** 生成 Windows .exe 和 macOS .dmg 安装包

**任务清单：**
- [ ] 配置 electron-builder.yml
- [ ] 准备应用图标（.ico 和 .icns）
- [ ] 构建安装包（Windows + macOS）
- [ ] 在 Windows 10/11 上测试
- [ ] 在 macOS 13+ 上测试
- [ ] 编写用户文档（安装指南、使用教程、常见问题）
- [ ] 发布到 GitHub Releases

**验证标准：**
- ✅ Windows 用户双击 .exe 可以安装并运行
- ✅ macOS 用户双击 .dmg 可以安装并运行
- ✅ 安装包大小 < 200MB
- ✅ 首次启动引导用户输入 API Key

---

## 五、开发时间估算

| 阶段 | 任务 | 预计时间 |
|------|------|---------|
| Phase 1 | 项目初始化与基础框架 | 3-4 天 |
| Phase 2 | DeepSeek API 集成与对话功能 | 4-5 天 |
| Phase 3 | 对话历史与会话管理 | 3-4 天 |
| Phase 4 | 知识库管理 | 3-4 天 |
| Phase 5 | 用户管理与设置 | 2-3 天 |
| Phase 6 | 分身管理与创建 | 4-5 天 |
| Phase 7 | 自检与测试功能 | 3-4 天 |
| Phase 8 | 技能树管理 | 2-3 天 |
| Phase 9 | 打包与发布 | 2-3 天 |
| **总计** | | **26-35 天** |

**实际开发建议：**
- **MVP**（Phase 1-2）：1 周，先验证核心对话功能
- **基础版**（Phase 1-5）：2-3 周，包含对话、历史、知识库、设置
- **完整版**（Phase 1-9）：4-5 周，包含分身创建、自检测试等高级功能

---

## 六、风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| DeepSeek API 限流 | 对话失败 | 实现请求队列、错误重试、降级提示 |
| Electron 打包体积过大 | 下载慢、占用空间 | 使用 asar 压缩、排除 devDependencies |
| 知识库文件过大 | 加载慢 | 实现懒加载、分页加载 |
| 跨平台兼容性问题 | 部分功能在某平台不可用 | 提前在 Windows 和 macOS 上测试 |
| API Key 泄露风险 | 安全问题 | 使用系统 Keychain 加密存储 |
| AI 提取质量不稳定 | 知识库质量差 | 提供预览和编辑功能，用户可以修正 |

---

## 七、后续扩展方向

**v2.0 可能的功能：**
- 支持本地模型（Ollama 集成）
- 多分身协作（分身之间互相调用）
- 语音输入/输出
- 导出对话为 PDF/Word
- 团队协作（分享会话、知识库同步）
- 插件系统（第三方技能扩展）
- 移动端应用（iOS/Android）

---

## 八、参考资料

- [Electron 官方文档](https://www.electronjs.org/docs/latest/)
- [DeepSeek API 文档](https://platform.deepseek.com/api-docs/)
- [React + TypeScript 最佳实践](https://react-typescript-cheatsheet.netlify.app/)
- [electron-builder 配置指南](https://www.electron.build/)
- [shadcn/ui 组件库](https://ui.shadcn.com/)
