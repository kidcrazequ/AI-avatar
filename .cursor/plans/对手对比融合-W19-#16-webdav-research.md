# 外部 WebDAV 同步参考报告（#16，2026-05-09）

> 所有信息基于 2024–2026 年公开源码、官方文档与 Issue。每节标注来源 URL 与抓取日期（2026-05-09）。
> 由 docs-researcher subagent 整理，仅列外部事实，不为 Soul 出方案。

---

## 一、Cherry Studio（CherryHQ/cherry-studio）

- **同步范围**：是「**全量备份/恢复**」而非真正的双向同步。备份包含 Redux state（assistants / topics 元数据 / settings / providers / MCP / 知识库）+ IndexedDB（Dexie：messages / message blocks / 知识库条目 / memory / OpenTelemetry traces）+ 文件系统（`getFilesDir() / getNotesDir() / getConfigDir()`）。**显式排除**：运行时 UI state、缓存目录、临时文件、session tokens、MCP 二进制依赖、Python 包。
- **频率/触发**：手动 + **可配置自动间隔**（Settings → Data → Backup & Sync）；进程内通过 IPC（`Backup_BackupToWebdav` / `Backup_RestoreFromWebdav` / `Backup_ListWebdavFiles` / `Backup_CheckConnection`）。文件名形如 `cherry-studio-backup-YYYY-MM-DD-HH-mm-ss.zip`，带 device-type 后缀。
- **冲突策略**：**无双向 merge**。全量 zip 快照按时间戳命名，restore 前 `closeAllDataConnections()` → 解压 → 跑 state migration → `relaunchApp()`。冲突由"用户选择哪份快照"解决。
- **凭据/数据加密**：早期 plain-text，2025 已统一迁移到 Electron `safeStorage`（Issue #11934）；备份内容侧另有 AES（`src/main/utils/aes`，`Aes_Encrypt` / `Aes_Decrypt` IPC）；启动日志脱敏（只输出 `{ enabled, host, port, hasApiKey }`）；`electron-store` 配置从 `userData/config.json` 移到 `userData/Data/config.json` 以纳入备份（PR #13587）。
- **WebDAV 客户端库**：`webdav`（perry-mitchell/webdav-client）。HTTPS rejectUnauthorized 可关闭以兼容自签证书。
- **关键源文件**：`src/main/services/WebDav.ts`、`src/main/services/BackupManager.ts`、`src/main/ipc.ts`（L595–613, L805–810）、`packages/shared/IpcChannel.ts`、`src/preload/index.ts`。
- **额外能力**：除 WebDAV 还有 S3-compatible（`backupToS3` 等）、LAN P2P（`LocalTransferService`，TCP 直传）两条线。
- **来源**：
  - https://github.com/CherryHQ/cherry-studio/blob/2e7b605b/src/main/services/WebDav.ts
  - https://deepwiki.com/CherryHQ/cherry-studio/8.5-backup-and-restore
  - https://github.com/CherryHQ/cherry-studio/issues/11934
  - https://github.com/CherryHQ/cherry-studio/pull/13587
  - https://github.com/CherryHQ/cherry-studio/pull/2522
  - https://github.com/CherryHQ/cherry-studio/pull/6922
  - https://github.com/CherryHQ/cherry-studio/pull/7347
  - 抓取日期：2026-05-09

## 二、Obsidian Remotely-Save（remotely-save/remotely-save）

- **同步范围**：vault 内所有 markdown / 附件 / 二进制文件，**真正的双向同步**（同时支持「increment-push only」「increment-pull only」「bidirectional」三种方向）。
- **算法**：v3 sync algorithm（替代 v2 的纯 mtime 比较）。核心特性：
  - **真正的删除状态计算**（"true deletion status computation"）：本地维护"删除日志"以区分"新文件 vs 远端有但本地已删"，解决 v2 一边删了一边以为是新文件的回灌问题。
  - **不再写远端 metadata**（v2 会在远端额外存元数据，v3 移除）。
  - **同步保护**：触发阈值（如一次要删 N 个文件以上）会发警告而非直接执行。
  - 旧库自动迁移到新 db。
