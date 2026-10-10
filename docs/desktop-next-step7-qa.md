# 第 7 项自动更新、发行构建与数据升级验收

日期：2026-10-10。内部版本：`0.20.0-alpha.7`。开发、类型检查、16 项更新 / 迁移运行检查、三平台原生安装与两版本升级内部验收通过。正式签名、Mac 签名自动安装和线上 HTTPS 更新仍待凭据与发布地址，未记为通过。

## 本项实现

- 保持 QoderWake CN / V3 通用设置布局，更新页接入检查、发现、下载进度、校验就绪、取消、重启安装和错误状态。未配置、尚未检查、无更新和检查失败分别显示。
- 使用锁定的 `electron-updater 6.8.9`，通过真实平台 updater 校验下载内容；不改写原生签名验证。自动检查 / 下载持久化；普通退出不自动安装，安装需确认，运行任务 / 工作流及外部发送期间拒绝安装。
- 升级前停止新操作、关闭后台触发与 IM 入口，备份 SQLite 和应用自有资料后调用原生安装器。备份包含已提交 WAL 数据及哈希清单；外部工作目录保留原位。
- 首次打开旧 Soul Next 数据时先备份，再以事务建立 schema v2 和更新偏好表；保留任务、轮次、审批、资源、权限、模型密文、IM 和工作流记录。重复启动不重复迁移，更高 schema 拒绝打开，保护原数据。
- 独立正式构建要求稳定版本 / 锁文件一致、准确已有标签、原生架构、HTTPS 渠道及平台签名配置，Mac 同时要求公证。校验平台对应 EXE / ZIP / DMG 的 metadata 与 SHA-512，并生成 SHA-256 清单。工作流只产出待验收包，发布仍是单独动作。
- 沿用已验收的 Soul Next 安装身份和独立数据目录。此前方案中“覆盖旧 AI分身身份”的设想与当前独立新版冲突，以已安装和持续升级验证的新客户端为准；旧版 `xiaodu.db` / 会话库没有被自动覆写或声称完成全量迁移。已有专家包导入和模型导入入口继续保留。

## 验收区分

16 项运行检查使用受控 updater 事件驱动以及真实 Electron SQLite / 文件系统，验证未配置不请求、HTTPS / 无凭据地址、明确安装、运行中拦截、离线 / 损坏包 / 备份失败、安装器启动失败、Mac 签名关口、跨启动偏好、取消下载、自动下载不重启、WAL 备份、原审批 / 已保存模型轮次与用量记录保留、幂等和高 schema 保护。此项不替代真实安装升级。

原生两版本脚本从实际安装版 `alpha.7` 检查内部 `alpha.8` 测试包。Windows 使用本机协议服务与实际 electron-updater → 校验下载 → 备份 → NSIS 替换 → 两次启动；Mac 验证实际 updater 发现 → 备份 → DMG 覆盖安装 → 两次启动。两版本测试包来自同一源码，版本差异专用于升级验证，不能当成正式 `alpha.8` 发布。

Mac 当前包未签名，界面阻止自动安装；没有绕过 Squirrel.Mac 签名检查。内部回环协议测试不能计为公网 HTTPS 自动更新。Windows 原生 runner 的管理员令牌 / 静默安装仍不能替代普通 Windows 10/11 用户的向导与 SmartScreen 验收。

Windows 本轮 updater 使用显式静默安装，测试关闭 force-run；更新后两次启动由验收脚本执行。正式构建配置已为安装向导提供默认安装后启动选项；该生产配置只做了结构检查，实际签名安装向导和自动拉起仍需正式包验收。

Windows 升级验收的数据目录位于安装目录外，避免 NSIS 清理程序文件时破坏测试数据。未配置发行源的内部 A 包没有 builder 生成的 `app-update.yml`；只有指定绝对隔离 profile 和回环验收 feed 后，测试模式才使用 SDK 的测试配置入口补齐缓存目录。正式发行包拒绝内部升级验收模式，继续读取 builder 生成的签名与发行者配置。损坏包验收必须实际到达 checksum 校验，不能用任意下载错误冒充通过。

Intel Mac 首轮升级验收遇到 hosted runner 虚拟显卡初始化失败（`UnknownVizError`），已将软件渲染启动参数限定在 GitHub Actions 的 Intel 升级脚本；普通安装版验收仍单独运行，不更改产品的硬件加速设置。

Windows 后续升级检查发现验收端 `@electron/asar` 会缓存归档文件头；替换文件后继续用旧文件头可能产生 JSON 读取错误。已在本机用两个真实 ASAR 文件复现，并对版本轮询每次清除文件头缓存；安装目录、目标版本和后续两次启动 / 数据保留断言保持原要求。

