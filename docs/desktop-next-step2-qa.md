# Soul V3 桌面端：第 2 项验收记录

日期：2026-10-10。版本：0.20.0-alpha.2。状态：第 2 项内部开发、原生构建、实际安装、两次启动与布局检查通过。Windows x64、Mac arm64、Mac Intel 三个平台均通过，正式签名和自动更新仍待后续验收。

## 实现与视觉基准

本项只覆盖 V3 主导航、专家管理、群组配置、专家主页和原始档案查看。实施工程在 `/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/`；实施源码 `e8e8e327218887c59fd602130fe6934a7b8774ab`，原生验收源码 `80e9adb6b8c96d871381b652816c430a4dfed880`。两分支本项工程及复用资源内容一致；远程分支未携带本地 main 的其他历史，未创建正式 Release。

实际查看 QoderWake CN 的管理页与专家主页，并以已确认 V3 原型为复刻基准。V3 文件：`/Users/kian/备份/AI/soul/design-prototypes/soul-work-v3/index.html`，SHA-256 `b4e9f1be2d1c0b41b2b19838f7a2f88f8213864f247c019490f2455483d59758`。白色背景、DM Sans 字体、灰色导航、图标、卡片、主页区块与弹窗布局沿用 V3；安装状态与正文换成真实 Soul 资料。

| 检查项 | V3 基准 |
| --- | --- |
| 主导航 / 专家侧栏 | 64px / 240px，侧栏从 x=64 开始 |
| 管理卡片 | 高 149px；1440 宽时卡片 x=104、y=226、宽 315px |
| 主页 1440×900 | 页面 x=392、宽 960px；身份区高 210px |
| 主页 1280×800 | 页面 x=344、宽 896px；身份区高 210px |
| 工作 / 记忆 | 工作区 y=280、高 348px；记忆区 y=644 |

原型测量记录：`desktop-next/evidence/step2/reference-layout.json`。管理与主页在真实安装版 Electron 中验证两个窗口尺寸，并保存截图；浏览器原型截图不作为桌面运行证据。

## 真实业务行为

- 从打包的 10 个真实专家包读取名称、领域、介绍、人格、知识文件与技能引用；实际安装状态来自 SQLite，不使用原型模拟状态。
- 安装与新建专家复制完整资源到独立运行副本；修改名称、记忆和群组配置可在重启后保留。移除采用可恢复标记，保留资料与原始群组成员关系。
- 导入使用原生目录选择器，校验完整专家包后保存不可变预览副本；确认导入加入可安装目录，安装后读取独立副本。路径穿越、符号链接、重复 ID 与 Windows 保留目录名被拒绝。
- 群组保存已安装成员、Leader、模型偏好与本机工作目录；模型偏好不表示模型已连接或群组执行已接入。
- 首页人格来自 soul.md，技能来自真实索引，档案由受限 IPC 读取原文件，记忆来自当前副本。工作记录尚未接入，统计显示“—”，不生成虚构任务记录。
- 创建角色模板遵循仓库人格、操作规则、知识索引和测试模板，保留用户原文及 5 份待补充测试用例；以不可安装的角色草案保存。专业测试没有执行，不能当作质量验收通过。

用户原桌面数据与旧 desktop-app 未迁移；本项界面手工验收只写独立 manual-profile，测试内容不写入专家包正本。

## 验证结果

类型检查通过；本机原生 Electron 下 9 组专家数据检查通过：真实目录、完整安装副本、群组有效性、重启恢复、可恢复移除、完整导入、档案路径约束、角色草案与原文保留、Windows CRLF 模板兼容。详细结果：`desktop-next/evidence/experts-darwin-arm64.json`。

真实桌面手工操作已通过：新建“桌面验收财研”、安装财研、创建两成员群组与 Leader/目录配置、退出再启动保留；创建并保存角色草案；原生目录选择器预览“导入验收专家”（16 文件、24.7 KB）、确认导入、安装并打开真实主页；档案弹窗与 Escape 返回。相关数据保存在 `desktop-next/evidence/step2/manual-profile`。