- **冲突策略**：可选「keep newer」「keep larger」（v3 已实现）；「keep both and rename」「show warning」标为待办；PRO 版有 "smart conflict handling"。
- **已知坑**（issues #991 / #708 / #677）：双向模式下本地删除有时不能可靠传到远端（依赖最后编辑设备）；文件夹删除非原子（先删内容再删空文件夹）；mobile↔︎desktop 初次同步后增量异常。
- **加密**：v3 引入了新加密方法（替换 v2 的 OpenSSL 兼容方案），仍是端到端，密码本地不上云。
- **大文件 / 二进制**：通过 size mismatch 检测；无内置分块 chunk upload，受 WebDAV server 限制。
- **来源**：
  - https://github.com/remotely-save/remotely-save
  - https://raw.githubusercontent.com/remotely-save/remotely-save/master/docs/sync_algorithm/v3/intro.md
  - https://github.com/remotely-save/remotely-save/issues/991
  - https://github.com/remotely-save/remotely-save/issues/708
  - https://github.com/remotely-save/remotely-save/issues/677
  - https://github.com/remotely-save/remotely-save/issues/120
  - 抓取日期：2026-05-09

## 三、Joplin（laurent22/joplin）

- **同步范围**：notes / resources / tags / notebooks，文件级。
- **算法**：**enhanced basic delta**。客户端在本地 SQLite 表里**存每个远端文件的 mtime**，对比 PROPFIND 列表来判断 create/update/delete；增强版还能识别 "timestamp 变小"，避免与 Syncthing 等并行写入产生静默丢失（PR #13054 修复 #6517）。仅扫描 sync 根目录下 32 字符文件名 + `.md` 的 Joplin 自有文件，过滤掉 Syncthing 等非 Joplin 标志文件。
- **冲突策略**：检测到冲突时，**新建 "Conflict notebook"**，把本地版本复制进去，本地原 note 用远端版本覆盖；用户在 Conflict notebook 里手动比对 / 拷贝丢失的改动。
- **E2EE**（值得参考）：两层结构——
  - **Master Key**：随机生成的 256-byte（2048-bit）主密钥，被用户的 Master Password 经 KDF 派生密钥后加密。
  - **数据加密**：Master Key 加密 notes / resources。密文 ASCII 编码兼容跨平台。
  - 加密方法版本枚举：SJCL / SJCL2..4 / SJCL1a/1b → 现行 KeyV1 / FileV1 / StringV1（原生 Node crypto）。同一 vault 可有多个 master key（解密用），但**只能一个是激活态**（加密用），加密后的 master key 本身也同步到云端。
- **可观测性**：每次同步显示最后同步时间、冲突笔记数；CLI 也有同步状态命令。
- **来源**：
  - https://github.com/laurent22/joplin/blob/dev/packages/lib/Synchronizer.ts
  - https://github.com/laurent22/joplin/blob/6edc74ed/packages/lib/file-api.ts
  - https://github.com/laurent22/joplin/pull/13054
  - https://github.com/laurent22/joplin/issues/6517
  - https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/e2ee/native_encryption.md
  - https://joplinapp.org/help/apps/conflict
  - https://joplinapp.org/help/dev/spec/server_delta_sync/
  - 抓取日期：2026-05-09

## 四、Node.js / TypeScript WebDAV client 库对比

| 库 | 周下载 | 最新版/日期 | TS 类型 | bundle / 依赖 | Auth | 流式/断点续传 | Electron 案例 |
|---|---|---|---|---|---|---|---|
| **`webdav`**（perry-mitchell） | **114.1K** | **5.9.0 / 2026-02-04** | 原生 TS, MIT, 800★ | 纯 JS，无 native；ESM；Node 14+（v5）| Basic / Digest / OAuth Bearer / 自定义 header | createReadStream / createWriteStream，**无原生 chunk upload**；有 ETag/If-Match 支持 | **Cherry Studio** 在用 |
| `tsdav` | ~5K | 2.x / 2025 | 原生 TS，支持 Node ≥18 / browser / Bun / Deno / CF Workers | 较新，无 native | OAuth2 + Basic | 流式 ✓ | 主打 CalDAV/CardDAV |
| `webdav-fs`（perry-mitchell） | 637 | 4.0.1 | 部分 TS | 包装 `webdav`，提供 Node `fs` 风格 API | 同 `webdav` | 流式 ✓ | 适合需要 fs 接口的场景 |
| `@fatrex/nextdav` | <100 | 0.3.0 / 2024-03 | TS | 体积小，主打 Nextcloud | Basic | 基础 | 不推荐生产 |
| 自实现 `fetch + PROPFIND/PUT/MOVE` | — | — | 自写 | 0 依赖 | 自定义 | 需自写 | Electron 主进程可用，但要自行写 XML 解析（multistatus）|

**社区共识**：`webdav` 是事实标准，体积小、TS 类型完整、Cherry Studio 在用，是最稳的选择；`tsdav` 在多 runtime（含 browser/Edge）场景更通用；自实现仅在追求 0 依赖且只用基础 verbs 时考虑。

