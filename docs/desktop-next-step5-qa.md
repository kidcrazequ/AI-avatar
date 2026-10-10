# 第 5 项工作流、版本与触发验收

日期：2026-10-10。版本：`0.20.0-alpha.5`。状态：内部验收通过。Windows x64、Mac arm64、Intel 原生构建、实际安装、两次启动与工作流恢复均通过。

实现工作区：`/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/`。最终源码 `976054bb37a25b86ecd8ea044a04f55c96b01f5b`；原生验证分支 `codex/desktop-v3-native-gate` 对应 `622ecd2539b8fd239c6d2659b0cecbf71226b721`。[最终三平台验证](https://github.com/kidcrazequ/AI-avatar/actions/runs/38048349676)。desktop-next、构建流程、900 份打包资源和实际复用的 5 个检索 / 4 个模型源文件一致，见 `desktop-next/evidence/step5/source-equivalence.json`。没有将其他未参与构建的旧 core 改动混入验收。

## 已实现

| 能力 | 实际行为 |
| --- | --- |
| V3 工作流页面 | 按已确认的 QoderWake CN / V3 复刻列表、画布、脚本、执行记录、详情配置、运行配置、版本历史与自动任务弹窗；专家主页入口保留专家范围 |
| 多专家执行 | 使用第 4 项真实任务引擎；步骤依次执行，后一步接收前一步草案；运行开始即固定所有步骤、专家、模型和资源快照；工作流、对话、看板、审批共用任务 ID |
| 版本与恢复 | SQLite 保存定义、配置版本、运行与幂等请求；恢复旧版本产生新版本并停用自动触发；历史运行继续使用原快照；移除可恢复 |
| 定时 | 一次、每日、每周、每月；按本机时区日历计算，31 日跳过没有该日期的月份；退出或长时间休眠期间的漏执行留记录，用户明确补跑后才执行 |
| Git 事件 | 检查本地目录指定分支的新提交 SHA；首次建立基线，相同 SHA 不重复触发；关闭时停止轮询并结束 Git 子进程 |
| 本地 API | 只监听 127.0.0.1；必须使用 POST、加密保存的令牌及 Idempotency-Key；拒绝网页 Origin、错误 Host、超大与超时正文；相同请求返回原运行，不重复调用 |
| 并发与超时 | 跳过未完成运行或按 FIFO 排队；排队时固定资源快照；任务页不能绕过排队；执行超时停止并保留记录，审批等待不消耗运行超时 |

应用退出后没有常驻后台服务。定时与 Git 只在应用运行时检查，重启展示漏执行，不自动重放；Git 尚未订阅远程 PR；API 端口随启动分配，是本机调用入口。恢复不会自动再扣已完成步骤的模型用量。

## 业务、布局与恢复

类型检查、构建通过。三平台各通过 11 组检查：顺序与幂等、旧版本与资源不变、漏执行不自动重放及一次补跑、FIFO 快照、跳过与取消、Git 基线和新 SHA 去重、API 边界、月末日期、超时、可恢复移除、原生进程退出与测试目录清理。随后使用两个独立 Electron 进程验证突然退出：已完成步骤保留，未完成轮次标记未知，启动不调用模型，用户继续后只增加一次请求。

安装版首次留下第一步完成、第二步执行中的工作流及退出期间的定时触发。第二次启动保留同一运行 / 任务 / 第一轮 ID，留下一个漏执行记录；明确继续后只执行未完成步骤，最终一条用户消息、两位专家产物。

三平台的工作流几何检查首次 12 项、第二次 14 项；覆盖 1440×900、1280×800 下的列表、画布、脚本、执行记录、详情配置与自动任务弹窗。主导航 64px、顶栏 49px、标签 225px、工作流卡片 140px、运行侧栏 335px、弹窗 800×(窗口高−64)。每次还执行 2 项专家管理、2 项主页、19 项资源页面与 10 / 14 项任务检查，以及 900 份资源、10 个专家包的逐文件核验。字形使用各平台中文字体，没有宣称跨系统字形逐像素相同。

## 本机真实执行

沿用用户已授权的旧版 Soul 模型 `deepseek-v4-pro`，密钥留在本机主进程加密存储，未写入源码、安装包或 CI。验收使用独立 profile 和版本控制内的专家知识，没有迁入客户原件。

通过人研的“创建自动任务”入口配置“第5项真实工作流验收”：人研先核查制度资料，财研再核查应收账款资料、综合前序草案并申请写入。两位实际调用知识检索与原文读取，保留资料占位限制，没有生成财务数值或劳动法律结论。

运行 ID `d82734be-62d2-4051-a94c-71b72f087252`；任务 ID `21091dda-756d-44be-b112-25ad552d98a4`；配置快照 v2。退出前六轮已完成，审批已保存。重新启动后六轮 ID、来源、用量与同一待审批记录保留，未新增请求，批准前文件不存在。批准后仅增加一轮请求，两位专家完成，一条原始用户消息、一份实际文件。

成果为 `desktop-next/evidence/step5/manual-fixtures/Soul-Outputs/21091dda-756d-44be-b112-25ad552d98a4/工作流真实验收.md`，314 字节，SHA-256 `3b6ab1a86737f3f9c9377b9395127dea9a97f82ade491eb5bcd651a5ba34de2c`，与审批正文一致。模型最终文字仍称等待审批；保留原文，由独立写入回执、数据库状态和文件核验确认完成，没有追加伪装用户的修复消息。

实际版本恢复 v1 → v3 后，自动触发关闭，已完成运行仍使用 v2、原目录与七轮记录，没有新增模型请求。从最终 976054b 安装版再次启动，七轮和成果哈希均保持不变。

本机真实执行来自 7ad261d / e7fbf86 安装版，最终 976054b 的业务代码与 e7fbf86 一致，仅调整验收目录管理。Windows / Intel 的模型、自动触发、运行中请求恢复使用受控 provider；真实服务调用只在本机 Mac 完成。本次真实模型退出时已进入审批，运行中请求的突然退出恢复由独立进程测试与三平台安装版验证。

证据位于 `desktop-next/evidence/step5/`：`real-start.json`、`real-before-restart.json`、`real-final-before-approve.json`、`real-complete.json`、`real-summary.json`、`real-version-restore.json`、`real-reopened-complete.json`、`real-workflow-final-installed.png`、`real-write-installed.png`。这些本机 profile 和真实模型记录未上传 CI。

## 安装包与原生证据

| 平台 / 宿主 | 实际安装路径与结果 | 安装包 SHA-256 |
| --- | --- | --- |
| 本机 Mac arm64，Darwin 25.4.0 | `/Users/kian/Applications/Soul Next Verification 1791631755434/Soul Next.app/Contents/MacOS/Soul Next`；DMG 安装、两次启动与真实工作流重启检查通过 | `c9ff92701e35350b3110c2f8825687ecf2f5b1b5d037a5eeda7cdcdbcd3d840e` |
| CI Windows x64，Windows Server 2022 / 10.0.20348 | `C:\Users\runneradmin\AppData\Local\Soul Next Verification 1791631817441\Soul Next.exe`；原生 NSIS 安装、两次启动与卸载通过，验收数据保留 | `8e3ecf565fb662df7fac18e374ffe3c89c20fa9bbac98dd616c24c9a69a27349` |
| CI Mac arm64，Darwin 24.6.0 | `/Users/runner/Applications/Soul Next Verification 1791631649189/Soul Next.app/Contents/MacOS/Soul Next`；原生 DMG 安装与两次启动通过 | `1d7ee5aa0eaee8287189ce3058ec4b5a58483599614d6829272d9d78f8250173` |
| CI Intel Mac x64，Darwin 24.6.0 | `/Users/runner/Applications/Soul Next Verification 1791631733246/Soul Next.app/Contents/MacOS/Soul Next`；原生 DMG 安装与两次启动通过 | `e4facd3c6ad06ee062be00e2f5909dca0068c99e1d9daea07708392bf885ff39` |

Windows 实测为原生 Windows Server 2022 elevated runner 上的 per-user 静默安装和卸载，中文 userData 与数据库保留通过；普通 Windows 10/11 用户安装向导及 SmartScreen 信任仍须正式发行时单独验收。Mac 使用原生 arm64 / x64 宿主挂载 DMG、复制后启动。Windows 换行与各平台包哈希差异按本平台构建清单核验，不以包体大小判断资源完整。

- [Windows x64 安装程序](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/ci-windows-x64-622ecd2/Soul-Next-0.20.0-alpha.5-win-x64.exe)，136,297,584 字节，下载后哈希与原生安装记录一致。
- [Mac Apple Silicon DMG](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/Soul-Next-0.20.0-alpha.5-mac-arm64.dmg)，157,758,418 字节，已核对实际安装记录。
- [Mac Intel 安装包](https://github.com/kidcrazequ/AI-avatar/actions/runs/38048349676/artifacts/11667779311)，CI 产物保留 7 天。
- [验收汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/step5/acceptance-summary.json)；三平台原始报告位于 `native-complete-622ecd2/`，本机最终安装位于 `desktop-next/evidence/mac-arm64-1791631755434/`。

## 修正与发布边界

先前发现公共样式覆盖工作流卡片高度，以及离线定时验收只留 1 秒导致预检期间过期，分别修正为明确样式优先级与 15 秒安排。Intel 的窗口尺寸调整后立即测量存在时序竞争，现等待视口达到目标并完成绘制再断言，保持原 V3 几何标准。

Windows 清理先补齐 Git 子进程关闭，仍报 EPERM；用户授权继续后，改由验收父进程在 Electron 完全退出后清理自己创建的目录，并处理测试 Git 文件只读属性。本轮记录 4 个只读文件，目录实际删除，11 项业务 / 清理检查、恢复、NSIS 安装、两次启动与卸载全部通过，没有跳过失败检查，也没有改变用户仓库文件权限。

当前是独立身份、无签名的内部包。正式 Developer ID / 公证、Windows 签名、系统安装信任及跨版本自动更新仍在第 7 项。没有发布 Release、推送 main 或打标签。第 5 项结束，下一项为第 6 项 IM / 连接器、权限和系统设置接入。
