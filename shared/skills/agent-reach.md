---
name: agent-reach
description: >-
  使用 Agent Reach 为分身获取互联网内容。在用户要求全网调研、搜索、查找、
  读取链接、查看 GitHub/YouTube/B站/V2EX/RSS/网页，或提到 Twitter/Reddit/
  小红书/雪球/LinkedIn 等平台内容时触发；先运行 doctor 识别可用后端，再调用
  对应上游工具获取资料。本技能只负责联网取数与读取内容，不负责报告写作、翻译、
  发帖、评论或点赞。
---

# Agent Reach — 互联网内容获取

> **级别**：[■■] 进阶
> **版本**：v1.0
> **最后更新**：2026-06-25

---

## 技能说明

当用户需要联网搜索、读取网页、查看视频字幕、检索 GitHub、读取 RSS，或查看社交/社区平台讨论时，使用本技能。Agent Reach 是路由和体检层，实际读取由上游工具完成。

## 触发条件

在以下场景应读取并遵循本技能：

- 用户说“全网调研 / 搜 / 查 / 找 / research / 看看大家怎么说”
- 用户给出任何 URL，希望读取、总结或核验内容
- 用户提到 GitHub、YouTube、B站、V2EX、RSS、网页、Twitter/X、Reddit、小红书、雪球、LinkedIn、小宇宙播客
- 用户需要跨平台收集公开资料、舆情、帖子、视频字幕、仓库 Issue/PR、文章或订阅源内容

**触发关键词**：全网调研、联网搜索、搜索、查一下、链接、网页、GitHub、YouTube、B站、V2EX、RSS、Twitter、推特、Reddit、小红书、雪球、LinkedIn、小宇宙、播客、字幕。

## 前提条件

- 本机已安装 `agent-reach` CLI，可用 `agent-reach doctor --json` 体检；如果桌面端环境报 `command not found`，改用 `~/.local/bin/agent-reach doctor --json`。
- 已安装的零配置/基础渠道优先使用；需要登录态的平台必须让用户提供 Cookie、浏览器登录态或明确授权配置。
- 临时输出放 `/tmp/`，持久配置放 `~/.agent-reach/`；不要在当前项目工作区创建抓取中间文件。

## 执行流程

1. 先运行：

```bash
agent-reach doctor --json
```

2. 根据 `status` 和 `active_backend` 选择后端。`ok` 直接使用；`warn/off` 只在用户明确需要该平台时再引导配置。
3. 开始联网前，简短说明使用的 Agent Reach 平台和后端。
4. 对全网调研任务，优先组合 Exa 搜索、网页阅读、GitHub、YouTube/B站、RSS/V2EX 等已可用渠道；社交平台只有在后端可用且具备登录态时使用。
5. 取回资料后，标注来源链接或平台；不确定或未能访问的渠道要明确说明。

## 常用命令与工具

```bash
# 全网语义搜索
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'

# GitHub 搜索
gh search repos "query" --sort stars --limit 10

# YouTube 视频信息/字幕
yt-dlp --dump-json "URL"
```

任意网页、Jina Reader、V2EX API、B站公开 API 等 URL 读取，优先使用 Soul 的 `web_fetch` 工具，不要用 `curl/wget`；这些通用网络命令在桌面端 shell 白名单中默认禁用。

## 可选渠道配置

- Twitter/X：需要 `twitter-cli` 或 OpenCLI，并通常需要 Cookie。
- Reddit：无零配置路径，必须登录态；桌面优先 OpenCLI。
- 小红书：桌面优先 OpenCLI，服务器可用 xiaohongshu-mcp；未配置时不要假装已搜索，直接提示用户需要执行 `agent-reach install --channels opencli` 并完成浏览器扩展/登录态配置。
- 雪球：需要登录 Cookie。
- LinkedIn：基础公开页可用网页读取；完整职位/Profile 需要 LinkedIn MCP。
- 小宇宙播客：需要转录脚本、ffmpeg 和 Groq API Key。

如需安装或更新可选渠道，参考：
https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md

## 禁止事项

- 不要为联网抓取在项目工作区克隆仓库、生成临时目录或保存中间文件。
- 不要在未获用户明确授权时导入 Cookie、安装浏览器扩展、配置代理或安装可选平台后端。
- 不要进行发帖、评论、点赞、关注等写操作。
- 不要把无法访问的平台说成已经验证。