- **来源**：
  - https://www.npmjs.com/package/webdav
  - https://github.com/perry-mitchell/webdav-client
  - https://github.com/perry-mitchell/webdav-client/blob/master/CHANGELOG.md
  - https://github.com/natelindev/tsdav
  - https://github.com/perry-mitchell/webdav-fs
  - https://www.npmjs.com/package/webdav-fs
  - 抓取日期：2026-05-09

## 五、WebDAV 协议要点（实现侧）

- **必备 HTTP verbs**：`GET` / `PUT` / `DELETE` / `MKCOL`（建目录）/ `PROPFIND`（列目录+元数据，XML）/ `MOVE` / `COPY`；可选 `LOCK` / `UNLOCK`。RFC 4918。
- **服务器兼容性**：

| 服务器 | quirks |
|---|---|
| **坚果云（Jianguoyun）** | **不支持 `Depth:infinity`**（默认按 `Depth:1` 处理且不返 403）；**单次 PROPFIND 最多 750 个文件/文件夹**；**频率限制**：免费版 30 分钟 600 次，付费 1500 次；单文件 ≤ 500 MB。**中国用户首选**，必须做分页 + 限速。 |
| Nextcloud / OwnCloud | 不完全支持 `Depth:infinity`（XML 可能 50MB+，ETag 错误），官方建议递归 `Depth:1` |
| Synology DSM / Drive | 需手动启用 `Depth:infinity`；URL 含 `+` 字符会被错误解码为空格 |
| Apache `mod_dav` / Nginx WebDAV | 标准支持，LOCK 视配置；nginx 需 `nginx-dav-ext-module` 才完整 |
| Box / TeraCloud / Yandex | 各有路径长度、文件数限制 |

- **变更检测**：优先 **ETag**（PROPFIND 返回 `getetag`），其次 `Last-Modified`（`getlastmodified`）。WebDAV 不强制 ETag，部分服务器（含坚果云）ETag 行为不稳定，**应当 ETag + mtime + size 三项联合**。
- **大文件**：协议无标准 chunk upload；Nextcloud 有自定义 chunked upload v2，OwnCloud 也有专属扩展，跨服务器不通用。坚果云没有官方 chunk 协议，超 500 MB 必须切片到多文件。
- **HTTPS**：非强制，但生产环境必须；自签证书是 Electron 主进程常见痛点（`webdav` 库可传 `httpsAgent` 关闭校验）。
- **来源**：
  - RFC 4918（https://www.rfc-editor.org/rfc/rfc4918）
  - https://help.jianguoyun.com/?tag=webdav
  - https://content.jianguoyun.com/664.html
  - https://owncloud.github.io/apis/http/webdav/
  - https://github.com/nextcloud/server/issues/5947
  - https://github.com/nextcloud/server/issues/42932
  - https://github.com/nextcloud/server/issues/10123
  - https://github.com/apache/opendal/issues/4256
  - 抓取日期：2026-05-09

## 六、加密方案（凭据本地存储）

- **Electron `safeStorage`（2026 现状）**：
  - macOS：Keychain；Windows：DPAPI；Linux：`gnome-libsecret` / `kwallet5/6`，**无可用 keyring 时回退 `basic_text`（硬编码明文，等于不加密）**。
  - 必须：调用前 `safeStorage.isEncryptionAvailable()`；用 `getSelectedStorageBackend()` 检查若返回 `"basic_text"` 则向用户告警。
  - **Flatpak**：推荐 `org.freedesktop.portal.Secret` 后端（Issue #50534），不用申请 D-Bus 通配权限。
  - **优先用 async API**（`encryptStringAsync` / `decryptStringAsync`），sync 版本可能未来 deprecate。
- **已知 case study**：Cherry Studio Issue #11934 完整迁移到 `safeStorage` + 自动迁移老明文；Obsidian 自身把同步密钥放在 vault 外的 OS keychain；Joplin 用用户主密码派生密钥（不依赖 OS keyring）—— 三种典型路线。
- **来源**：
  - https://www.electronjs.org/docs/latest/api/safe-storage
  - https://github.com/electron/electron/issues/50534
  - https://github.com/electron/electron/issues/47436
  - https://github.com/electron/electron/pull/38873
  - https://github.com/electron/electron/blob/main/docs/api/safe-storage.md
  - 抓取日期：2026-05-09

## 七、跨设备时钟漂移与冲突

