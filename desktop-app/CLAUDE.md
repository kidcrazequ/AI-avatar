# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`desktop-app/` is the Electron application that hosts the "AI 分身 / Soul" avatar system. The repo above (`../`) is the avatar/knowledge monorepo (templates, shared knowledge, expert-packs, `packages/core`). This sub-project consumes `@soul/core` via `file:../packages/core`.

## Build / run / test

```bash
npm run dev               # vite + electron in parallel (loads NODE_ENV=development)
npm run dev:fresh         # same, but wipes node_modules/.vite first
npm run build             # esbuild electron/* + vite build
npm run dist:mac          # builds, packages, then rebuilds better-sqlite3 native for mac
npm run dist:win          # same for win
npm run dist:linux        # same for linux

npm run typecheck         # tsc --noEmit (slow, full project)
npm run lint              # eslint src/ electron/ --max-warnings 0
npm run lint:fix
npm run quality           # typecheck + lint, used as the release-cut gate

npm test                  # alias to test:qa-gate
npm run test:qa-gate      # simulation + source-smoke + conversation-smoke
npm run test:simulation   # tsx --test against src/services/*.test.ts (node test runner)
npm run smoke             # static-smoke + electron verifier-main smoke
npm run smoke:verifier    # builds verifier-main and runs it in Electron
```

Single tests use the node test runner via tsx, e.g.:
```bash
NODE_PATH=./test-support/node_modules npx --yes tsx --test src/services/source-anchor-resolver.test.ts
NODE_PATH=./test-support/node_modules npx --yes tsx --test electron/database-attachments.test.ts
```
The `NODE_PATH=./test-support/node_modules` prefix is required — tests pull stubs from there (better-sqlite3 etc.).

Playwright configs exist (`playwright.config.ts`, `playwright-demo.config.ts`, `playwright-journey.config.ts`) but `npm run test:*` / `journey:*` scripts currently all route to `test:qa-gate`; run playwright directly if you need the e2e specs in `tests/`.

## Architecture

Three-layer Electron app:

- **`electron/`** — main process (Node). Bundled by `build-electron.js` (esbuild → `dist-electron/`). Entry `electron/main.ts` (~6.5k lines) holds the singletons (`SoulLoader`, `KnowledgeManager`, `AvatarManager`, `SkillManager`, `ToolRouter`, `DatabaseManager`, `WidgetServer`, `SyncManager`, `CronScheduler`, `PreviewManager`, `VerifierAgent`, …) and every `ipcMain.handle`. `electron/preload.ts` is the ONLY surface exposed to renderer via `contextBridge.exposeInMainWorld('electronAPI', …)`; its type lives in `src/global.d.ts`.
- **`src/`** — React 19 renderer (Vite). State in zustand stores (`src/stores/chatStore.ts` is the big one, ~5k lines). Components are flat under `src/components/`. Renderer must use `@soul/core/browser` (browser-safe entry) — never `@soul/core` directly, which pulls Node-only code.
- **`../packages/core/`** — domain logic shared with CLI/scripts. esbuild resolves `@soul/core` to its TypeScript source via the `soulCoreSrcPlugin` in `build-electron.js`, so changes there are picked up without rebuilding `dist/`.

Build externalizes native / dynamically-required modules (`better-sqlite3`, `jsdom`, `@octokit/rest`, `pptxgenjs`, `pdf-parse`, `nodejieba`) so they load from `node_modules` at runtime; `pdf.worker.mjs` is pre-bundled to `dist-electron/pdf-worker.cjs` to bypass an asar `import()` bug; `unrar.wasm` is copied next to it.

### Data layer

- `electron/database.ts` — `better-sqlite3` (sync API). `CURRENT_SCHEMA_VERSION` is the single source of truth; migrations live in this file plus `db-embeds.ts`, `db-schedules.ts`, `db-sync-history.ts`. Migration tests follow the naming convention `database-<feature>-migration.test.ts`.
- Conversations are double-written: SQLite (queries, search) + JSONL append (`electron/conversation-jsonl-appender.ts`) for v17 event sourcing / sync.
- File attachments live under `userData/attachments/<convId>/<hash>.<ext>`; the table stores only metadata.
- WebDAV cross-device sync goes through `electron/sync/sync-manager.ts`; conflict resolution + DB backup are part of `SyncManager`.

### Renderer ↔ main contract

Every renderer call goes through `window.electronAPI.*` (preload) → `ipcMain.handle('<channel>')` (main). When adding an API:
1. Add the method in `electron/preload.ts`
2. Add the type in `src/global.d.ts` (authoritative — the inline interface in `preload.ts` was removed; do not re-add)
3. Add the `ipcMain.handle('<same channel>')` in `electron/main.ts`

