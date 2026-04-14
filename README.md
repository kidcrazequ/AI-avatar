# Soul

> 本地运行的 AI 分身框架。给每个专家一个灵魂。

[![License](https://img.shields.io/badge/license-ISC-blue.svg)](#license)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#)
[![Release](https://img.shields.io/badge/release-v0.6.1-green.svg)](CHANGELOG.md)

![Soul Desktop](docs/images/desktop-app.png)

## 为什么是 Soul

通用 AI 助手什么都懂一点，却没有一个真正"属于你的专家"。Soul 让你为每一个领域养一个分身——有自己的人格、知识库、技能和记忆，回答必须基于你喂给它的资料，而不是模型的幻觉。

全部数据留在本地。

## 和同类产品的区别

|  | Soul | LM Studio | AnythingLLM | Ollama WebUI |
|---|:---:|:---:|:---:|:---:|
| 本地运行              | ● | ● | ● | ● |
| 多角色人格（soul.md） | ● | ○ | ◐ | ○ |
| 技能树（渐进披露）    | ● | ○ | ○ | ○ |
| 长期记忆（自动纠偏）  | ● | ○ | ◐ | ○ |
| Wiki / 矛盾检测       | ● | ○ | ○ | ○ |
| 质量测试体系          | ● | ○ | ○ | ○ |
| BM25 + 向量双路检索   | ● | ○ | ● | ○ |
| Excel 作结构化数据源  | ● | ○ | ○ | ○ |
| 条件过滤 + 图表生成   | ● | ○ | ○ | ○ |
| 批量 / 压缩包导入     | ● | ○ | ◐ | ○ |

<sub>● 支持　◐ 部分支持　○ 不支持</sub>

Soul 的重心不是"再做一个聊天界面"，而是让 AI 分身**像一个真正的同事**——有稳定人格、有专业知识边界、会记住纠正、回答可溯源。

## 特性

- **人格** — 一份 `soul.md` 定义身份、风格、边界，知识库优先、数据可溯源
- **知识库** — PDF / Word / **PowerPoint / Excel / CSV** 一键导入，OCR + 章节切分，BM25 + 向量双路检索
- **Excel 作结构化数据源** — Excel 不占用 system prompt，AI 通过 `query_excel` 工具按 MongoDB 风格条件精确过滤行
- **批量导入 + 自动优化** — 文件夹 / zip / tar.gz / 7z / rar 一次性导入，导入后自动 LLM 格式化增强（支持断点续跑）
- **图表可视化** — 内置 `draw-chart` 技能，基于知识库数据生成 ECharts 图表，UED 高级审美（渐变面积填充、毛玻璃 tooltip、圆角柱状图）
- **粉色点阵 LED 主题** — void-black 底 + CRT 扫描线纹理 + 粉色 LED glow 光晕
- **自动更新** — 启动时检查 GitHub Releases 新版本，有更新显示横幅提示
- **对话可折叠** — 超长回答一键折叠，节省屏幕空间
- **长期记忆** — 跨会话持久化，自动纠偏
- **Wiki** — 实体自动聚合，跨文件矛盾检测
- **测试体系** — 红线测试 + 知识溯源，可量化迭代
- **Context 智能压缩** — 工具结果 + 历史回答自动压缩，防止多轮对话撑爆上下文

## 快速开始

```bash
cd desktop-app
npm install
npm run dev
```

打包：`npm run dist:mac` / `npm run dist:win`

### 安装包与分身数据

- **安装包不内含任何分身目录**：`electron-builder` 只打包应用本体，并附带只读资源 `templates/`、`shared/`；**不会**把仓库里的 `avatars/`（例如「小堵-工商储专家」等示例）打进 DMG / NSIS。
- **首次安装默认没有分身**：运行时数据在用户目录下的 `userData/avatars/`，初始为空列表，需在应用内「新建分身」。
- **从源码 `npm run dev` 开发时**，才会指向仓库内的 `avatars/`，便于本地调试；与正式安装包行为不同。

### 给已有分身安装默认技能（v0.5.0 新增）

新分身创建时会自动安装 `templates/skills/` 下的默认技能。已有分身可以用以下命令一次性回填：

```bash
cd desktop-app && npm run retrofit:skills
```

幂等安全，重复运行只会把缺失的技能加进去，不会覆盖用户自定义。

### 数据可视化示例

导入一个销售 Excel，然后问分身「用图表展示 2024 年各月销售额」——分身会基于知识库真实数据输出一张 ECharts 图表，直接在聊天中渲染，遵循 UED 设计规范（Y 轴从 0、无 3D、最多 5 系列、色盲友好图案）。

## 文档

- [系统指南](docs/system-guide.md)
- [架构说明](docs/architecture.md)
- [编码规范](CONVENTIONS.md)
- [更新日志](CHANGELOG.md)

## License

ISC

---

<div align="center"><sub>对知识准确性的偏执追求</sub></div>
