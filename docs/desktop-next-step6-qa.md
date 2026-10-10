# 第 6 项 IM、连接器、权限与系统设置验收

日期：2026-10-10。版本：`0.20.0-alpha.6`。状态：开发、三平台原生构建与实际安装、两次启动、权限与恢复检查通过；本机安装版真实模型 / GitHub 审批读取通过。外部飞书账号实连待用户在应用配置，未标为实连通过。

## 实现与边界

- 以已确认的 QoderWake CN / V3 原型复刻 IM 会话、连接配置、配对弹窗、连接器市场 / 已安装、权限四页和通用设置；默认中文浅色，沿用 64px 主导航、240px 次级导航及原型卡片尺寸。
- 连接器使用 MCP SDK 1.32.1，通过 HTTP、SSE 或绝对路径 stdio 完成真实握手、工具发现和调用。GitHub 独立提供经授权的仓库树 / 文件读取。第三方市场卡片要求用户提供可用 MCP 服务，没有伪造 OAuth 或已连接状态。
- 连接器按专家隔离。所有外部工具调用保存参数、连接摘要和审批；批准后先持久化执行开始，再调用服务。结果已保存时恢复使用原结果，结果未知时停止并要求核对，不自动重复操作。服务的只读声明不是操作系统沙箱。
- 飞书使用官方 SDK 1.74.0 的自建应用机器人长连接；校验机器人能力，只接收用户文本，群聊必须 @ 此机器人。未知会话先配对，配对固定会话与发送人。每条消息对应真实任务引擎，消息 ID 与任务请求去重；回复留为草稿，经批准才发送并保存成功回执。
- 专家权限控制敏感路径、内置工具策略和模型白名单；写成果与外部调用始终审批。保留原有路径穿越 / 符号链接限制。关闭可选防护不能开放任意工具或 Shell。
- 系统设置接入实际开机启动项、运行任务期间的唤醒锁、主题、回复语言、默认工作目录、模型配置和诊断。用量来源于任务记录；不伪造账户额度。界面完整英文、远端环境 / 远端配置及其他 IM 适配器尚未接入，界面明确标示。
- 密钥只由主进程经系统加密保存，IPC 读取、诊断、资源包和 CI 均不返回密钥。

## 验收方法与当前结果

类型检查通过。18 项运行检查使用真实 Electron 原生 SQLite、实际本机 MCP HTTP 协议服务以及受控模型 / IM 适配器，覆盖权限隔离、敏感读取与真实成果路径、强制审批、模型白名单、真实握手、工具发现、审批前零调用、审批后一次调用、连接移除后复用已保存结果、配对 / 去重、草稿与配对恢复、回执 / 重复发送拒绝、结果未知恢复、发送人隔离和设置 / 唤醒行为。

另以三个独立原生 Electron 进程验证 IM 任务运行中未走正常关闭的进程退出，以及发送已开始但回执未保存时的进程退出；重启不调用模型、不重发；用户继续任务只增加一次模型调用，未知发送保留人工核对。受控适配器不等于飞书账号实连。

安装版在 1440×900、1280×800 检查连接器、权限、IM、偏好、系统、诊断、环境和更新八个页面，以及 800×565 的 IM 配对弹窗、设置 / 专家权限跨启动持久化；每次 18 项，继续执行第 2–5 项布局和恢复回归。

第一轮 Mac 安装检查发现提取原型样式时将小屏媒体规则误放到全局，宽屏连接器因此成为单列；已恢复原来的 1300px / 1100px 媒体条件。第二轮发现共享 `.dialog` 样式覆盖 IM 配对弹窗宽度；已为连接器 / IM 弹窗明确样式优先级，恢复 560px / 800px 原型尺寸。第三轮三平台全部通过，未放宽布局断言。

## 源码、安装包与原生环境