Hot paths to watch: `better-sqlite3` is synchronous, and `nodejieba.cut` on large text can lock the event loop for seconds (see the `oom-diagnose` skill and the global memory notes). Push heavy work off the IPC critical path or into workers.

### Avatar / knowledge runtime

- Avatars resolve from `process.env.SOUL_AVATARS_PATH` → `../avatars` (dev) → `userData/avatars` (prod).
- Templates / shared / expert-packs ship as `extraResources` (read-only) and are copied per-avatar when the user creates one.
- `SkillManager` / `SkillRouter` / `ToolRouter` operate on a three-tier skill set: avatar-local > `shared/skills/` > `shared/skills/community/`. Same name → higher tier wins.
- Knowledge retrieval is a BM25 pre-message path plus agentic tool-call path; see the `soul-rag-architecture-direction` global memory note for the planned direction.

### LLM service

`src/services/llm-service.ts` is a thin facade over two providers in `src/services/llm-providers/`:
- `openai-compat.ts` for DeepSeek / Qwen / OpenAI / Ollama
- `claude.ts` for Anthropic (preserves `reasoning_content` round-trip — required for DeepSeek-Reasoner-style thinking models)
Token / cost tracking is in `cost-tracker.ts`. Eval / regression harness lives in `src/services/eval/`.

## Repo conventions (non-obvious)

- `localDateString()` from `@soul/core` is required for date strings — ESLint blocks `toISOString().slice(0, 10)` because of UTC drift.
- `fetch` global is banned; use `fetchWithTimeout` from `@soul/core`.
- `console.log` is a warn-level lint error in source (use the `logger`); `console.warn` / `console.error` are allowed.
- Path safety helpers (`assertSafeSegment`, `resolveUnderRoot`) from `@soul/core` must guard any user-controlled path joined with `avatarsPath`.
- Commit messages: Conventional Commits, subject ≤ 72 chars, imperative mood, no trailing period. **Never** add `Co-Authored-By: Claude` (project rule + global rule).

## Repo-local hooks and agents

- `.claude/hooks/block-protected.sh` (PreToolUse Edit|Write) blocks direct edits to `package-lock.json`, `release/`, `dist/`, `dist-electron/` — let npm / build manage them.
- `.claude/hooks/lint-on-edit.sh` (PostToolUse Edit|Write) runs ESLint on the single edited `.ts`/`.tsx` file under `src/` or `electron/`. Failure is an advisory (exit 1), not a block.
- `.claude/agents/electron-boundary-reviewer` — call after touching `electron/main.ts`, `electron/preload.ts`, any `ipcMain.handle` handler, or new contextBridge surface.
- `.claude/agents/sqlite-migration-reviewer` — call after touching `electron/database.ts`, `db-*.ts`, or `database-*-migration.test.ts`.
- `.claude/skills/oom-diagnose` — Electron main-process OOM / event-loop-lockup decision tree. Known hard limits: V8 main heap ~4 GB (Chromium hard cap; `--max-old-space-size` is a no-op past that), and `cpu-prof` / heap snapshot don't work once the loop is locked — `console.log + Date.now()` timestamps are the only reliable signal.
- `.claude/skills/release-cut` — version bump → changelog → commit → tag. User-triggered only; never auto-pushes.

## Things that have bitten us

- **Don't edit construct outputs.** `dist-electron/`, `dist/`, `release/`, `package-lock.json` are blocked for a reason.
- **The renderer cannot import `@soul/core` directly.** Use `@soul/core/browser`. Vite's `optimizeDeps.include` is configured for it; Node-only specifiers (`path`, `fs`, `url`, `source-map-js`) are shimmed to a noop in `src/shims/empty-node-module.ts`.
- **`better-sqlite3` after `electron-builder`** needs `npx @electron/rebuild -f -w better-sqlite3` — the `dist:*` scripts already chain it; ad-hoc packaging may not.
- **`nodejieba` under esbuild bundling** hits a strict-mode ReferenceError; we `require('build/Release/.node')` directly with explicit dict paths. Don't "tidy up" that path.
- **macOS Electron 41** has GPU overlay log spam — `app.disableHardwareAcceleration()` in `main.ts` is intentional.
- **Main-process JS heap is bumped to 8 GB** via `app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')`. This must be **before** `app.whenReady()`; `NODE_OPTIONS` / shell `--js-flags` gets eaten by cross-env nesting on mac.
