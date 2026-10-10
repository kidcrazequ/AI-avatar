import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { ModelCall } from './task-models';

export const verificationModel = { id: 'installation-test', label: '受控安装验收模型', model: 'installation-test', baseUrl: 'http://127.0.0.1', protocol: 'openai' as const, configured: true, apiKey: '' };
export const verificationCall = (run: number): ModelCall => async (_config, messages, signal) => {
  const request = messages.find(message => message.role === 'user')?.content ?? '';
  const toolResult = messages.some(message => message.role === 'tool');
  if (request.includes('安装验收：重启恢复')) {
    if (!toolResult) return { text: '', calls: [{ id: 'recovery-read', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"应收账款"}' } }], usage: { inputTokens: 7, outputTokens: 2 } };
    if (run === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('验收进程结束')), { once: true }));
    return { text: '受控验收：从已有知识检索检查点恢复完成。', calls: [], usage: { inputTokens: 6, outputTokens: 3 } };
  }
  if (!toolResult) return { text: '受控验收：申请写入验收成果。', calls: [{ id: 'approval-write', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({ file: '安装验收.md', content: '受控安装验收成果，非真实模型产物。' }) } }], usage: { inputTokens: 4, outputTokens: 2 } };
  return { text: '受控验收：已批准的成果写入完成。', calls: [], usage: { inputTokens: 5, outputTokens: 3 } };
};
export async function verifyTaskPages(window: BrowserWindow, page: string, output: string, profile: string, run: number): Promise<unknown[]> {
  const checks: unknown[] = [];
  const wait = async (selector: string) => window.webContents.executeJavaScript(`new Promise((resolve, reject) => { let n=0; const poll=()=>{ if(document.querySelector(${JSON.stringify(selector)})) return document.fonts.ready.then(resolve); if(++n>250) return reject(new Error('Task page did not initialize')); setTimeout(poll,40); };poll(); })`);
  const markerFile = path.join(profile, 'task-install-check.json');
  let marker: { approvalTask: string; recoveryTask: string; firstRound: string };
  if (run === 1) {
    marker = await window.webContents.executeJavaScript(`(async()=>{
      const api=window.soulDesktop;
      await api.installExpert('finance-expert');
      const send=text=>api.tasks.send({requestId:crypto.randomUUID(),taskId:'',expertId:'finance-expert',groupId:'',model:'Auto',directory:${JSON.stringify(profile)},projectId:'',text,attachments:[]});
      const approvalTask=await send('安装验收：审批持久化');
      const recoveryTask=await send('安装验收：重启恢复');
      for(let n=0;n<200;n++) { const snapshot=await api.tasks.read(); const a=snapshot.tasks.find(t=>t.id===approvalTask),r=snapshot.tasks.find(t=>t.id===recoveryTask);if(a?.status==='waiting'&&r?.rounds.length===2&&r.rounds[1].state==='started') return {approvalTask,recoveryTask,firstRound:r.rounds[0].id}; await new Promise(resolve=>setTimeout(resolve,20)); }
      throw new Error('Installed task fixtures did not checkpoint');
    })()`);
    fs.writeFileSync(markerFile, JSON.stringify(marker));
  } else {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    const before = await window.webContents.executeJavaScript(`window.soulDesktop.tasks.read()`);
    const recovered = before.tasks.find((task: any) => task.id === marker.recoveryTask);
    const approvalTask = before.tasks.find((task: any) => task.id === marker.approvalTask);
    if (recovered?.status !== 'interrupted' || recovered.rounds[0].id !== marker.firstRound || recovered.rounds[1].state !== 'unknown' || approvalTask?.status !== 'waiting' || approvalTask.approvals[0].state !== 'pending' || fs.existsSync(approvalTask.approvals[0].destination)) throw new Error('Installed task or approval lost on restart');
    checks.push({ run, recoveredTask: recovered.id, status: recovered.status, retainedRound: marker.firstRound, pendingApproval: approvalTask.approvals[0].id, noUnapprovedWrite: true });
  }
  for (const route of ['chat/expert/finance-expert', 'board', 'board/approvals', `task/${marker.approvalTask}`, `task/${marker.recoveryTask}`]) {
    await window.loadFile(page, { hash: route }); await wait(route.startsWith('board') ? '[data-ued-node="board.page"]' : '.composer');
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      window.setContentSize(width, height);
      await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const geometry = await window.webContents.executeJavaScript(`(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};return {width:innerWidth,height:innerHeight,rail:box('.rail'),sidebar:box('.conversation-sidebar'),topbar:box('.workspace-topbar'),composer:box('.composer'),heading:box('h1'),tabs:box('.board-tabs'),filters:box('.board-filters'),overflow:document.documentElement.scrollWidth>innerWidth,ipc:typeof window.soulDesktop.tasks.send==='function'};})()`);
      if (geometry.rail.width !== 64 || geometry.overflow || !geometry.ipc) throw new Error(`Task shell differs from V3: ${JSON.stringify(geometry)}`);
      if (route.startsWith('board')) {
        if (geometry.heading.x !== 104 || geometry.heading.y !== 32 || geometry.tabs.y !== 118 || geometry.filters.y !== 182) throw new Error(`Board differs from V3: ${JSON.stringify(geometry)}`);
      } else if (geometry.sidebar.width !== 240 || geometry.sidebar.x !== 64 || geometry.topbar.height !== 49 || geometry.composer.width !== 768 || geometry.composer.height !== 98 || geometry.composer.x !== (width === 1440 ? 488 : 408) || geometry.composer.y !== height - 110) throw new Error(`Chat differs from V3: ${JSON.stringify(geometry)}`);
      checks.push({ route, run, ...geometry });
      fs.writeFileSync(path.join(path.dirname(output), `tasks-${route.replaceAll('/', '-')}-${width}x${height}-${run}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  if (run > 1) {
    const result = await window.webContents.executeJavaScript(`(async()=>{const api=window.soulDesktop.tasks;await api.resume(${JSON.stringify(marker.recoveryTask)},'installed-resume');const before=await api.read(),task=before.tasks.find(t=>t.id===${JSON.stringify(marker.approvalTask)});await api.approve(task.id,task.approvals[0].id,true,'受控安装验收批准','installed-approve');for(let n=0;n<200;n++){const after=await api.read();if([${JSON.stringify(marker.recoveryTask)},${JSON.stringify(marker.approvalTask)}].every(id=>after.tasks.find(t=>t.id===id)?.status==='completed'))return after.tasks.filter(t=>[${JSON.stringify(marker.recoveryTask)},${JSON.stringify(marker.approvalTask)}].includes(t.id)).map(t=>({id:t.id,status:t.status,rounds:t.rounds.length,artifacts:t.artifacts}));await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Installed task resume did not complete');})()`);
    checks.push({ installedResume: result, evidence: 'controlled-provider; no network model calls' });
  }
  return checks;
}
