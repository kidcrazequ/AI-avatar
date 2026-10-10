# 第 4 项任务对话、看板、审批与群组执行

日期：2026-10-10。版本：`0.20.0-alpha.4`。状态：内部验收通过。Windows x64、Mac arm64、Intel 原生构建、实际安装、两次启动及任务恢复均通过。

实现工作区：`/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/`。最终安装包源码 `14a50d7538cd57e5aa4934917c723009de615b8c`；原生验证分支 `codex/desktop-v3-native-gate` 对应 `457fa0b43bebb6d1a21ee74b8cfbfa6643d43f3c`。desktop-next、workflow 和实际使用的旧模型/检索模块一致。[最终三平台验证](https://github.com/kidcrazequ/AI-avatar/actions/runs/38043861492)。

## 已实现

| 页面 / 能力 | 实际行为 |
| --- | --- |
| 专家 / 群组任务对话 | 从管理页、专家主页与会话侧栏发起；读取已安装专家的人格、操作规则、记忆、启用技能、绑定知识和项目快照；真实模型流式回答、文本附件、跟进、取消 |
| 任务看板 | 列表 / 五列泳道，专家、群组、状态筛选；对话、看板、主页、详情共用任务 ID，失败与中断保留实际状态 |
| 审批工作台 | 写入前保存正文、目标路径和哈希；批准 / 拒绝 / 取消持久化；拒绝或停止不写文件；重复客户端请求不重复执行 |
| 群组执行 | 成员依次执行，Leader 最后接收成员草案并核对汇总；各成员使用自己的专家资源、模型偏好和目录 |
| 成果 | 知识检索、原文 / 技能读取、限定目录的文本文件读取；成果只写入 `Soul-Outputs/<任务ID>/`，批准后独占创建、fsync，重启按哈希核对；原生保存框导出对话成果 |
| 模型配置 | 沿用旧版 Soul 的 OpenAI 兼容 / Anthropic provider；界面可配置模型或只读导入旧版对话配置，密钥由主进程 safeStorage 加密，IPC 与安装包不包含密钥 |
| 回答显示 | Markdown 正常排版；不执行模型 HTML，不加载远程图片，不导航模型生成链接；实际写入回执独立显示文件名、路径与哈希 |

原专家包的资料缺失和占位说明保留。不能把模型能调用或模板检索成功写成专业能力验收通过。任意 shell / MCP 工具、连接器和自动工作流尚属第 5、6 项。

## 执行、审批与恢复

任务使用 SQLite FULL 同步和 WAL 保存轮次、工具结果、审批与检查点。启动时将执行中的任务标记为中断；已完成轮次与工具结果保留，未完成请求的用量标记未知。用户明确继续后才发起新请求，不自动重放历史已完成请求。

模型名、服务地址和协议随任务保存；恢复时配置改变会停止并提示，更新同一服务密钥可继续。任务资源快照不随之后的专家记忆编辑改变。路径校验拒绝越界、隐藏文件、Windows 保留名称和符号链接。

内部空回答仅允许一次 hidden repair，修复轮不进入普通用户消息历史，实际返回用量按各轮分别记录；未知用量不编造。取消后迟到回包不能覆盖已停止任务。服务端是否仍计算被中断的请求无法由客户端确认。

受控 provider 验收与真实模型验收分别记录，前者不请求网络模型：

1. 10 组执行测试覆盖重复发送、hidden repair、群组次序、审批持久化与幂等写入、拒绝不写入、服务商重用工具 ID、模型配置变更、取消迟到回包、路径边界及资源快照。
2. 两个独立 Electron 进程验证进程退出时的检查点：跳过关闭钩子后重新启动，保留已完成检索轮及结果，只发起一个新的请求，用户消息仍是一条。
3. 安装版第一次启动留下待审批任务和执行中任务；第二次启动确认待审批未写文件、执行中转为中断，再通过实际 preload 继续和批准，两个任务完成。

## 本机真实模型与手工操作

用户明确授权沿用旧版模型。通过安装版原生选择框，只读导入旧版数据库的对话模型 `deepseek-v4-pro`（`api.deepseek.com`）。验收使用独立 profile 与版本控制内的专家资料，没有迁入旧会话或客户原件。

数据目录：`desktop-next/evidence/step4/manual-profile`；成果目录：`desktop-next/evidence/step4/manual-fixtures`。

| 真实任务 | 结果与证据 |
| --- | --- |
| 财研任务 `63ab3c15-09c7-4e22-9022-738575c98c19` | 实际调用 search_knowledge、read_knowledge、write_artifact；三轮后停在审批。真正退出并从后续安装版启动，同一任务、审批和正文哈希恢复，批准前文件不存在。批准后增加一轮请求，保留前三轮 ID，仅一条用户消息，实际生成一份文件 |
| 人研 + 财研群组任务 `d42dbbf1-9cd1-4b0b-940f-f0fa0afeea7a` | 原生界面安装人研、创建群组；人研先执行三轮，财研 Leader 再执行四轮。两位均实际检索并读取自己的知识，分别输出资料边界，Leader 汇总；同一任务 ID、一条用户消息、七轮实际用量 |

真实服务调用仅在本机 Mac 安装版完成；Windows / Intel 安装版使用明确标记的受控 provider 验证运行与恢复。本次未真实调用 Anthropic 服务。

实际文件：`Soul-Outputs/63ab3c15-09c7-4e22-9022-738575c98c19/真实模型验收.md`，SHA-256 `c6df036e7c1e8b86a7f0ddeb070a3deae694e6efb0a1876dff79e154786caaa9`。

真实模型识别财务与制度资料为虚构占位，未给财务数值或劳动法律结论。批准后的模型文字仍称“等待审批”，但 SQLite 与文件核验均确认已批准且完成写入；因此新增独立的实际写入回执，不修改模型原话、不追加伪装用户的修复消息。手工检查同时发现 Markdown 符号直接显示，已修正并加入安装版显示检查。

从最终显示修正安装版重启后，原生界面仍可打开两条真实任务，Markdown 排版正确；原生保存框导出的群组成果为 1688 字节，包含同一任务 ID 和两位专家的完整回答，哈希 `cdb7c1eefc138af03810875c0052a5d17a42403bb6ecfe530adfc88208344a13`。

原始证据：`real-before-restart.json`、`real-restored-before-approve.json`、`real-complete.json`、`real-group-complete.json`；仅含状态、轮次、来源和实际用量，不含模型密钥。执行来自 `988733b` 安装版，最终 `14a50d7` 仅修改回答 / 进度显示及其验收，执行模块一致。

## V3 布局与原生安装

基准：已确认的 `design-prototypes/soul-work-v3/`、`DESIGN.md` 和 QoderWake CN 实际页面。任务 / 看板样式直接沿用 V3，内容为 Soul 专家。

| 几何检查 | 1440×900 | 1280×800 |
| --- | --- | --- |
| 主导航 / 会话侧栏 / 顶栏 | 64 / 240 / 49px | 相同 |
| 输入框 | x488、y790、768×98 | x408、y690、768×98 |
| 看板标题 | x104、y32 | 相同 |
| 看板标签 / 筛选栏 | y118 / y182 | 相同 |

三平台每次启动还通过 9 组专家检查、9 组资源检查、2 项管理布局、2 项主页布局和 19 项资源页面 / 弹窗检查。任务检查第一次启动为 10 项、第二次为 14 项。

每次启动检查任务空态、看板、审批工作台、审批任务与中断任务五页 × 两尺寸；第二次启动另外检查恢复、正常 Markdown、无主动 HTML / 远程图片 / 链接和实际写入回执。专家 / 资源页面回归与 900 份资源校验继续执行。各平台系统中文字体不同，没有宣称跨系统字形逐像素相同。

Windows 首轮功能断言完成，但清理测试目录遇到 junction 权限错误；修正链接清理顺序后，原生任务测试、NSIS 实际安装、两次启动与卸载通过。一次本机任务测试与重建资源目录同时运行，读到正在替换的文件；停止并发重建后顺序重跑通过。没有把这两次失败记作通过证据。

## 安装包与最终证据

| 平台 / 原生宿主 | 实际安装路径与结果 | 安装包 SHA-256 |
| --- | --- | --- |
| 本机 Mac arm64，Darwin 25.4.0 | 挂载 DMG，复制到 `/Users/kian/Applications/Soul Next Verification 1791627016165/Soul Next.app`；两次启动与后续手工真实任务检查通过 | `dcc43fa80840e39d58121c9130f8c5f71b830484e54dbb8bde7564c85bc43ac9` |
| CI Mac arm64，Darwin 24.6.0 | `/Users/runner/Applications/Soul Next Verification 1791626980469/Soul Next.app`；DMG 安装与两次启动通过 | `43983c58d5c5b6983aad5c68b2131971e80f78a9dc04a92e1f0ba6681f53dcca` |
| CI Mac Intel x64，Darwin 24.6.0 | `/Users/runner/Applications/Soul Next Verification 1791627214189/Soul Next.app`；DMG 安装与两次启动通过 | `ab0d1fc49ccc30ea8184a21e7a09c56cbb3b0943667c5c4fac756230bcf77ee7` |
| CI Windows x64，Windows Server 2022 / 10.0.20348 | 原生 NSIS 安装到 `C:\Users\runneradmin\AppData\Local\Soul Next Verification 1791627156385\Soul Next.exe`，两次启动与卸载通过；保留验收数据 | `b1be1c79df9f14bc1db60a722a68613f44547cd461bd1a450ed208d8382e5bce` |

Windows 宿主使用 elevated 账户；上述结果不代表普通 Windows 10/11 用户的交互安装向导或 SmartScreen 信任已验收。Windows 与 Mac 各自按本平台检出的资源内容校验；Windows 换行差异没有被当作资源丢失。所有安装版包含并逐文件核验 900 份资源、10 个专家包。

- [Windows x64 安装程序](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/ci-windows-x64-457fa0b/soul-next-packages-windows-2022-457fa0b43bebb6d1a21ee74b8cfbfa6643d43f3c/Soul-Next-0.20.0-alpha.4-win-x64.exe)，136,282,842 字节，已核对下载后哈希。
- [Mac Apple Silicon DMG](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/Soul-Next-0.20.0-alpha.4-mac-arm64.dmg)。
- [Mac Intel 内部安装包](https://github.com/kidcrazequ/AI-avatar/actions/runs/38043861492/artifacts/11667246194)，CI 产物保留 7 天。
- [验收汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/step4/acceptance-summary.json)，原生证据位于 `native-complete-457fa0b/`。
- [真实协作截图](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/step4/real-group-installed.png)、[实际写入回执](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/step4/real-write-installed.png)。

## 发布边界

当前是独立身份的内部无签名包，未覆盖旧 Soul。正式 Developer ID、公证、Windows 签名、普通 Windows 10/11 用户信任和跨版本自动更新仍在第 7 项。依赖审计仍检出原生模块构建工具链的 node-pre-gyp / tar 间接问题，正式发行前处理；本次未扩大为旧工程依赖升级。

第 5 项工作流、触发与调度尚未开始。没有发布正式 Release、推送 main 或打发版标签。
