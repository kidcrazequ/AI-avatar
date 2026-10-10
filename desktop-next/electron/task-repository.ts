import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { TaskRecord, TaskView } from '../shared/contracts';

export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function required(value: unknown, label: string, limit = 1000, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new Error(`${label}无效`);
  return value;
}
export function taskEvent(task: TaskRecord, kind: string, text: string): void {
  task.updated = now(); task.events.push({ at: task.updated, kind, text });
}
export class TaskRepository {
  private db: Database.Database;
  constructor(profile: string) {
    fs.mkdirSync(profile, { recursive: true });
    this.db = new Database(path.join(profile, 'soul.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks_v3(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_commands_v3(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);`);
    this.db.transaction(() => {
      for (const task of this.all()) {
        if (task.status !== 'running') continue;
        task.status = 'interrupted';
        for (const round of task.rounds) if (round.state === 'started') round.state = 'unknown';
        taskEvent(task, 'recovery', '上次执行中断。已保存轮次保留；未完成模型请求的用量未知，继续时会发起新的请求。');
        this.put(task);
      }
    })();
  }
  all(): TaskRecord[] { return (this.db.prepare('SELECT value FROM tasks_v3 ORDER BY rowid DESC').all() as Array<{ value: string }>).map(row => JSON.parse(row.value)); }
  get(id: string): TaskRecord {
    const row = this.db.prepare('SELECT value FROM tasks_v3 WHERE id=?').get(required(id, '任务 ID', 100)) as { value: string } | undefined;
    if (!row) throw new Error('任务不存在');
    return JSON.parse(row.value);
  }
  put(task: TaskRecord): void { this.db.prepare('INSERT INTO tasks_v3 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(task.id, JSON.stringify(task)); }
  command<T>(id: string, payload: unknown, apply: () => T): T {
    required(id, '请求 ID', 100);
    const fingerprint = digest(JSON.stringify(payload));
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint,result FROM task_commands_v3 WHERE id=?').get(id) as { fingerprint: string; result: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('请求 ID 已用于其他操作');
        return JSON.parse(previous.result) as T;
      }
      const result = apply();
      this.db.prepare('INSERT INTO task_commands_v3 VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result ?? null));
      return result;
    })();
  }
  views(): TaskView[] {
    return this.all().map(({ checkpoint: _checkpoint, members, ...task }) => ({
      ...task, members: members.map(({ expertId, name, avatar, model, directory }) => ({ expertId, name, avatar, model, directory })),
      rounds: task.rounds.map(round => round.kind === 'repair' ? { ...round, text: '', reasoning: undefined, calls: [] } : round),
    }));
  }
  close(): void { this.db.close(); }
}
