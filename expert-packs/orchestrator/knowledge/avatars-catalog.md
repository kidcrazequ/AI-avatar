# 已安装分身能力清单

> **维护说明**：本清单是调枢派发任务的唯一依据。新装/卸载分身后必须同步更新此文件。
> **校验来源**：`avatars/` 目录下的子目录名即为 `target_avatar` 参数值；`expert-packs/` 提供分发源。
> **更新日期**：2026-05-15

## 当前安装状态速查

| target_avatar | 中文名 | expert-pack 源 | 安装状态 |
|---------------|--------|---------------|---------|
| `小堵-工商储专家` | 小堵—工商储专家 | `expert-packs/小堵-工商储专家/` | ✅ 已安装 |
| `design-master` | 设计大师 | `expert-packs/design-master/` | ⚠️ 未安装（仅 expert-pack） |
| `electrical-engineer-expert` | 电图—电气工程师 | `expert-packs/electrical-engineer-expert/` | ⚠️ 未安装 |
| `finance-expert` | 财研—财务分析专家 | `expert-packs/finance-expert/` | ⚠️ 未安装 |
| `hr-expert` | 人研—HR 专家 | `expert-packs/hr-expert/` | ⚠️ 未安装 |
| `legal-expert` | 法研—法务专家 | `expert-packs/legal-expert/` | ⚠️ 未安装 |
| `market-analyst-expert` | 市研—市场分析师 | `expert-packs/market-analyst-expert/` | ⚠️ 未安装 |
| `product-manager-expert` | 品研—产品经理 | `expert-packs/product-manager-expert/` | ⚠️ 未安装 |
| `project-manager-expert` | 项枢—项目经理 | `expert-packs/project-manager-expert/` | ⚠️ 未安装 |

> ⚠️ 派发前请用 `avatars/` 目录实际状态校验。未安装的分身 `task(target_avatar=...)` 会返回 `target_avatar 不存在` 错误，参考 CLAUDE.md「铁律 3：失败兜底」处理。

---

## 1. 小堵—工商储专家（`小堵-工商储专家`）

**擅长**：工商业储能产品方案设计、收益测算、政策解读、电芯/PCS/EMS 参数解释、案例查询。

**典型问题**：
- "200kWh 工商储项目用什么电芯合适"
- "山东工商储补贴政策最新进展"
- "X 项目和 Y 项目的设备差异"

**红线（不要派给小堵的事）**：
- 友商比价 / 报具体价格区间（小堵自己也拒答）
- 跨区域政策的笼统对比（小堵会拒答非知识库覆盖区域）
- 非工商储领域（家储 / 电网级 / 户储），改派别人或拒答

**模型建议**：DeepSeek-V4-Pro（小堵知识库大、prompt cache 命中率 99.8%）。

---

## 2. 设计大师（`design-master`）

**擅长**：设计系统应用、品牌视觉、信息架构、交互设计、参考 70+ 品牌设计语料（Apple / Stripe / Linear 等）。

**典型问题**：
- "复刻 Linear 风格的 hero section"
- "做一份 SaaS 产品的设计系统起点"
- "这个交互稿哪里不对"

**红线**：
- 不替业务做"设计是否合理"的最终决策（产品归 @品研）
- 不直接生成代码（HTML 片段可以，但工程化由开发承担）

**模型建议**：Sonnet 4.6（视觉+判断综合负载）。

---

## 3. 电图—电气工程师（`electrical-engineer-expert`）

**擅长**：电气图纸阅读 / OCR、国标 IEC 标准查询、单线图 / 一次系统 / 接线图判读。

**典型问题**：
- "这张图纸的额定参数是多少"
- "GB/T XXXX 标准里对绝缘电阻的要求"
- "这个接线方式哪里不规范"

**红线**：
- 不做现场施工建议（人身安全相关须人工核验）
- 高压设备操作建议须明确"仅参考，操作前必须线下确认"

**模型建议**：Opus 4.7（推理重，图纸判读 + 标准比对）。

---

## 4. 财研—财务分析专家（`finance-expert`）

**擅长**：报表阅读、经营分析、预算测算、IRR / NPV / 回本期模型、风险提示。

**典型问题**：
- "这份利润表健康度怎么样"
- "200kWh 项目的 IRR 模型"
- "Q3 预算执行偏差分析"

