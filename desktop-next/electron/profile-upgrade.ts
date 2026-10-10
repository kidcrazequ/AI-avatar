import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const profileSchema = 2;
const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export async function backupProfile(profile: string, reason: string): Promise<string> {
  const folder = path.join(profile, 'backups', `${reason}-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  const database = path.join(profile, 'soul.sqlite');
  if (fs.existsSync(database)) {
    if (fs.lstatSync(database).isSymbolicLink()) throw new Error('数据文件不接受符号链接');
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      if ((db.pragma('quick_check', { simple: true })) !== 'ok') throw new Error('数据库校验失败，未执行升级');
      await db.backup(path.join(folder, 'soul.sqlite'));
    } finally { db.close(); }
    const bytes = fs.readFileSync(path.join(folder, 'soul.sqlite')); entries.push({ path: 'soul.sqlite', sha256: digest(bytes), bytes: bytes.length });
  }
  const copy = (relative: string) => {
    const from = path.join(profile, relative), to = path.join(folder, relative);
    if (!fs.existsSync(from)) return;
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('用户资料含符号链接，未执行升级');
    if (stat.isDirectory()) { fs.mkdirSync(to, { recursive: true, mode: 0o700 }); for (const name of fs.readdirSync(from)) copy(path.join(relative, name)); }
    else if (stat.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(from, to); const bytes = fs.readFileSync(to); entries.push({ path: relative, sha256: digest(bytes), bytes: bytes.length }); }
  };
  // These folders are owned by Soul. External working directories remain in place.
  for (const name of ['avatars', 'knowledge', 'expert-packs', 'role-drafts', 'import-staging', 'task-snapshots']) copy(name);
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), reason, entries }, null, 2), { mode: 0o600 });
  return folder;
}
export async function migrateProfile(profile: string): Promise<{ from: number; to: number; backup: string }> {
  fs.mkdirSync(profile, { recursive: true });
  const file = path.join(profile, 'soul.sqlite');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('数据文件不接受符号链接');
  const db = new Database(file);
  let backup = '';
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('数据损坏，原文件已保留');
    const known = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profile_schema_v3'").get();
    const from = known ? (db.prepare('SELECT version FROM profile_schema_v3 WHERE id=1').get() as { version: number } | undefined)?.version ?? 0 : 1;
    if (!Number.isInteger(from) || from < 1 || from > profileSchema) throw new Error('用户数据来自较新版本或格式异常，请使用匹配的客户端；未修改原数据');
    if (from === profileSchema) return { from, to: from, backup };
    // SQLite backup includes committed WAL pages; a byte copy of the live file does not.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) backup = await backupProfile(profile, 'schema');
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS profile_schema_v3(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS updates_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
      db.prepare('INSERT INTO profile_schema_v3 VALUES (1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version').run(profileSchema);
    })();
    return { from, to: profileSchema, backup };
  } finally { db.close(); }
}
