export { isNewRuntimeEnabled, isNewIngestEnabled, isStableKnowledgePromptEnabled } from './feature-flags'
export {
  AgentBlueprintSchema,
  IdentityCardSchema,
  SkillRefSchema,
  ToolRefSchema,
  KBScopeSchema,
  PermissionSchema,
  PermissionModeSchema,
  BudgetSchema,
  MemoryPolicySchema,
  isCapabilitySubset,
} from './blueprint'
export type {
  AgentBlueprint,
  IdentityCard,
  SkillRef,
  ToolRef,
  KBScope,
  Permission,
  PermissionMode,
  Budget,
  MemoryPolicy,
} from './blueprint'
export { loadBlueprintFromAvatarDir, type LoadBlueprintOptions } from './blueprint-loader'

// ── Phase 2: Hook 总线 + AuditTrail ──────────────────────────────────────
export { HookPoint, ALL_HOOK_POINTS } from './hooks/points'
export {
  HookRegistry,
  type HookHandler,
  type HookResult,
  type HookPayload,
  type AnyHookPayload,
  type PreToolUsePayload,
  type PostToolUsePayload,
  type PreLLMCallPayload,
  type PostLLMCallPayload,
  type OnSpawnPayload,
  type OnErrorPayload,
  type OnCompactionPayload,
} from './hooks/registry'
export {
  makeReadBeforeEditHook,
  makeCircuitBreakerHook,
  makeSourceAnchorEnforcementHook,
  DEFAULT_TRACEABLE_TOOLS,
  type SourceAnchorWarning,
} from './hooks/built-in'
export { AuditTrail, type AuditEvent, type AuditTrailOptions } from './audit-trail'
export {
  runInstrumentedToolCall,
  type InstrumentedToolCallOptions,
  type InstrumentedToolCallResult,
} from './instrumented-tool-call'

// ── Phase 3: 类型化 subagent + SpawnGuard ────────────────────────────────
export {
  checkSpawn,
  deriveChildBlueprint,
  SUB_AGENT_PROFILES,
  type SubAgentType,
  type SubAgentTypeProfile,
  type GuardResult,
} from './governance/spawn-guard'
export {
  TypedSubAgentManager,
  type TypedSubAgentTask,
  type TypedSubAgentStatus,
  type DelegateTypedOptions,
  type LLMCallFn,
  type TypedSubAgentChangeFn,
} from './typed-sub-agent-manager'

// ── Phase 4: PermissionEnforcer 三态 + Plan Mode ─────────────────────────
export {
  PermissionEnforcer,
  StaticNotificationAdapter,
  type NotificationAdapter,
  type PermissionContext,
  type AskDecision,
  type EnforcerOptions,
} from './governance/permission-enforcer'
export { PlanModeController, type PlanModeOptions } from './governance/plan-mode'

// ── Phase 5: Prompt cache 分段 + PromptRegistry ──────────────────────────
export {
  fingerprint,
  makeSegment,
  toAnthropicSystemBlocks,
  totalLength,
  type PromptSegment,
  type AnthropicSystemBlock,
} from './prompts/registry'
export {
  buildSegmentedSystemPrompt,
  type SegmentedPromptInput,
} from './prompts/segmented-builder'

