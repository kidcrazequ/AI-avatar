/**
 * soul-pack public API（v18 Letta .af 借鉴）
 *
 * 让分身可以用单 JSON 文件做可移植打包：跨用户分发 / 备份回滚 / 版本管理。
 */

export {
  SOUL_PACK_SCHEMA_VERSION,
  INLINE_MAX_BYTES,
  INLINE_EXTENSIONS,
  sha256Hex,
  computeManifestSha256,
  serializeSoulPack,
  parseSoulPack,
  guessMimeByExtension,
  toPosixPath,
} from './manifest'
export type {
  SoulPack,
  SoulPackFile,
  SoulPackBinaryRef,
  SoulPackSkillsRef,
  SoulPackMemory,
} from './manifest'

export { exportSoulPack } from './export'
export type { ExportSoulPackOptions } from './export'

export { importSoulPack } from './import'
export type { ImportSoulPackOptions, ImportSoulPackResult } from './import'
