import type { WorkflowTrigger } from './contracts';

export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
function cronField(value: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('Cron 支持数字、*、范围、列表和步长');
    const step = Number(match[2] ?? 1);
    const [from, to] = match[1] === '*' ? [min, max] : match[1].includes('-') ? match[1].split('-').map(Number) : [Number(match[1]), match[2] ? max : Number(match[1])];
    if (from < min || to > max || from > to || step < 1 || step > max + 1) throw new Error('Cron 字段超出范围');
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return [...values].sort((a, b) => a - b);
}
export function nextCron(expression: string, after: number): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || expression.length > 200) throw new Error('Cron 需要五项：分 时 日 月 周');
  const [minutes, hours, days, months, weekdays] = fields.map((field, n) => cronField(field, [0, 0, 1, 1, 0][n], [59, 23, 31, 12, 7][n]));
  const date = new Date(after); date.setHours(0, 0, 0, 0);
  for (let n = 0; n < 366 * 8; n++, date.setDate(date.getDate() + 1)) {
    const day = days.includes(date.getDate()), week = weekdays.includes(date.getDay()) || date.getDay() === 0 && weekdays.includes(7);
    const matches = fields[2].startsWith('*') || fields[4].startsWith('*') ? day && week : day || week;
    if (!months.includes(date.getMonth() + 1) || !matches) continue;
    for (const hour of hours) for (const minute of minutes) {
      const candidate = new Date(date); candidate.setHours(hour, minute, 0, 0);
      if (candidate.getHours() === hour && candidate.getMinutes() === minute && candidate.getTime() > after) return candidate.getTime();
    }
  }
  throw new Error('Cron 在未来八年内没有有效日期');
}
export function nextScheduled(trigger: WorkflowTrigger, after: number): number | null {
  if (trigger.schedule === 'once') { const at = Date.parse(trigger.at); return at > after ? at : null; }
  if (trigger.timezone !== localTimezone()) throw new Error('本机时区已改变，请重新保存触发配置');
  if (trigger.repeat === 'cron') return nextCron(trigger.cron ?? '', after);
  const [hour, minute] = trigger.time.split(':').map(Number);
  const date = new Date(after); date.setHours(trigger.repeat === 'hourly' ? date.getHours() : hour, minute, 0, 0);
  for (let n = 0; n < 400; n++) {
    if (date.getTime() > after && (trigger.repeat !== 'weekly' || date.getDay() === trigger.weekday) && (trigger.repeat !== 'monthly' || date.getDate() === trigger.day)) return date.getTime();
    if (trigger.repeat === 'hourly') date.setHours(date.getHours() + 1, minute, 0, 0);
    else { date.setDate(date.getDate() + 1); date.setHours(hour, minute, 0, 0); }
  }
  throw new Error('无法计算下一次时间');
}