// ── P0: Behavior modes + task workspace + run trace ─────────────────────
export {
  AGENT_CAPABILITY_PROTOCOL_VERSION,
  buildAgentCapabilityLayout,
  buildAgentCapabilityPromptHint,
  describeAgentCapabilityLayout,
  type AgentCapabilityDirDescriptor,
  type AgentCapabilityDirKind,
  type AgentCapabilityLayout,
} from './capability-directories'
export {
  DEFAULT_BEHAVIOR_MODES,
  buildBehaviorModePromptBlock,
  conversationModeToBehaviorModeIds,
  detectBehaviorModes,
  getBehaviorMode,
  normalizeBehaviorModeId,
  normalizeBehaviorModeIntensity,
  summarizeBehaviorModeActivations,
  type BehaviorModeActivation,
  type BehaviorModeDefinition,
  type BehaviorModeId,
  type BehaviorModeIntensity,
  type ConversationModeLike,
} from './behavior-modes'
export {
  TASK_WORKSPACE_PROTOCOL_VERSION,
  buildTaskWorkspaceLayout,
  buildTaskWorkspacePromptHint,
  ensureTaskWorkspace,
  resolveTaskWorkspacePath,
  type EnsureTaskWorkspaceOptions,
  type TaskWorkspaceDirKind,
  type TaskWorkspaceLayout,
} from './task-workspace'
export {
  RunTraceRecorder,
  type RunTraceEvent,
  type RunTraceEventKind,
  type RunTraceRecorderOptions,
  type RunTraceSummary,
  type TokenUsageLike,
} from './run-trace'
export {
  DEFAULT_GUARDRAIL_POLICIES,
  buildGuardrailPromptBlock,
  detectGuardrails,
  evaluateGuardrailToolCall,
  isReadonlyDeniedTool,
  type DetectGuardrailsInput,
  type GuardrailAction,
  type GuardrailActivation,
  type GuardrailPolicy,
  type GuardrailPolicyId,
  type GuardrailToolCallContext,
  type GuardrailToolDecision,
} from './guardrails'
export {
  AGENT_GATEWAY_PROTOCOL_VERSION,
  buildAgentGatewayRunPlan,
  summarizeAgentGatewayRunPlan,
  type AgentGatewayChannel,
  type AgentGatewayRequest,
  type AgentGatewayRunPlan,
  type AgentGatewayRunStatus,
} from './gateway'
export {
  verifyAgentAnswer,
  type AgentAnswerVerificationIssue,
  type AgentAnswerVerificationResult,
  type AgentAnswerVerificationSeverity,
  type VerifyAgentAnswerInput,
} from './verifier'
export {
  SKILL_DRAFT_PROTOCOL_VERSION,
  buildSkillDraftFromConversation,
  type BuildSkillDraftInput,
  type SkillDraft,
} from './skill-draft'

// ── Phase 6: Memory 3 层 ─────────────────────────────────────────────────
export {
  type MemoryRecord,
  type MemoryQuery,
  type MemoryLayer,
  type MemoryTier,
} from './memory/types'
export { InMemoryLayer, type InMemoryLayerOptions } from './memory/in-memory-layer'
export { makeDefaultMemoryTier } from './memory/tier-factory'

// ── Phase 7: EvalHarness ─────────────────────────────────────────────────
export {
  type EvalKind,
  type EvalCase,
  type EvalCaseResult,
  type EvalSuiteResult,
  type EvaluationStore,
} from './eval/types'
export { runSuite, type RunSuiteOptions } from './eval/harness'
export { JsonlEvaluationStore, type JsonlStoreOptions } from './eval/jsonl-store'

// ── Phase 8: A2A AgentCard ───────────────────────────────────────────────
export {
  toA2AAgentCard,
  type A2AAgentCard,
  type A2ASkillCard,
  type ToA2AOptions,
} from './a2a/agent-card'

// ── Phase 9: 上下文压缩 ──────────────────────────────────────────────────
export {
  compactIfNeeded,
  defaultTokenEstimate,
  type CompactionMessage,
  type CompactOptions,
  type CompactionResult,
} from './compaction/summarizer'

// ── Phase 10: Ingestion pipeline ─────────────────────────────────────────
export {
  type DocFormat,
  type ExtractedTable,
  type ExtractedImage,
  type ExtractedDocument,
  type ExtractorAdapter,
  type OcrResult,
  type VisionCaption,
  type OcrAdapter,
  type VisionLLMAdapter,
  type VisionTrackResult,
  type ConsistencyConflict,
  type ValidationLevel,
  type LearningNotesAdapter,
  type ArtefactLayout,
  type IngestRunResult,
} from './ingest/types'
export {
  checkConsistency,
  renderConflictsMarkdown,
  type ConsistencyCheckOptions,
} from './ingest/consistency-checker'
export { writeArtefacts, type WriteArtefactsOptions } from './ingest/artefact-writer'
export { runVisionTrack, type VisionTrackOptions } from './ingest/vision-track'
export {
  runIngestPipeline,
  type IngestPipelineOptions,
  type IngestStep,
} from './ingest/pipeline'