- **理论**：vector clock / Lamport timestamp 在文件同步几乎不用；主流方案是「mtime + size + hash」三元组 + 服务器端单调序号（如 Joplin Server cursor）。
- **简化方案缺陷**："最后写入获胜（LWW）"在客户端时钟漂移时会**默默吞掉改动**；改进做法是 LWW + **保留败方副本到 `.conflict-YYYYMMDD-HHMMSS` 后缀**。
- **用户友好的冲突 UI**：
  - **Obsidian**：`<original>.sync-conflict-YYYYMMDD-HHMMSS.md`，1.9.7+ 可选「自动 diff-match-patch 合并」或「生成冲突文件」；MD 文件用 Google diff-match-patch 算法自动三方合并。
  - **Joplin**：自动建 "Conflict notebook"，把本地副本搬进去，原 note 用远端覆盖；冲突计数显示在状态栏。
  - **Remotely-Save**：v3 默认「keep newer / keep larger」二选一；PRO 有 smart resolution。
- **来源**：
  - https://retypeapp.github.io/obsidian/sync/troubleshoot/
  - https://retypeapp.github.io/obsidian/sync/settings/
  - https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution
  - https://forum.obsidian.md/t/robust-sync-conflict-resolution/93544/7
  - https://joplinapp.org/help/apps/conflict
  - 抓取日期：2026-05-09

## 八、不该自动同步的共识

- **SQLite live 文件（含 `-wal` / `-shm`）**：WAL 模式下三文件强一致，简单 `fs.copyFile()` **创建即损坏**（scottspence.com case study）。SQLite 官方明确：**网络文件系统（含 WebDAV）不能跑 live SQLite**，WAL 需要共享内存，不能跨主机。正确做法：调用 `sqlite3_backup_*` API 或在线 `VACUUM INTO`，**导出为静态 .sqlite 快照后**再丢上 WebDAV。
- **日志/缓存/临时文件**：所有参考实现（Cherry Studio / Joplin / Obsidian）都**显式排除**。理由：体积大、写入频繁、对其他设备无意义。
- **Session token / API key 短期凭据**：Cherry Studio 显式排除 session token（要求重新登录），但通过 `safeStorage` 加密的 long-lived API key 会进备份。
- **二进制依赖（Python / Node modules / MCP server bin）**：Cherry Studio 排除，避免跨 OS 不兼容。
- **来源**：
  - https://sqlite.org/howtocorrupt.html
  - https://www3.sqlite.org/useovernet.html
  - https://sqlite.org/wal.html
  - https://scottspence.com/posts/sqlite-corruption-fs-copyfile-issue
  - 抓取日期：2026-05-09

---

## 九、关键 Takeaway（事实清单）

1. **Cherry Studio 走的是"全量 zip 快照 + 时间戳"路线，不是真正双向同步**——以"用户选快照"代替算法冲突解决，是 Electron 桌面 AI 应用的最简可行解，已生产验证。
2. **真正的双向同步必须有"删除日志"**：Remotely-Save v3 引入 "true deletion status" 是为了修 v2 因「不知道是删了还是新出现」而误回灌的痛点。
3. **变更检测建议 `ETag + mtime + size` 三项联合**，单靠 mtime 会被坚果云/时钟漂移坑；ETag 也不能独信（部分服务器不规范）。
4. **`webdav`（perry-mitchell）是事实标准**：周下载 114K、原生 TS、MIT、Cherry Studio 已在用、2026-02 还在更新，桌面 Electron 主进程首选。
5. **坚果云三大限制必须前置处理**：30 分钟 600 次速率、单 PROPFIND ≤ 750 项、单文件 ≤ 500 MB、不支持 `Depth:infinity`——中国用户场景必须自己分页 + 限速 + 大文件切分。
6. **`safeStorage` 在 Linux 可能回退 `basic_text`（明文）**，必须用 `getSelectedStorageBackend()` 检测并告警；Flatpak 走 `portal.Secret`。
7. **SQLite live 文件绝对不能直接 PUT 到 WebDAV**：跨网络共享会损坏，且简单 `fs.copyFile` 在 WAL 模式下当场损坏；必须先 `VACUUM INTO` / backup API 导出静态快照。
8. **冲突 UI 主流是"生成 `.conflict-时间戳` 后缀文件"**（Obsidian 默认、Joplin 用 Conflict notebook 变体），不要用静默 LWW；Markdown 可考虑 diff-match-patch 自动三方合并。
9. **Joplin E2EE 两层密钥结构**（随机 master key + 用户密码派生 KEK 加密 master key）是值得借鉴的端到端模板：master key 本身可同步，密码不出本地。
10. **三大开源项目共识的"不同步清单"**：缓存、临时文件、运行时日志、session token、二进制依赖、live SQLite 文件；同步的是配置 + 数据导出快照。