本机实际 `alpha.6` 使用数据先经 SQLite backup 复制到隔离目录，再由安装版 `alpha.7` 迁移。包含 1 条真实模型已完成任务、1 条模型配置密文；15 张业务表与专家记忆哈希一致，迁移生成 schema 备份，第二次启动为 schema 2 → 2 且不重复备份。仅在副本调整专家显示名和更新偏好以满足共用验收入口；真实数据不上传 CI，不读取或展示密钥。此项验证 Soul Next 数据，不等同旧 AI分身 `xiaodu.db` 全量迁移。

## 原生验收与交付证据

[最终三平台原生 CI](https://github.com/kidcrazequ/AI-avatar/actions/runs/38056072732) 全部成功。验收开发源码：`e11d3663b994237f3ca6dc9221798f5823007497`；原生关口源码：`2b4e9b1b47ac5d468aae885f37c3920ec0b66c6d`。两个工作树的 114 个桌面 / workflow 文件、实际引用的 5 个 core 与 4 个模型模块逐文件核对一致。本机安装包源码为 `3a9055c8064aebef42248d8b9cefc77d7864aff7`，其后仅修改 Windows 验收脚本的 ASAR 缓存读取，产品运行输入相同。验收后补充的正式 NSIS 启动选项属于未执行的生产配置，不纳入内部安装通过结论。

锁文件 SHA-256：`787085928b0073be93a2098e6199acb8c04372565b0c6bc3118805300a04acfa`。构建宿主 Node 24，Electron 44.7.0 / ABI 149，electron-builder 26.15.3，electron-updater 6.8.9。没有以 Mac 交叉生成 EXE 代替 Windows 原生验收。

| 环境 | 实际安装及升级 | `alpha.7` 安装包 SHA-256 |
| --- | --- | --- |
| Windows Server 2022 x64，10.0.20348 | 原生 NSIS 安装、两次启动、卸载保留数据；真实 updater 下载 / SHA-512 拒绝损坏包 / 备份 / NSIS 替换为 `alpha.8` / 两次启动；15 张业务表、记忆和偏好保留 | `0dd30cfb7e6a33b8c513e1e861f4ecda8daf400874fb08c210bff50556a9775e` |
| Apple Silicon Mac CI，Darwin 24.6.0 | DMG 安装、两次启动；真实 updater 发现 `alpha.8`，备份后 DMG 覆盖安装、两次启动，数据保留 | `e5f1f4cffb1dae1e7fa486952b58cfdd604ff8c9ee7ad8b46ddfdc5178e56605` |
| Intel Mac CI，Darwin 24.6.0 | 同上；升级脚本使用软件渲染，常规安装版单独验收 | `ecbd1016f50b082ca7dd407b9f0cb37c7e4c8d3bdb81c5a5007a6024212c2404` |
| 本机 Apple Silicon Mac，Darwin 25.4.0 | 实际 DMG 安装、两次启动；最终安装版真实 `alpha.6` 数据副本迁移及再次启动通过 | `ed9a2c3081ee6937020194cc924cf0dede4c443134a1c999698d6620c037b6ae` |

三平台各通过 16 项更新 / 迁移检查；每次实际安装启动通过 19 项连接 / 权限 / 设置布局与偏好检查，覆盖 1440×900、1280×800。第 2–6 项回归同时通过：管理 2、主页 2、资源 19、任务首次 10 / 重启 14、工作流首次 12 / 重启 14 项。900 个资源文件、10 个专家包和实际 SQLite、nodejieba / 词典、ripgrep、知识检索检查通过。

原生证据归档：`desktop-next/evidence/step7/native-complete-2b4e9b1/`；汇总：`desktop-next/evidence/step7/acceptance-summary.json`；真实数据迁移：`final-v6-migration.json`、`final-v6-migration-restart.json`。下载到本机的 Windows EXE 和 Intel Mac DMG 哈希与实际安装报告一致。`alpha.8` 只作为内部升级测试包，不是正式发布版本。

最终本机安装路径：`/Users/kian/Applications/Soul Next Verification 1791638286489/Soul Next.app`。已用原使用数据的另一个备份副本打开正常运行模式的“更新应用”页，原 profile 保留；界面显示财研已安装、1 个已保存模型、当前 `alpha.7` 和更新服务未配置。后续可使用 `desktop-next/evidence/step7/启动新版Soul.command` 继续打开该副本，不需要重新输入原模型密钥。

生产依赖审计目前为 0 条漏洞，已把原生安装链的 tar 锁定至 7.5.22 并验证本机原生模块重建。完整审计仍有 10 条开发依赖告警（1 high、8 moderate、1 low），正式发行前需单独处理 Vite、esbuild 与 builder 工具链；未把生产依赖审计结果写成全工程无漏洞。

用户已明确飞书实连稍后配置，沿用第 6 项范围。本项不调用真实飞书账号、不发布 Release、不推 main、不创建标签。

正式签名 workflow 目前为新分支中的构建模板，尚未在默认分支启用，未执行正式签名 / 公证构建。后续配置凭据、稳定版本标签和正式 HTTPS 地址后，还需安装信任、公开地址 A → B 自动更新、错误架构及安装权限场景验收。
