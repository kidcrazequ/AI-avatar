# Soul Agent Runtime Roadmap

> Updated: 2026-06-25
> Scope: P0-P2 roadmap after reading Ponytail and DeerFlow.

## Positioning

Soul should not become a DeerFlow clone. The core advantage is expert-avatar assets:
persona, knowledge, skills, memory, Palace routes, traceable answers, and expert-pack
distribution. The missing layer is a stronger runtime that makes those assets runnable,
observable, connectable, and governable.

Ponytail gives the distribution model for behavior: a compact rule, explicit commands,
portable adapters, and measurable impact. DeerFlow gives the runtime shape: gateway,
threads, sandbox workspace, sub-agents, guardrails, channels, and traces.

## P0: Local Runtime Loop

Goal: keep the desktop product stable while turning the existing runtime skeleton into a
usable local execution contract.

### P0-1 Behavior Mode Packs

Behavior modes are reusable rule assets that can be enabled per request or per session.
They are not new avatars. They sit above skills and below hard safety rules.

Initial modes:

- `strict_traceability`: answer only with sourced facts; expose missing data.
- `minimal_delivery`: shortest useful deliverable; avoid speculative structure.
- `grill_requirements`: challenge weak requirements before generating a plan.
- `code_review`: read-only review stance; findings first, no edits by default.

Acceptance:

- Core can detect modes from text or explicit id.
- Core can inject a compact prompt block for active modes.
- Each mode has trigger words, boundaries, and disabled-by-default persistence.

### P0-2 Runtime Default Chain

Move the feature-flagged `agent-runtime` from passive skeleton to a grey-default path.

Acceptance:

- Blueprint loading, hook registry, permission policy, and prompt segmentation stay
  compatible with the old chat path.
- Runtime can be switched on per environment without changing expert-pack files.
- A rollback switch remains available.

### P0-3 Task Workspace Protocol

Standardize the existing conversation workspace into stable virtual directories:

```text
<conversation-root>/
├── workspace/     # agent scratch and editable task files
├── uploads/       # user-provided input files
├── outputs/       # final deliverables
├── artifacts/     # generated previews, charts, screenshots
└── traces/        # per-run JSONL trace files
```

Acceptance:

- Core exposes a protocol helper that can create and describe the layout.
- Electron's existing `WorkspaceManager` can keep its current root layout while adopting
  these reserved directories gradually.
- Generated prompt hints tell the agent where to put final deliverables.

### P0-4 Run Trace

Record the minimum useful trace for every serious run.

Acceptance:

- Trace events cover run lifecycle, model calls, tool calls, sub-agent state, artifacts,
  source hits, guardrail decisions, and errors.
- Trace summary includes counts, duration, token totals, cost estimate when available,
  artifact paths, and source paths.
- Trace writes are best-effort and never block the chat path.

## P1: Connectable Runtime

Goal: make Soul usable outside the Electron window without losing local-first behavior.

Implementation status as of 2026-06-25:

- Done: shared Gateway run-plan protocol in `@soul/core/agent-runtime`.
- Done: deterministic guardrail policy pack and pre-tool readonly denial for review mode.
- Done: desktop IPC bridge for best-effort per-run traces under `traces/`.
- Done: real chat path records model calls, tool calls, sub-agent tool calls, artifacts,
  source-hit events, guardrail events, and final summaries.
- Pending: HTTP service endpoints and external channel adapters.

### P1-1 Gateway API

Add a local service layer for:

- `POST /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `GET /threads/:id`
- `GET /threads/:id/artifacts`
- `GET /avatars`

Acceptance:

- Electron can continue to use IPC.
- CLI, MCP, and future IM channels can target the same run/thread contract.
- Secrets remain local and are not exposed in traces.

### P1-2 Sub-Agent UI

Expose typed sub-agent tasks as visible cards:

- explore
- plan
- worker
- verifier

Acceptance:

- User can see status, owner task, result, and denial reason.
- Sub-agent context remains isolated.
- Verifier has source-check wording by default.

### P1-3 Guardrails

Move from scattered allow/deny checks to a pre-tool-call policy layer.

Acceptance:

- Tool calls are evaluated before execution.
- Policy supports allow, ask, deny, and fail-closed provider errors.
- Desktop confirmation remains the UI for ask-mode.

### P1-4 Channels

Add IM/channel adapters after the run API exists:

- Enterprise WeChat
- Feishu/Lark
- DingTalk
- Slack/Telegram later

Acceptance:

- Channel messages create or continue Soul threads.
- Channel-level config can select avatar and behavior modes.

## P2: Shared Deployment

Goal: optional server deployment, not required for local desktop.

### P2-1 Multi-User Isolation

Add authenticated users and per-user storage roots.

Acceptance:

- User identity cannot be supplied by client metadata.
- Threads, memory, uploads, and custom avatars are scoped by server-side user context.

### P2-2 Service Deployment

Add Docker production mode only after P1 APIs and guardrails are stable.

Acceptance:

- Explicit resource guidance.
- Local-only default bind.
- Secret and CLI credential mounts are opt-in.

### P2-3 Strong Sandbox

Add Docker/Kubernetes sandbox modes for shared deployments.

Acceptance:

- Local mode remains available for single-user desktop.
- Shared mode does not mount broad host credentials by default.

## Not Doing Now

- Replacing Electron with a web app.
- Rewriting all chat state around a new graph runtime in one pass.
- Adding Kubernetes/provisioner before local run traces and guardrails are stable.
- Treating behavior modes as new avatars.

## First Implementation Slice

This slice lands the P0 protocol in core:

- behavior mode definitions and prompt blocks
- task workspace reserved layout
- JSONL run trace recorder
- focused unit tests

Follow-up slices can wire these helpers into the chat loop and desktop UI.
