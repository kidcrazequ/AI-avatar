import type { ExpertRecord, TaskView } from '../shared/contracts';

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function expertOverview(expert: Pick<ExpertRecord, 'id' | 'installedAt'>, tasks: TaskView[], imTaskIds: Set<string>, now = new Date()) {
  const records = tasks.filter(task => task.expertId === expert.id || task.members.some(member => member.expertId === expert.id));
  const kinds = { chat: [] as TaskView[], auto: [] as TaskView[], im: [] as TaskView[] };
  for (const task of records) kinds[imTaskIds.has(task.id) ? 'im' : task.workflow ? 'auto' : 'chat'].push(task);
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 364); start.setDate(start.getDate() - start.getDay());
  const counts = new Map<string, number>();
  for (const task of records) { const date = new Date(task.created); if (Number.isFinite(date.getTime()) && date <= now) counts.set(dayKey(date), (counts.get(dayKey(date)) ?? 0) + 1); }
  const end = new Date(now); end.setHours(0, 0, 0, 0);
  const days = Array.from({ length: Math.ceil(((end.getTime() - start.getTime()) / 86400000 + 1) / 7) * 7 }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    return { date: dayKey(date), count: counts.get(dayKey(date)) ?? 0, future: date > now, month: date.getMonth() + 1, day: date.getDate() };
  });
  const joined = expert.installedAt ? new Date(expert.installedAt) : null;
  const joinedDays = joined && Number.isFinite(joined.getTime()) ? Math.max(0, Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(joined.getFullYear(), joined.getMonth(), joined.getDate())) / 86400000)) : null;
  return { records, kinds, days, joinedDays,
    running: records.filter(task => ['pending', 'running'].includes(task.status)).length,
    completed: records.filter(task => task.status === 'completed').length,
    waiting: records.filter(task => ['waiting', 'interrupted'].includes(task.status)).length,
  };
}
