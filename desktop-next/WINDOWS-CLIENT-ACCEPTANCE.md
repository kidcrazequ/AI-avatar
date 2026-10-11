# Soul Next Windows 10 / 11 普通用户原生验收

本轮只验证内部未签名安装包。生产签名和生产更新地址保持未配置；升级使用本机 `127.0.0.1` 的受控服务。

## 接入两台原生环境

Windows 10 x64 与 Windows 11 x64 各准备一台真实电脑或原生 Windows 虚拟机。使用专用普通用户账号：该账号不能属于本地 Administrators 组，即使没有右键“以管理员身份运行”，管理员账号也不会通过。

1. 登录该普通用户的桌面，在普通 PowerShell 中操作。测试账号不能已有 Soul Next 安装；验收会拒绝覆盖既有安装。
2. 打开仓库的 [新增 self-hosted runner 页面](https://github.com/kidcrazequ/AI-avatar/settings/actions/runners/new)，选择 Windows / x64，按页面当前指令下载并解压 runner 到该用户可写目录。
3. 复制页面给出的 `config.cmd` 注册命令，末尾加入对应参数。注册令牌只在该主机使用，不发到聊天、不写入仓库。

| 主机 | 注册命令末尾加入 | 默认标签 |
|---|---|---|
| Windows 10 | `--name soul-win10-standard --labels soul-win10-standard --unattended` | 保留 `self-hosted, Windows, X64` |
| Windows 11 | `--name soul-win11-standard --labels soul-win11-standard --unattended` | 保留 `self-hosted, Windows, X64` |

4. 在该普通用户的桌面 PowerShell 中执行 `./run.cmd`。不要配置为系统服务，不能使用 Session 0，也不要使用管理员账号启动。两台主机测试期间保留桌面登录及 runner 进程。
5. GitHub runner 页面两台显示 Online 后，反馈“两台已上线”。无需提供密码、密钥或注册令牌。

流水线只通过手动 `scope=client` 调度这两个专用标签，不将 PR 或推送自动分配到这些主机。验收 Node 24 工具安装在 runner 用户目录；JS 依赖使用 `--ignore-scripts`，不在普通用户主机安装编译工具或请求提权。

## 验收顺序

1. 原生 Windows 构建主机先构建 `0.20.0-alpha.7` 和受控 `alpha.8`，实际验证升级并记录两个 NSIS 安装包及升级后 EXE / app.asar 的 SHA-256。
2. 两台客户端分别核对工作站系统、OS 名称及 build、x64 架构、非管理员身份和桌面会话。Server、错误版本、管理员及 Session 0 会失败，不能产生成功收据。
3. 在普通账号下实际执行 per-user NSIS 静默安装，启动安装后的 EXE 两次，核对资源与任务恢复；实际卸载并验证测试数据保留。
4. 新的独立测试安装验证真实更新发现、坏校验包拒绝、下载、备份、实际 NSIS 替换；等待安装器退出，核对安装后 EXE / app.asar，再启动和重启。
5. 对比 19 张业务表、26 个知识文件、冻结任务来源及整理记录和用量。CI 使用受控模型与 IM，不读取正式账号的模型配置或发送外部消息。

测试均使用唯一的 `%LOCALAPPDATA%\Soul Next Verification ...` / `Soul Next Upgrade ...` 目录及独立资料目录。成功时测试应用卸载，测试数据和备份保留用于核对。安装向导逐页点击、SmartScreen 公开下载信任及生产签名更新不属于这份静默安装收据。

## 触发与证据

```sh
gh workflow run desktop-next-build.yml --ref codex/knowledge-import-source -f scope=client
```

结果附件 `soul-windows-client-10-evidence-<commit>` 与 `soul-windows-client-11-evidence-<commit>` 必须分别包含 `windows-client-10/acceptance.json` / `windows-client-11/acceptance.json`，其中 `ok=true` 才是对应系统通过。还会保留实际环境、两个安装后启动、卸载及升级前后收据；主机未接入或任务排队不能记为通过。
