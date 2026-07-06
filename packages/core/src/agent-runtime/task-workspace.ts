/**
 * P0 task workspace protocol.
 *
 * Electron already owns the physical conversation workspace. This module gives
 * the runtime a stable virtual layout inside that root so tools, traces, and
 * future Gateway/IM adapters can speak the same path language.
 */

import fs from 'fs'
import path from 'path'
import { resolveUnderRoot } from '../utils/path-security'

export const TASK_WORKSPACE_PROTOCOL_VERSION = '2026-06-p0'

export type TaskWorkspaceDirKind = 'workspace' | 'uploads' | 'outputs' | 'artifacts' | 'traces'

export interface TaskWorkspaceLayout {
  protocolVersion: string
  root: string
  dirs: Record<TaskWorkspaceDirKind, string>
  virtualDirs: Record<TaskWorkspaceDirKind, string>
}

export interface EnsureTaskWorkspaceOptions {
  createReadme?: boolean
}

const DIR_NAMES: Record<TaskWorkspaceDirKind, string> = {
  workspace: 'workspace',
  uploads: 'uploads',
  outputs: 'outputs',
  artifacts: 'artifacts',
  traces: 'traces',
}

export function buildTaskWorkspaceLayout(root: string): TaskWorkspaceLayout {
  const absRoot = path.resolve(root)
  return {
    protocolVersion: TASK_WORKSPACE_PROTOCOL_VERSION,
    root: absRoot,
    dirs: {
      workspace: path.join(absRoot, DIR_NAMES.workspace),
      uploads: path.join(absRoot, DIR_NAMES.uploads),
      outputs: path.join(absRoot, DIR_NAMES.outputs),
      artifacts: path.join(absRoot, DIR_NAMES.artifacts),
      traces: path.join(absRoot, DIR_NAMES.traces),
    },
    virtualDirs: {
      workspace: '/mnt/user-data/workspace',
      uploads: '/mnt/user-data/uploads',
      outputs: '/mnt/user-data/outputs',
      artifacts: '/mnt/user-data/artifacts',
      traces: '/mnt/user-data/traces',
    },
  }
}

export function ensureTaskWorkspace(root: string, opts: EnsureTaskWorkspaceOptions = {}): TaskWorkspaceLayout {
  const layout = buildTaskWorkspaceLayout(root)
  fs.mkdirSync(layout.root, { recursive: true })
  for (const dir of Object.values(layout.dirs)) fs.mkdirSync(dir, { recursive: true })

  if (opts.createReadme) {
    const readme = path.join(layout.root, 'WORKSPACE.md')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, buildTaskWorkspaceReadme(layout), 'utf-8')
    }
  }
  return layout
}

export function resolveTaskWorkspacePath(
  layout: TaskWorkspaceLayout,
  kind: TaskWorkspaceDirKind,
  relativePath = '.',
): string {
  return resolveUnderRoot(layout.dirs[kind], relativePath || '.')
}

export function buildTaskWorkspacePromptHint(layout: TaskWorkspaceLayout): string {
  return [
    '## Task Workspace',
    `Protocol: ${layout.protocolVersion}`,
    `Scratch files: ${layout.virtualDirs.workspace}`,
    `User uploads: ${layout.virtualDirs.uploads}`,
    `Final deliverables: ${layout.virtualDirs.outputs}`,
    `Generated previews/artifacts: ${layout.virtualDirs.artifacts}`,
    `Run traces: ${layout.virtualDirs.traces}`,
    'Put user-facing final files under outputs/. Put temporary working files under workspace/.',
  ].join('\n')
}

function buildTaskWorkspaceReadme(layout: TaskWorkspaceLayout): string {
  return [
    '# Soul Task Workspace',
    '',
    `Protocol: ${layout.protocolVersion}`,
    '',
    '| Directory | Purpose |',
    '|---|---|',
    '| workspace/ | Agent scratch files and editable task files |',
    '| uploads/ | User-provided input files |',
    '| outputs/ | Final deliverables for the user |',
    '| artifacts/ | Generated previews, charts, screenshots, and intermediate assets |',
    '| traces/ | Per-run JSONL traces |',
    '',
  ].join('\n')
}