开发工作树代码 SHA：`6e7f5d0536ebea5d342cdece755b3ea047cf2b95`；独立原生关口 SHA：`74484a8c43b31be78b29ae2a965a0e564bff9533`。[三平台原生 CI](https://github.com/kidcrazequ/AI-avatar/actions/runs/38051494330) 全部成功。两个分支历史不同，已逐文件核对 107 个桌面 / 构建输入及实际使用的 5 个 core、4 个模型模块，构建输入一致，证据为 `desktop-next/evidence/step6/source-equivalence.json`。

锁文件 SHA-256：`1a4594a44248bf23a37882686deba272244a7439f33eaf1fe31a809eb592bf06`。Electron 44.7.0、原生 ABI 149，构建宿主 Node 24。每个平台使用锁文件安装、原生构建，没有用 Mac 交叉生成的 Windows EXE 充当验收。

| 环境 | 实际安装与启动 | 安装包 SHA-256 |
| --- | --- | --- |
| Windows Server 2022 x64，10.0.20348 | 原生 NSIS 每用户静默安装；安装目录 EXE 两次启动；中文数据目录；卸载成功、测试数据保留 | `b8b7c243fc108b5dc719382651863f6860c77ad873770741ea244fd7ad8f12c6` |
| Mac arm64 CI，Darwin 24.6.0 | 挂载 DMG，复制到用户 Applications，安装版两次启动 | `886a4d8c1f54db168921dee035c2e0b02705fbae51460f18bde67d5e70deba4c` |
| Intel Mac x64 CI，Darwin 24.6.0 | 挂载 DMG，复制到用户 Applications，安装版两次启动 | `7ef3c76370b18c1bfb6edae54486924f4eeb682918adf5f11baffc43b2087d72` |
| 本机 Mac arm64，Darwin 25.4.0 | 实际 DMG 安装，两次启动；另以安装版完成真实模型 / 连接器流程 | `031b38cd043b43ec07a3d9b03b9e49705d222375dff193b86f39ae6a4fab74ad` |

CI Windows 安装路径：`C:\Users\runneradmin\AppData\Local\Soul Next Verification 1791635052599\Soul Next.exe`；Mac arm64：`/Users/runner/Applications/Soul Next Verification 1791634826077/Soul Next.app/Contents/MacOS/Soul Next`；Intel Mac：`/Users/runner/Applications/Soul Next Verification 1791634996016/Soul Next.app/Contents/MacOS/Soul Next`。本机安装路径：`/Users/kian/Applications/Soul Next Verification 1791634810133/Soul Next.app/Contents/MacOS/Soul Next`。

三个 CI 平台各通过 18 项协议 / 权限 / IM / 设置运行检查、2 项独立进程恢复检查；每次安装启动通过 18 项本轮布局与持久化检查。第 2–5 项同时回归：管理 2 项、主页 2 项、资源 19 项、任务首次 10 / 重启 14 项、工作流首次 12 / 重启 14 项。900 个打包文件、10 个专家包、SQLite、nodejieba 原生模块及词典、ripgrep 和真实知识检索均通过。

安装报告、日志和截图归档在 `desktop-next/evidence/step6/native-complete-74484a8/`；本机在 `desktop-next/evidence/mac-arm64-1791634810132/`；汇总为 `desktop-next/evidence/step6/acceptance-summary.json`。Windows `uninstall.txt` 明确记录卸载通过。已下载的 Windows 安装包与验收报告哈希一致。

Windows runner 使用管理员令牌执行每用户安装，本轮没有完成普通 Windows 10/11 用户的交互向导、SmartScreen 信任测试；Mac 未签名候选包也没有完成公开下载后的 Gatekeeper 信任测试。

## 安装版真实模型与连接器流程

沿用用户已授权的旧 Soul 模型配置，主进程加密保存，模型为 `deepseek-v4-pro`。在本机实际安装版 UI 中安装财研，配置公开 GitHub 读取连接，创建任务 `79c575da-f1bb-4a4f-9fc5-368b1ffe5f02`：发现工具 → 请求读取当前关口源码的 `desktop-next/package.json` → 等待审批 → 退出应用 → 重启 → 核对原审批 → 重新连接同一服务 → 批准读取 → 完成回答。

重启前的 2 个模型轮次与待审批参数保持不变，重启本身新增模型调用为 0；批准后仅新增 1 个模型调用和 1 次完成的外部读取。只有 1 条原始用户消息，没有隐藏修复污染，也没有写出成果或外部修改。返回包名 `soul-desktop-next`、版本 `0.20.0-alpha.6`，文件来源为 [实际读取的 GitHub 文件](https://github.com/kidcrazequ/AI-avatar/blob/74484a8c43b31be78b29ae2a965a0e564bff9533/desktop-next/package.json)，blob SHA `097b063893c11812763d237800967fb29a66c4db` 与对应 Git 对象一致。

证据：`desktop-next/evidence/step6/real-before-restart.json`、`real-restarted.json`、`real-complete.json`、`real-summary.json`，以及 `github-connected-installed.png`、`github-pending-approval-installed.png`、`github-real-task-complete-installed.png`。这些本机证据没有上传为 CI 账号数据。

## 外部飞书与发行状态

用户确认有飞书自建机器人。已在安装版打开飞书机器人配置表单；App ID / Secret 应由用户在本机填写，不在对话提供。账号长连接、外部消息配对、真实模型草稿、批准回复及重启实测仍待完成。需要外发时只针对用户明确授权的测试会话执行；受控协议测试不会记为飞书账号实连。

MCP SDK 已升级到 1.32.1，修复本轮引入依赖的高危公告。最终依赖审计仍有原生安装链沿用的 `@mapbox/node-pre-gyp` / `tar` 高危与严重级条目，未扩大范围替换原生依赖；正式发行前需单独处理并重跑原生构建。审计记录为 `desktop-next/evidence/step6-audit-final.json`。

Developer ID / 公证、Windows 签名和线上自动更新待第 7 项。当前仅内部候选包，不发布 Release、不推送 main、不打标签。