首轮原生验收发现并修复两处问题：Mac runner 的经典滚动条占宽造成主页 x 偏移 7.5px；Windows checkout 的 CRLF 导致测试模板围栏匹配失败。页面主滚动条不再占布局宽度，模板读取统一换行；仍保留滚轮与键盘滚动，并新增 CRLF 行为回归检查。修复后的验收：[三平台原生执行记录](https://github.com/kidcrazequ/AI-avatar/actions/runs/38035558749)。

| 原生环境 | 专家数据检查 | 实际安装 / 两次启动 | 布局检查 |
| --- | --- | --- | --- |
| Windows Server 2022 x64（10.0.20348） | 9 组通过 | NSIS 安装退出 0；安装目录 EXE 两次通过；卸载保留测试数据库 | 1440×900、1280×800 通过 |
| Mac arm64 CI（Darwin 24.6.0） | 9 组通过 | DMG 安装到用户 Applications；两次通过 | 同上 |
| Mac Intel CI（Darwin 24.6.0） | 9 组通过 | DMG 安装到用户 Applications；两次通过 | 同上 |
| 本机 Mac arm64（Darwin 25.4.0） | 9 组通过 | 最终 DMG 安装；两次通过 | 同上 |

CI 三个 job 均 success；Windows 的 elevated=true，这证明原生每用户安装路径可用，尚不代表 Windows 10/11 普通用户的安装信任已实测。各安装版均通过 SQLite、nodejieba、词典、rg、真实 core 检索与 900 个声明资源校验；退出后启动计数为 1、2。财研主页显示 5 项真实技能配置、7 个档案文件，字体正常、无横向溢出，主页尺寸与上表 V3 基准一致。

界面局部状态采用 React state，目录与群组持久化在主进程 SQLite；原方案的 Zustand 保留为后续全局任务状态候选，本项没有引入额外状态依赖。

本轮验收对应版本为 0.20.0-alpha.2。第 1 项记录保持原有证据，不将旧版本启动记录当作本项通过证据。旧 desktop-build-win.yml 同分支运行仍失败，保留为旧构建流程的后续清理项；本项结论来自上述新工程原生安装关口。

## 安装包与证据

本机 DMG：[Soul Next 0.20.0-alpha.2 arm64](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/Soul-Next-0.20.0-alpha.2-mac-arm64.dmg)。实际安装应用：[Soul Next.app](</Users/kian/Applications/Soul Next Verification 1791618705594/Soul Next.app>)。

Windows 安装包：[Soul Next 0.20.0-alpha.2 x64](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/release/ci-windows-x64/soul-next-packages-windows-2022-80e9adb6b8c96d871381b652816c430a4dfed880/Soul-Next-0.20.0-alpha.2-win-x64.exe)。Mac Intel 与其他 CI 原生包可从 [构建产物](https://github.com/kidcrazequ/AI-avatar/actions/runs/38035558749) 获取；远程 artifacts 保留 7 天，三平台证据均已保存到本机。Windows 安装包已下载，SHA-256 与原生实际安装的 EXE 一致。

| 安装包 | SHA-256 |
| --- | --- |
| Windows x64 原生 CI EXE | fe95adba69387cc54927801a3b1fb84b9d39997c4aaba80955cb54f4b0adfb5c |
| Mac arm64 原生 CI DMG | 98268f74f5f84c3407f2a5a48d788423d994a42be663db1c7af3fcfe9384aec7 |
| Mac Intel 原生 CI DMG | d251b7739b8d9a83da725e20543ddbf3784ab700978daf84dc3848138969396a |
| 本机 Mac arm64 DMG | 64838fe4f362ced332dd7b64aeddb728a92dfec12ce5773bd67fceee46dd67fa |

Mac 锁文件 SHA-256：0273dd3b7aa35dd0f171fe4e8a508576eb6639c52285f9586bf180da065d5ae8。Windows checkout 的 CRLF 版本为 54157075b037d22dd276e080f3295255f4c9d8738271b43d551cece0737ff98b；依赖版本一致，各自构建清单记录实际字节。


- [Windows 安装汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-windows-2022-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/windows-x64-1791618576201/installation.json)；[第一次启动](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-windows-2022-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/windows-x64-1791618576201/launch-1.json)；[第二次启动](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-windows-2022-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/windows-x64-1791618576201/launch-2.json)
- [Windows 卸载与数据保留](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-windows-2022-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/windows-x64-1791618576201/uninstall.txt)

- [Mac arm64 安装汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-macos-15-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/mac-arm64-1791618463000/installation.json)；[第一次启动](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-macos-15-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/mac-arm64-1791618463000/launch-1.json)；[第二次启动](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-macos-15-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/mac-arm64-1791618463000/launch-2.json)

- [Mac Intel 安装汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-macos-15-intel-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/mac-x64-1791618645583/installation.json)；[第一次启动](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-macos-15-intel-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/mac-x64-1791618645583/launch-1.json)；[第二次启动](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/ci-80e9adb/soul-next-evidence-macos-15-intel-80e9adb6b8c96d871381b652816c430a4dfed880/evidence/mac-x64-1791618645583/launch-2.json)

- [本机 Mac 安装汇总](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/mac-arm64-1791618705594/installation.json)

- [本机管理页截图](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/mac-arm64-1791618705594/window-1440x900-2.png)；[财研主页截图](/Users/kian/.codex/worktrees/desktop-v3-step1/soul/desktop-next/evidence/mac-arm64-1791618705594/home-1440x900-2.png)

## 后续边界

第 3 项资源编辑、技能/记忆/质量/设置页尚未开始。任务执行、工作流、连接器和正式更新在后续子任务接入。当前内部包没有正式签名、公证或线上 A→B 自动更新验收；Windows 10/11 普通用户及交互安装向导仍需后续验证。
