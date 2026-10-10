# 第 3 项资源与专家设置：内部验收通过

日期：2026-10-10。版本：`0.20.0-alpha.3`。当前实现位于 `/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/`；本机安装包源码为 `1ce6ea4e7a99f2d8fed9c4946fc519fba614a3cd`。原生验证分支为 `codex/desktop-v3-native-gate`，源码 `8de0ccad358ef5e02dbb13556a908d0d4044a85b`；两者的 desktop-next 与本次 workflow 文件一致。

[三平台原生验收](https://github.com/kidcrazequ/AI-avatar/actions/runs/38039120194) 全部通过。原始证据已下载到 `desktop-next/evidence/step3/native-complete-8de0cca/`，汇总为 `desktop-next/evidence/step3/acceptance-summary.json`。第 2 项证据没有用于证明本次新增资源功能。

## 已实现与真实数据

| 页面 | 行为与持久化 |
| --- | --- |
| 公开 / 专家私密项目 | 真实 SQLite 保存、公开复用、专家私密隔离；验证本地目录存在、来源重复、HTTPS Git 地址；编辑、可恢复移除 |
| 全局 / 专家知识库 | 读取真实专家和共享资料，新建独立知识库，导入 Markdown / 文本，预览原文件与 SHA-256，编辑、冲突检测、移除与恢复；绑定写入独立 avatar.config.json |
| 记忆 | 四组记忆编辑；保留原有前言和其他章节；完整文件编辑、版本原文、历史恢复，恢复生成新版本 |
| 技能 | 专属 / 自有公共 / 已收录社区技能真实目录；按名称、说明、类别搜索与分页；配置、移除、上传单文件 Markdown；local > shared > community 优先级保留 |
| 专家设置 | SQLite 与独立配置保存名称、简介、模型偏好；分段或完整编辑 soul.md；AGENTS.md 只读预览；配置导出 |
| 质量验证 | 实际文件结构、知识资料、技能引用、测试用例检查与导出；专业模型测试始终显示“未执行” |

安装包声明的 900 份资源、10 个专家包逐文件校验长度与哈希。资源来源为受版本控制的专家包、共享目录与模板；忽略的 `_raw`、个人记忆和未纳入版本控制的私有原件不隐式打包。资料界面的数量以实际可读取的 Markdown / 文本为准，不能把浏览器原型的内嵌数量当作安装包数量。

专家资源编辑写入独立 profile 的 avatars 副本；专家包正本和共享技能不被编辑。路径校验拒绝越界、符号链接和 Windows 保留文件名；文档使用 SHA-256 版本冲突检查。模型、任务执行与 Git 仓库同步仍按后续阶段接入。

## 布局与安装版检查

视觉基准为已确认的 `design-prototypes/soul-work-v3/DESIGN.md` 与 `QA-step3.md`，来源是用户提供的 QoderWake CN 实际页面。沿用白底、64px 主导航、240px 专家侧栏、标题、分段标签、表单、卡片和弹窗，内容为 Soul 专家。

| 检查项 | 1440×900 | 1280×800 |
| --- | --- | --- |
| 全局项目 / 知识库标题 | x104、y32、28px | 相同 |
| 专家资源标题 | x392、y50、28px | x344、y50、28px |
| 专家设置标题 | 30px | 30px |
| 专家内容宽度 | 960px | 896px |
| 技能首张卡片 | x392、y321、228×154 | x344、y321、212×154 |
| 项目弹窗 | 640×537 | 640×537 |
| 记忆版本弹窗 | 980×720 | 980×720 |

每个平台的每次启动检查 8 页 × 2 尺寸、2 个弹窗，并保存实际安装目录应用的截图；确认 DM Sans 加载、无横向溢出、真实 preload IPC 可用。查看了 Mac 设置 / 项目弹窗及 Windows 技能 / 记忆截图，与 V3 的布局基准核对。汉字沿用参考的系统字体回退，Windows Server 与 macOS 的汉字字形不同；本次没有宣称跨系统逐像素字形相同。

第一次安装版检查发现资源弹窗被管理页通用 `.dialog` 宽度覆盖为 880px，已将资源弹窗样式明确限定到自身类，保持 V3 尺寸；修复后的完整原生流程通过。

## 原生构建、实际安装和重启

| 平台 / 宿主 | 实际路径与结果 |
| --- | --- |
| 本机 Mac arm64，Darwin 25.4.0 | 挂载 DMG、复制到 `/Users/kian/Applications/Soul Next Verification 1791622207565/Soul Next.app`、卸载 DMG，从安装目录启动两次；通过 |
| CI Mac arm64，Darwin 24.6.0 | 原生构建、DMG 安装到用户 Applications、两次启动；通过 |
| CI Mac Intel x64，Darwin 24.6.0 | 原生构建、DMG 安装到用户 Applications、两次启动；通过 |
| CI Windows x64，Windows Server 2022 / 10.0.20348 | 原生构建 NSIS、实际按用户安装，从 `C:\Users\runneradmin\AppData\Local\Soul Next Verification 1791622303834\Soul Next.exe` 启动两次；通过；卸载删除程序且保留验证数据 |

三平台均通过 9 组专家管理检查、9 组资源检查、900 份资源完整性、SQLite、nodejieba、ripgrep、真实知识检索与管理 / 主页回归。安装版经 preload 保存财研记忆，第二次启动确认记忆与版本记录保留。运行时为 Electron 44.7.0、Node 24.21.0、ABI 149。

Windows runner 使用 elevated 账户；没有把此结果写成 Windows 10/11 普通终端、交互安装向导或 SmartScreen 信任已通过。

| 安装包 | SHA-256 |
| --- | --- |
| 本机 Mac arm64 DMG | `fbf81c346796caadc9bdd7517c084b34f7b508a95ed788d4f9bd8d2f1dcc568a` |
| CI Mac arm64 DMG | `b1ad5945d2b2fdce904e510f09db0c8088f6bcde935c0ada0599cf34fb987d14` |
| CI Mac Intel DMG | `828e5af0d37f61aa40d04c3ca8f0e4af970eba1893dc6c868be6455b71c70e5c` |
| CI Windows x64 EXE | `41beddbd5c04eab32dff06acd3cc9cd9655126550dfc78e991c1b6c09fbb5879` |

Windows EXE 已下载并核对安装报告哈希，135,406,057 字节。构建资源哈希包含各平台检出的实际文件内容；Windows 的换行方式与 Mac 不同，均按各自打包清单核验。

## 本机安装窗口的手工交互

独立数据目录：`desktop-next/evidence/step3/manual-profile`，不是原桌面端用户数据。

1. 创建“第3项原生安装验收”公开项目，保存存在的本地来源目录；重启后项目仍在。
2. 创建“第3项验收资料库”，通过系统原生文件选择器导入“验收资料.md”，保存 109 字节正文；重启后可以预览原文、来源与 `9e89d55dbdffd5c226216275374bf826cb19279e44eeabf8bc86611c4b5674f7` 哈希。
3. 财研绑定新知识库，绑定数 2→3；重启后保留。
4. 编辑财研“用户偏好”，版本页同时保留原始前言、偏好 / 纠偏 / 项目 / 决策章节及新内容；Escape 关闭后恢复入口焦点；重启后主页显示保存的记忆。
5. 有效技能可安装；随后选择缺少 frontmatter 的无效文件时清除有效草稿并禁用安装按钮。重新选择有效文件，成功安装 `step3-native-check` 专属技能；重启后主页为 6 项配置并显示 local 来源。
6. 修改财研简介，保存后回显；真正退出并以相同测试目录重新启动，管理页与主页均显示新简介。
7. 手动运行结构检查，显示实际文件 / 5 个测试用例与 6 项技能配置；专业测试仍为“未执行”。

前一轮资源验收因重复扫描、空 YAML 分组和错误的 HR 出厂技能假设而停止。用户明确授权继续后，测试改为比较 HR 修改前后实际技能配置，资源检查 9 组全部通过；未为迎合测试修改 HR 专家包。

## 安装包、证据与后续范围

- [Windows x64 安装程序](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/ci-windows-x64-8de0cca/soul-next-packages-windows-2022-8de0ccad358ef5e02dbb13556a908d0d4044a85b/Soul-Next-0.20.0-alpha.3-win-x64.exe)
- [Mac Apple Silicon DMG](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/Soul-Next-0.20.0-alpha.3-mac-arm64.dmg)
- [Mac Intel 内部安装包](https://github.com/kidcrazequ/AI-avatar/actions/runs/38039120194/artifacts/11665670378)，CI 产物保留 7 天。
- [本机安装记录](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/mac-arm64-1791622207565/installation.json)
- [三平台证据汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/step3/acceptance-summary.json)

当前为内部无签名验证包。Developer ID、公证、Windows 签名、正式更新服务及 A→B 自动更新留在第 7 项。第 4 项真实任务执行尚未开始；本次未迁移旧用户数据、未覆盖旧应用、未发布 Release 或 stable 更新。
