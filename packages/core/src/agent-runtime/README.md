# agent-runtime

借鉴 Claude Code / Agent SDK 与 power-agent-platform (PAP) 的治理层。

## 设计原则

1. **不破坏现有路径**：现有 `tool-router` / `prompt-builder` / `sub-agent-manager` / `memory-manager` / `conversation-router` 等模块保持工作，新代码通过 feature flag 与之并行。
2. **声明式 + 不可变**：核心数据结构（Blueprint、Permission、Budget）一律 frozen，便于序列化、审计、对外暴露。
3. **Hook 优先**：跨切面行为（审计、熔断、修改前 read、3 轮失败停下）走 Hook 总线，不在业务模块里写硬编码 if/else。

## Feature Flags

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `SOUL_USE_NEW_RUNTIME` | 启用 agent-runtime（Blueprint/Hook/SpawnGuard/Permission/Prompt cache/Compaction） | `false` |
| `SOUL_USE_NEW_INGEST` | 启用文档 ingestion 6 步 pipeline（Phase 10） | `false` |

工具函数：`isNewRuntimeEnabled()` / `isNewIngestEnabled()` 在 `feature-flags.ts`。

## 目录结构（按 Phase 增长）

```
agent-runtime/
├── README.md                        ← 本文件
├── feature-flags.ts                 ← Phase 0
├── blueprint.ts                     ← Phase 1（AgentBlueprint Zod schema）
├── hooks/                           ← Phase 2（Hook 总线）
│   ├── registry.ts
│   └── points.ts
├── audit-trail.ts                   ← Phase 2
├── governance/                      ← Phase 3 / Phase 4
│   ├── spawn-guard.ts
│   └── permission-enforcer.ts
├── prompts/                         ← Phase 5
│   └── registry.ts
├── memory/                          ← Phase 6
│   ├── short-term.ts
│   ├── episodic.ts
│   └── semantic.ts
├── eval/                            ← Phase 7
│   ├── unit.ts
│   ├── integration.ts
│   ├── regression.ts
│   └── benchmark.ts
├── a2a/                             ← Phase 8
│   └── agent-card.ts
├── compaction/                      ← Phase 9
│   └── summarizer.ts
└── ingest/                          ← Phase 10
    ├── pipeline.ts
    ├── extractors/
    ├── vision-track.ts
    ├── consistency-checker.ts
    └── learning-notes.ts
```

## 与旧路径的并存契约

- 旧模块禁止 `import 'agent-runtime/...'`（避免循环依赖与单向迁移破坏）
- 新模块允许复用旧工具函数（如 `conversation-jsonl-appender`）
- 切换默认值需要并行运行 ≥2 周（计划第 9 节"风险与熔断"）

详见 `.cursor/plans/agent-runtime-evolution.plan.md`。
