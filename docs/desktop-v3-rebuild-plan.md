# Soul 新桌面端：技术选型与实施计划

日期：2026-10-10。状态：第 1、2、3、4 项内部关口通过。已按 V3 实现专家管理、群组、主页、项目、知识库、记忆、技能与专家设置，接入真实专家包及独立持久化；Windows x64、Mac arm64、Intel 原生构建、实际安装、两次启动与布局检查均通过。详见 [第 1 项验收记录](desktop-next-step1-qa.md)、[第 2 项验收记录](desktop-next-step2-qa.md)、[第 3 项验收记录](desktop-next-step3-qa.md)。第 4 项已按 V3 实现真实任务对话、看板、审批、群组执行与重启恢复，沿用旧版模型完成本机真实执行；三平台原生安装关口通过，详见 [第 4 项验收记录](desktop-next-step4-qa.md)。第 5 项工作流待继续，正式签名和自动更新待第 7 项验收。

视觉与交互基准：[V3 DESIGN](../design-prototypes/soul-work-v3/DESIGN.md)、[资源与设置验收](../design-prototypes/soul-work-v3/QA-step3.md)。以已确认的 QoderWake CN 复刻原型作为唯一界面基准。

用户本轮明确：重新做新的桌面端；Windows 与 macOS 要能安装并自动更新。当前没有签名证书或更新地址，先完成开发与内部构建。Windows 打包风险优先验证。

## 技术决定

建议保留 Electron + React + TypeScript，重建桌面入口、业务适配与发行链路。成立条件是第 1 项通过 Windows 原生构建、安装和运行验证；不能用“生成 exe”代替通过该关口。

在 `desktop-next/` 新建独立桌面工程，复用 `packages/core/` 和经过检查的业务模块。旧 `desktop-app/` 保留为迁移参考；当前未提交的 App.tsx、index.css、品牌与安装资源改动不纳入新工程的自动复制。新工程逐模块编写 React 页面，不直接运行原型的模拟状态转换。

| 层 | 选择 | 理由与边界 |
| --- | --- | --- |
| 桌面宿主 | Electron，候选 44.7.0 | 当前官方 npm 稳定版本；同一 Chromium 渲染目标有利于复刻一致性。先验证原生模块兼容性，再锁定版本 |
| 页面与类型 | React + TypeScript | 沿用已有业务类型和前端能力；新版页面独立组织 |
| 构建 | Vite + esbuild | 渲染层和主进程分开构建；生产版加载本地资源 |
| 状态 | React 局部状态 + 类型明确的 IPC；后续任务全局状态再评估 Zustand | 第 2 项目录和群组持久化在主进程 SQLite，不引入额外状态依赖；IPC 逐项暴露、校验来源和输入 |
| 持久化 | SQLite + 文件资源 | 复用数据语义；会话、任务、工作流和版本入库，专家包及原始资料保持可追溯 |
| 安装/更新 | electron-builder 26.15.3 + electron-updater 6.8.9 候选组合 | 采用已发布稳定版本；补齐真实更新服务及状态事件 |
| 构建运行时 | 受支持的 Node.js 稳定版本，满足 ≥22.12.0 | Electron 44 npm 安装要求；记录实际构建工具版本 |

候选版本来自 2026-10-10 官方 npm 元数据读取。第 1 项现已锁定 Electron 44.7.0、electron-builder 26.15.3、better-sqlite3 13.0.3 和构建宿主 Node 24，并通过双平台安装版验证；electron-updater 仍为后续候选，尚未接入。实际依赖使用精确版本和锁文件，不以浮动 `latest` 构建发布包。具体版本及验收范围以第 1 项记录和 `desktop-next/package-lock.json` 为准。

### 与其他方案比较

| 方案 | 对当前 Soul 的影响 | 决定 |
| --- | --- | --- |
| Electron | 保留 Node/TypeScript 核心；原生依赖和资源仍需规范构建 | 优先验证 |
| Tauri 2 + React | 原有 Node 后端需要 sidecar 或重写；IPC、生命周期和打包都要重新验证 | 当前不迁移；第 1 项出现无法解决的框架级问题时重评 |