**红线**：
- **不替代审计 / 税务申报 / CPA 出具的正式意见**
- 不编会计准则条款；不确定时明确"建议核对最新会计准则"

**模型建议**：Sonnet 4.6（财务计算 + 准则引用）。

---

## 5. 人研—HR 专家（`hr-expert`）

**擅长**：制度起草、劳资沟通、招聘面试设计、绩效与薪酬建议。

**典型问题**：
- "起草一份远程办公制度"
- "员工纠纷的沟通话术"
- "JD 怎么写更精准"

**红线**：
- **反歧视**：不基于性别 / 年龄 / 民族给筛选建议
- **候选人脱敏**：处理简历时去身份证 / 电话等敏感字段
- 不替代劳动法律意见（重大劳资纠纷转 @法研）

**模型建议**：Sonnet 4.6。

---

## 6. 法研—法务专家（`legal-expert`）

**擅长**：合同条款审阅、合规风险提示、参阅级法律意见草案。

**典型问题**：
- "这份合同有哪些风险点"
- "公司业务在 X 法规下的合规要求"
- "起草一份保密协议参考稿"

**红线**：
- **只出"参阅级草案"，不构成执业律师意见**
- 不编法规条文；查不到条款时明确"需补充 X 法规全文"
- 不替代诉讼策略 / 仲裁意见

**模型建议**：Sonnet 4.6 或 Opus 4.7(高 stakes 法律判断时切 Opus)。

---

## 7. 市研—市场分析师（`market-analyst-expert`）

**擅长**：竞品研究、市场数据梳理、行业研究备忘。

**典型问题**：
- "X 赛道近三年市场规模变化"
- "竞品 Y 的产品和定价"
- "Z 行业头部玩家盘点"

**红线**：
- 外部链接必须标日期（数据时效）
- 不编未来预测数据；预测必须基于已有数据源
- 不替代证券投顾建议

**模型建议**：Sonnet 4.6（联网搜索 + 综合）。

---

## 8. 品研—产品经理（`product-manager-expert`）

**擅长**：PRD 撰写、指标体系搭建、产品决策框架、需求拆解。

**典型问题**：
- "帮我搭一份新功能 PRD"
- "这个功能的成功指标怎么定"
- "需求优先级怎么排"

**红线**：
- **决策类输出必须标"AI 草案"**，不替代真实产品经理拍板
- 不编竞品 / 用户调研数据
- 跨领域决策需要时主动建议派给 @财研 / @设计大师 等

**模型建议**：Sonnet 4.6。

---

## 9. 项枢—项目经理（`project-manager-expert`）

**擅长**：甘特图、风险登记表、Mermaid 流程图、进度跟踪、里程碑设计。

**典型问题**：
- "出一份 12 周项目排期甘特"
- "项目风险登记表"
- "依赖关系画一下"

**红线**：
- **不占位承诺工期**：所有工期估算必须基于"已知前置条件"，不确定的标记"待定"
- 不替代真实 PM 与团队对齐

**模型建议**：DeepSeek-V4-Pro（结构化输出，Mermaid / 表格友好）。

---

## 派发选型决策树

```
专业事实问题
├─ 数字 / 政策 / 参数 / 案例 → 派对应领域分身
├─ 财务 / IRR / 报表 → @finance-expert
├─ 法律 / 合同 / 合规 → @legal-expert
├─ 图纸 / 电气 / 标准 → @electrical-engineer-expert
├─ 工商储产品技术 → @小堵-工商储专家
├─ 市场 / 竞品 / 行业 → @market-analyst-expert
├─ 设计 / 品牌 / 交互 → @design-master
├─ PRD / 指标 / 产品决策 → @product-manager-expert
├─ HR / 制度 / 招聘 → @hr-expert
└─ 排期 / 风险 / 进度 → @project-manager-expert

跨领域复合问题
├─ 储能项目可研 → @小堵 → @finance-expert → @legal-expert（串行）
├─ 新产品方案 → @product-manager-expert → @design-master → @project-manager-expert
├─ 投资风险评估 → @market-analyst-expert + @finance-expert（结论给 @product-manager-expert 合成）
└─ 合规改造 → @legal-expert → @hr-expert / @finance-expert（视场景）

非派发场景
├─ 寒暄 / 元问题 → 自己答
├─ "你能干啥" → 自己答（基于本清单）
└─ 代码实现 / 工程操作 → 拒答，引导用户去 Cursor / Claude Code
```
