# 设计大师 私有知识库

> **作者**：zhi.qu
> **日期**：2026-04-28

## 这个目录是做什么的

`avatars/design-master/knowledge/` 存放**只属于"设计大师"分身**的私有知识，与全仓库共享的 `shared/design-systems/` 分工如下：

| 维度 | `shared/design-systems/` | `avatars/design-master/knowledge/` |
| --- | --- | --- |
| 性质 | 共享语料（73 套品牌 design.md） | 私有知识 |
| 谁能读 | 所有分身（小堵、未来的产品经理等都能调） | 只有 design-master |
| 内容 | 公开品牌的设计参考（来自 getdesign / awesome-claude-design） | 用户/客户专属、不便公开的设计资产 |
| 工具 | `list_design_systems` / `read_design_system` / `search_design_systems` | `list_knowledge_files` / `read_knowledge_file` / `search_knowledge` |

## 什么内容应该放这里

- **客户专属品牌指南**：合同里约定的品牌色、字体授权、Logo 规范
- **内部设计系统文档**：你自己组织/产品的 design token 定义
- **项目背景资料**：某个项目的目标用户研究、竞品截图分析
- **历史设计决策**：过往项目里"为什么这样设计"的复盘文档

## 什么内容**不应该**放这里

- 公开品牌的设计参考 → 放到 `shared/design-systems/design-md/<category>/<brand>.md`，让所有分身复用
- 用户的临时偏好（如"我喜欢圆角 8px"）→ 写到 `memory/MEMORY.md`，不是 knowledge
- 通用设计原理（如"WCAG 对比度要求"）→ 已经在 `templates/skills/claude-design-system.md` 里，不重复

## 知识文件清单

（暂无知识文件）

加新文件时请按以下规范：

1. 文件命名：`<序号>_<主题>_<日期YYMMDD>.md`，例如 `01_acme-公司品牌指南_260428.md`
2. 文件头：JSDoc 风格，含 `@author` 与 `@date`
3. 加完文件后回到本 README 的"知识文件清单"补一行索引（包含文件名、主题、来源）
4. 涉及客户机密的文件，文件头加一行 `> 机密等级：内部` 或 `> 机密等级：客户专享`

## 与 `shared/design-systems/` 的协作约定

- 当用户首次提到某个 *公开* 品牌但 `shared/design-systems/` 没有时：
  1. 先确认该品牌可公开引用（非客户专属）
  2. 用户提供官方资料后，加到 `shared/design-systems/design-md/<category>/<brand>.md`
  3. 同步更新 `shared/design-systems/INDEX.md` 索引
- 当用户提到某个 *客户专属* 品牌时：
  1. 加到本目录（`knowledge/`），不要放到 shared
  2. 在文件头明确标注客户名与机密等级