Tauri 官方有 Node sidecar 和更新插件；这说明它可以实现目标，也说明保留当前 Node 能力仍要打包一个对应平台的运行程序。不能据此认为现有 SQLite/nodejieba 问题会自动消失。[Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)、[更新插件](https://v2.tauri.app/plugin/updater/)。

版本资料冲突已处理：electron-builder 的默认文档展示尚未发布的 v27，其中部分签名配置和更新 API 已变化。本方案使用 [v26 稳定更新文档](https://www.electron.build/v26/docs/features/auto-update/)；v27 规则作为将来升级事项，不直接套进 26.x 实现。

## 当前事实与风险

| 事实 | 本轮证据 | 对新版的要求 |
| --- | --- | --- |
| 当前桌面版本 0.19.0 | desktop-app/package.json | 正式覆盖升级时版本递增，候选包另设渠道 |
| 锁定 Electron 41.3.0、builder 26.8.1，没有 electron-updater | desktop-app/package-lock.json | 选型沿用不等于照搬旧依赖版本 |
| 更新仅比较 GitHub Release 版本并返回网页链接 | electron/main.ts 的 check-update IPC，preload.ts，App.tsx | 建立下载、校验、就绪、安装、失败状态；检查失败不能显示成无更新 |
| macOS 目标只有 DMG | electron-builder.yml | 正式更新同时产出 ZIP 与架构对应的 metadata |
| 旧发布流程从 main 构建并覆盖指定旧标签产物 | .github/workflows/release.yml | 从准确 tag/commit 构建；版本与源码一致；版本产物不可覆盖 |
| Mac 交叉构建时替换 SQLite/nodejieba/ripgrep 二进制 | scripts/after-pack.js | Windows 原生环境构建；检查二进制类型、架构及实际加载 |
| 中文分词在模块加载时读取 nodejieba 原生模块、词典 | packages/core/src/knowledge-retriever.ts | 打包后实际加载及中文检索测试；无法加载时不得假装可用 |
| SQLite、词典、rg.exe、PDF/Excel worker 有包路径约束 | builder、build-electron.js、after-pack.js | 显式资源清单及安装版 smoke，不能依赖开发目录 |
| 最近 4 次历史 Windows workflow 记录均为失败 | gh run list，最新 run 29322742282 | 最新记录没有 jobs/log；根因未确认，不能当作当前源码已失败或已修复证据 |
| 现有 CI 只构建上传产物 | 两个打包 workflow | 加入安装、启动、数据库、资源与检索验证 |
| 本机为 macOS arm64；无本地 Developer ID 身份 | 本轮宿主与签名身份检查 | 本机可验 Mac arm64；其他平台必须补齐对应运行环境证据 |
| 用户确认暂无签名及发布地址；仓库级 secret 名称列表为空 | 本轮用户回复与只读查询 | 先内部构建；正式签名/线上更新仍有明确外部依赖 |

`docs/architecture.md` 的分词说明仍写 segmentit，实际依赖与当前检索实现使用 nodejieba；以本轮源代码为准。旧说明列入后续对应模块文档更新，不在本轮顺带修改。

历史 Windows 记录：[最新失败记录](https://github.com/kidcrazequ/AI-avatar/actions/runs/29322742282)。方案制定阶段未启动构建；第 1、2 项实施已完成独立分支的原生构建与实际安装，详见各项验收记录。当前没有正式发布或上线更新通道。

## Windows 与 macOS 发行设计

| 平台 | 安装产物 | 构建与验证环境 | 正式交付验证 |
| --- | --- | --- | --- |
| Windows x64 | NSIS EXE + blockmap + latest.yml | Windows x64 原生 runner；Windows 10/11 目标环境安装验证 | 安装、启动、中文路径、数据库、知识读取、更新后重启 |
| macOS arm64 | DMG + ZIP + 更新描述 | 原生 Apple Silicon 环境 | 挂载/复制到 Applications、启动、资源读取、签名/公证、跨版本更新 |
| macOS x64 | DMG + ZIP + 更新描述 | 原生 Intel 环境或明确可用的对应 runner | 同上，原生模块实际加载 |

平台最小系统版本在第 1 项按 Electron 支持范围和运行证据确定。Windows ARM64 和 Linux 不在当前新增承诺范围。

### 构建与安装关口

1. 使用干净 checkout、锁文件和明确的源码 SHA，在目标操作系统构建。内部候选包与正式包使用分开的配置、目录和更新渠道。
2. 原生模块必须匹配平台/架构/Electron ABI；SQLite 实际建库读写，nodejieba 实际切词，rg.exe 实际执行。声明的关键资源缺失立即失败。
3. 建立专家包文件清单与哈希校验，覆盖模板、共享技能、词典、worker、WASM、专家资料；不以安装包大小猜测完整性。
4. Windows 必须运行 NSIS 安装程序，再从安装目录启动，而非仅执行 win-unpacked。测试中文用户目录、带空格路径、普通用户安装、启动日志及退出后再启动。
5. 开发/内部验证用独立 userData、测试数据库和专家运行副本。旧数据只经备份、迁移校验后进入正式新版。
6. 第 1 项若未通过，先报告可定位的失败原因；按仓库熔断规则停止扩展修改。确认是框架级限制后才重新讨论技术栈。

### 更新行为

状态：未配置 / 空闲 → 检查 → 有更新 → 下载 → 校验 → 待重启 → 安装。无更新和检查失败为不同结果。界面沿用 V3 设置布局，由真实事件更新进度。

- 默认后台检查和下载，安装前确认任务已停止或安全暂停；下载完成后让用户选择重启时间，保护运行中任务与未保存内容。
- 使用 electron-updater 的平台实现；生产更新地址为 HTTPS，按渠道和架构分开，候选包不读取 stable。当前尚无正式地址时显示“更新服务未配置”。
- macOS 自动更新需要签名；正式包采用 Developer ID 与公证，DMG 用于安装，ZIP 用于更新。Windows 正式包需要配置可用签名方案及发行者验证。[稳定版更新要求](https://www.electron.build/v26/docs/features/auto-update/)、[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)。
- 上传完整版本目录、校验文件存在和哈希后，最后切换渠道描述；保留旧版本文件，避免半上传与覆盖旧版本。
- 覆盖老桌面端时保持正式应用身份及数据路径。旧版只有网页下载提示，首次进入具备 updater 的新版需下载安装包；从该版本之后验证自动升级。
- 验收至少两个不同版本：安装 A → 检查 B → 下载 → 重启安装 → 确认 B 和原数据仍在。另测离线、下载中断、损坏文件、错误架构、无权限和运行中任务。
- 数据库升级前备份，迁移失败保留原数据。应用版本回退与数据库回退单独设计，不承诺 updater 自动降级。

缺少证书的内部包可用于开发和构建验证；未完成签名、系统安装信任及线上 A→B 实测时，交付状态保持“内部验证”，不能标为正式自动更新通过。

## 新版能力映射

| V3 界面 | 复用基础 | 必须补齐的真实行为 |
| --- | --- | --- |
| 专家管理、主页、档案 | AvatarManager、SoulLoader、专家包、导入/导出 | 区分可安装/已安装；创建遵循模板；真实运行记录 |
| 项目、知识库 | KnowledgeManager、检索、WorkspaceManager | 全局/专家私有资源、绑定与快照、文件索引及检索结果 |
| 记忆、技能、质量 | 记忆/技能管理、测试管理 | 原文件操作与可恢复版本；真实测试结果或明确未执行 |
| 对话、看板、审批、群组 | 会话/消息、模型服务、运行 trace、sub-agent 基础 | 共用任务 ID、执行取消、审批存储、真实成果、重启恢复 |
| 工作流与触发 | ScheduleStore、CronScheduler、工作区、trace | 定义/版本/运行存储、步骤调度、幂等；应用退出后的漏执行处理 |
| 连接器、IM、权限 | MCP/GitHub、已有导入/权限基础 | 独立适配器、真实授权/连接、收发/配对、执行前规则拦截 |
| 应用设置、更新 | 设置存储、日志、系统 API | 真实偏好、启动项、诊断及 updater 事件 |

当前 Agent Gateway 只产生运行计划，不直接调用模型。新版必须接入实际执行服务；原型按钮推进状态和“专业测试未执行”不能转换成生产完成记录。IM 与市场目录中只有实际适配器、凭据和外部回包通过检查的服务才能显示已连接。必要云端账号在对应阶段核对。

专业来源与测试继续保留；重复定时/对话一级入口按 V3 归并到工作流和统一任务。旧界面独立装饰/活动入口不迁入新版；对应历史数据先保留。

## 任务拆分计划

预计文件与行数用于判断规模，实施前按当前子任务细化。单项只修改该项涉及的源码；每项结束按 AGENTS.md 等待继续。

| 编号 | 子任务及验收 | 主要文件范围 | 规模/风险 |
| --- | --- | --- | --- |
| 1 | 新工程与双平台打包关口：最小 Electron 窗口、真实数据库/检索/专家资源 probe；Windows 安装版和 Mac 安装版验证 | desktop-next/package.json、锁文件、electron/main.ts、preload.ts、runtime-probe.ts、src/main.tsx、builder 配置、scripts/verify-install.*、.github/workflows/desktop-next-build.yml | 约 8–12 个源码/脚本、500–900 行；高，原生模块与 Windows runner 可用性 |
| 2 | 按 V3 复刻导航、专家管理/群组和主页，接入真实安装/导入/档案 | desktop-next/src/app/、components/、features/experts/、electron/ipc/experts.ts | 约 10–15 个源码、800–1500 行；中高，布局/旧数据映射 |
| 3 | 项目、知识、记忆、技能、专家设置/质量页，接入持久化与原文件 | desktop-next/src/features/resources/、electron/ipc/resources.ts、electron/repositories/、必要 core 接口 | 约 12–20 个源码、1500–2500 行；高，资料修改/版本与专家隔离 |
| 4 | 真实任务对话、看板、审批与群组执行；保留 hidden repair 与计费边界 | desktop-next/src/features/tasks/、electron/runtime/、electron/repositories/tasks.ts、shared/contracts.ts | 约 10–16 个源码、1200–2200 行；高，执行/恢复/取消/重复请求 |
| 5 | 工作流、版本、定时/事件/API 触发和运行记录 | desktop-next/src/features/workflows/、electron/workflows/、electron/repositories/workflows.ts | 约 8–14 个源码、1000–1800 行；高，调度/幂等/后台生命周期 |
| 6 | IM/连接器、权限和系统设置接入，按适配器逐项验收 | desktop-next/src/features/integrations/、settings/、electron/integrations/、permissions/ | 约 10–18 个源码、1200–2200 行；高，账号与外部服务依赖 |
| 7 | 自动更新状态/安装逻辑、稳定发布构建、数据迁移与双平台最终验收 | desktop-next/electron/updater/、src/features/settings/updates/、builder 生产配置、发布 workflow、迁移与升级验证脚本 | 约 6–12 个源码/脚本、600–1200 行；高，签名与正式地址尚缺 |

顺序：1 → 2 → 3 → 4 → 5 → 6 → 7。Windows 安装关口先于大规模页面迁移；资源先于任务上下文；统一任务先于工作流/IM；正式签名与跨版本验收最后闭合。

第 1 项可先完成本地 Mac 构建和脚本检查；Windows 安装结果必须来自可用 Windows 环境。若现有 GitHub runner 不可运行，提供诊断和可在 Windows 执行的明确验证入口，完成状态仍保留待验证，不能以 Mac 交叉生成的 EXE 补写通过。

需要远程验证源码时使用独立测试分支和内部构建产物，不覆盖 main、旧 release 或 stable 渠道。开发先隔离当前已有改动；正式迁移或发布需基于可审阅产物与验收结果。

## 最终验收记录要求

每项记录实际源码 SHA、依赖锁、宿主/架构、安装包哈希、运行路径、日志、截图和结果；状态区分已实现、构建通过、安装运行通过、正式签名通过、线上更新通过。

界面验收在真实 Electron 窗口完成，1440×900 与 1280×800 对照 V3；继续覆盖默认、空态/有数据、保存、错误、取消、弹窗、键盘和一条真实业务路径。浏览器预览、单元测试或 CI 编译都不能替代安装版验收。

方案制定阶段仅产出本方案。第 1、2、3、4 项实施已完成独立工程、真实专家与资源页面、真实任务执行、内部安装包和原生验证流程；当前结果见 [第 1 项验收记录](desktop-next-step1-qa.md)、[第 2 项验收记录](desktop-next-step2-qa.md)、[第 3 项验收记录](desktop-next-step3-qa.md)。第 4 项通过记录见 [第 4 项验收记录](desktop-next-step4-qa.md)。第 5 项等待继续，未发布正式更新。
