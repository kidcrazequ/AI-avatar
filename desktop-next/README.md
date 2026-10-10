# Soul Next — V3 桌面工程

以已确认的 Soul V3 / QoderWake CN 原型为界面迁移基准。已实现专家管理、群组配置、专家主页，以及项目、知识库、记忆、技能、专家设置和质量页，使用真实专家包、独立安装副本与本地 SQLite。任务执行与模型连接按后续子任务实现。

本工程应用身份为 `com.soul.desktop.next.validation`，名称 `Soul Next`，版本 `0.20.0-alpha.3`。普通启动使用独立的 `SoulNextValidation` 数据目录；安装验证使用显式测试目录。原 `desktop-app/` 与现有用户数据不参与迁移。

## 构建

使用 Node 24、锁文件和对应平台原生宿主。React / TypeScript / Vite 沿用原工程锁定版本；Electron 固定 44.7.0、electron-builder 固定 26.15.3、SQLite 固定 13.0.3。旧 SQLite 12.9.0 在 Electron 44 下出现 V8 API 编译错误，因此仅新工程升级 SQLite，数据库读写兼容性由安装版检查验证。

```sh
cd desktop-next
npm ci
npm run typecheck
npm run dist:mac   # macOS 原生构建 DMG + ZIP
npm run verify:experts # 使用原生 Electron 验证专家数据与重启恢复
npm run verify:resources # 实际文件、资源隔离、版本恢复与设置持久化
npm run verify:mac -- release/Soul-Next-0.20.0-alpha.3-mac-arm64.dmg # Intel 改为 mac-x64.dmg
```

Windows x64 上执行：

```powershell
cd desktop-next
npm ci
npm run typecheck
npm run dist:win
npm run verify:experts
npm run verify:resources
npm run verify:win
```

Windows 脚本实际运行 NSIS 安装程序，再启动安装目录内的 EXE；验证中文、空格数据路径以及重启后的数据库记录；最后运行卸载程序并保留测试数据。它不会将 `win-unpacked` 启动当作安装通过。无签名的 CI 包仅供内部验证，当前脚本走静默安装；交互安装向导及 Windows 10/11 终端信任验收另行记录。

Mac 脚本挂载 DMG、复制 `.app` 到当前用户 Applications 的独立目录、卸载 DMG，再运行安装后的应用。验证包不修改系统安全策略。安装程序和数据保留供复查，证据在 `evidence/`。

## 验证内容

1. 10 个专家包，已纳入 Git 的专家、共享资源、模板逐文件比对长度和 SHA-256；空 `.gitkeep` 占位不属于运行资源。打包时生成完整清单。忽略的 `_raw` 原件、个人记忆、缓存不隐式纳入安装包。此清单覆盖安装版声明资源，不代表所有本机私有原件已经迁移。
2. SQLite 实际建库、事务写入、读回中文字段、完整性检查；两次启动必须得到连续计数 1、2。
3. nodejieba 原生模块实际加载、五个词典文件长度与 SHA-256 比对、中文分词；Windows 中文安装路径使用既有 core 的安全降级规则，避免 C++ ANSI `fopen` 导致整个进程退出。
4. 对打包的 `rg` 可执行文件实际执行版本命令和中文资料检索。
5. 复用 `packages/core` 的真实 KnowledgeRetriever，检索仓库中财研的虚构测试示例并确认来源文件和词条；该示例只用于溯源检查，不作为财务事实。
6. 安装后的 Electron 加载 React 和真实 preload IPC；1440×900、1280×800 检查字体、64px 导航、资源卡片、溢出与 Node 隔离，保存管理页与财研主页截图。主页同时比对 V3 的侧栏、页面、身份区、工作记录与记忆区尺寸。

7. 专家包安装与完整复制、创建、群组、重启恢复、可恢复移除、目录导入、档案路径约束和角色草案。角色草案保留模板约束与 5 个待补充测试用例，不能安装运行；模型、任务与专业测试状态不会伪装成已连接或已执行。

8. 资源文件与知识库绑定、公开/私密项目、记忆分组及版本恢复、技能配置优先级与上传、基础设置与人格文件、专业测试未执行状态；检查版本冲突、路径约束、跨专家隔离和关闭数据库后的恢复。
9. 安装后的 8 个资源/设置页面在 1440×900、1280×800 下逐页检查 V3 几何和字体，检查项目与记忆版本弹窗；经真实 preload 保存财研记忆，第二次启动检查文件与版本记录保留。

每次验证输出实际 EXE/app 路径、宿主系统、Electron / Node / ABI、源码 SHA、锁文件哈希、资源哈希和检查结果。检查失败使进程和 CI 失败。`build-inputs.json` 还记录此次实际复用的 core 文件哈希。

## 远程验证

`.github/workflows/desktop-next-build.yml` 使用原生 Windows x64、Mac arm64、Mac Intel runner，验证成功后上传内部安装包及证据。独立验证分支为 `codex/desktop-v3-native-gate`，不发布 GitHub Release 或更新通道；每项架构必须与宿主相同。

第 7 项才接入正式 updater、旧数据迁移、签名、公证及 A→B 更新验收。当前未配置签名身份或更新服务，不能标为正式自动更新完成。

文档依据：[原生 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[稳定版打包文档](https://www.electron.build/v26/)、[SQLite Electron API 修复](https://github.com/WiseLibs/better-sqlite3/pull/1475)。
