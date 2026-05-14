/**
 * Feature flags for the agent-runtime evolution.
 *
 * Defaults to OFF — every new Phase ships behind a flag so the legacy path
 * keeps working. Plan §9 mandates ≥2 weeks of parallel run before flipping
 * a default in production.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function readFlag(name: string): boolean {
  const raw = (typeof process !== 'undefined' && process.env?.[name]) || ''
  return TRUE_VALUES.has(raw.toLowerCase())
}

/** Master flag for the new agent runtime (Phase 1-9 except Phase 10). */
export function isNewRuntimeEnabled(): boolean {
  return readFlag('SOUL_USE_NEW_RUNTIME')
}

/** Flag for the new document ingestion pipeline (Phase 10). */
export function isNewIngestEnabled(): boolean {
  return readFlag('SOUL_USE_NEW_INGEST')
}
