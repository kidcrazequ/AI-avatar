# Soul

> 本地运行的 AI 分身框架。给每个专家一个灵魂。

[![License](https://img.shields.io/badge/license-ISC-blue.svg)](#license)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#)
[![Release](https://img.shields.io/badge/release-v0.5.2-green.svg)](CHANGELOG.md)

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

- **人格** — 一份 `soul.md` 定义身份、风格、边界
- **知识库** — PDF / Word / **Excel · CSV** 一键导入，OCR + 章节切分，BM25 + 向量双路检索
- **Excel 作结构化数据源** — Excel 不占用 system prompt，AI 通过 `query_excel` 工具按 MongoDB 风格条件（`$gte`/`$lte`/`$in` 等）精确过滤行，支持「215 机型 2026 年 1~3 月设备侧效率折线图」这类复合查询
- **批量导入** — **整个文件夹或 zip / tar.gz / 7z / rar 压缩包一次性导入**，自动过滤噪声、防 zip 炸弹
- **技能树** — 按需加载的工作流，渐进式披露；**内置 `draw-chart` 技能基于知识库数据生成 ECharts 图表**
- **对话可折叠** — 超长回答一键折叠，节省屏幕空间
- **长期记忆** — 跨会话持久化，自动纠偏
- **Wiki** — 实体自动聚合，跨文件矛盾检测
- **测试体系** — 红线测试 + 知识溯源，可量化迭代

## 快速开始

```bash
cd desktop-app
npm install
npm run dev
```

打包：`npm run dist:mac` / `npm run dist:win`

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
