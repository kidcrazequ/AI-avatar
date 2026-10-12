import type { TaskView } from '../shared/contracts';

export type TaskKind = 'chat' | 'auto' | 'im';
export type TaskPeriod = '7' | 'month' | 'quarter' | 'all';
export const taskKind = (task: TaskView, im: Set<string>): TaskKind => im.has(task.id) ? 'im' : task.workflow ? 'auto' : 'chat';
export const belongsToExpert = (task: TaskView, id: string) => task.expertId === id || task.members.some(member => member.expertId === id);
export const needsAction = (task: TaskView) => task.status === 'waiting' || task.status === 'interrupted';
export const needsReview = (task: TaskView) => task.status === 'completed' && task.review?.revision !== task.resultRevision;
export function inPeriod(task: TaskView, period: TaskPeriod, now = new Date()): boolean {
  if (period === 'all') return true;
  const since = new Date(now); since.setHours(0, 0, 0, 0);
  if (period === '7') since.setDate(since.getDate() - 6);
  else since.setMonth(since.getMonth() - (period === 'month' ? 1 : 3));
  return new Date(task.created).getTime() >= since.getTime();
}
export function boardTasks(tasks: TaskView[], filters: { scope: string; executor: string; trigger: string; search: string; period: TaskPeriod }, im: Set<string>, now = new Date()): TaskView[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return tasks.filter(task => (!filters.scope || belongsToExpert(task, filters.scope)) && inPeriod(task, filters.period, now)
    && (filters.executor === 'all' || (filters.executor.startsWith('group:') ? task.groupId === filters.executor.slice(6) : belongsToExpert(task, filters.executor.slice(7))))
    && (filters.trigger === 'all' || taskKind(task, im) === filters.trigger)
    && (!query || [task.title, task.owner, ...task.members.map(member => member.name)].some(text => text.toLocaleLowerCase().includes(query))))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}
