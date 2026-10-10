import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
export async function verifyWorkflowPages(window: BrowserWindow, page: string, output: string, profile: string, iteration: number): Promise<unknown[]> {
  const checks: unknown[] = [], markerFile = path.join(profile, 'workflow-install-check.json');
  const wait = async (selector: string) => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(document.querySelector(${JSON.stringify(selector)}))return document.fonts.ready.then(resolve);if(++n>200)return reject(new Error('Workflow renderer did not initialize'));setTimeout(poll,30)};poll()})`);
  let marker: { flowId: string; runId: string; taskId: string; firstRound: string; version: number };
  if (iteration === 1) {
    marker = await window.webContents.executeJavaScript(`(async()=>{const api=window.soulDesktop;await api.installExpert('hr-expert');await api.installExpert('finance-expert');const flowId=await api.workflows.save('',0,{name:'安装工作流验收',description:'真实引擎受控验收',steps:[{expert:'hr-expert',prompt:'步骤一资料缺口'},{expert:'finance-expert',prompt:'步骤二综合草案'}]},'installed-flow-create');const runId=await api.workflows.run(flowId,'安装验收：工作流重启恢复','installed-flow-run');for(let n=0;n<200;n++){const runs=await api.workflows.read(),r=runs.runs.find(item=>item.id===runId);const task=(await api.tasks.read()).tasks.find(item=>item.id===r?.taskId);if(task?.rounds.length===2&&task.rounds[0].state==='done'&&task.rounds[1].state==='started')return {flowId,runId,taskId:task.id,firstRound:task.rounds[0].id,version:1};await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Workflow did not checkpoint')})()`);
    fs.writeFileSync(markerFile, JSON.stringify(marker));
  } else {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    const before = await window.webContents.executeJavaScript(`(async()=>({workflows:await window.soulDesktop.workflows.read(),tasks:await window.soulDesktop.tasks.read()}))()`);
    const run = before.workflows.runs.find((item: any) => item.id === marker.runId), task = before.tasks.tasks.find((item: any) => item.id === marker.taskId);
    const missed = before.workflows.runs.filter((item: any) => item.workflowId === marker.flowId && item.status === 'missed');
    if (run?.status !== 'interrupted' || task?.rounds[0].id !== marker.firstRound || task.rounds[1].state !== 'unknown' || task.rounds.length !== 2 || missed.length !== 1 || missed[0].taskId) throw new Error('Installed workflow recovery or missed execution invariant failed');
    checks.push({ recoveredRun: run.id, taskId: task.id, preservedRound: marker.firstRound, missedRun: missed[0].id, automaticReplay: false });
  }
  await window.loadFile(page, { hash: 'flows' }); await wait('[data-ued-node="workflow.cards"]');
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    window.setContentSize(width, height);
    const geometry = await window.webContents.executeJavaScript(`(()=>{const r=document.querySelector('h1').getBoundingClientRect();const card=document.querySelector('.flow-card').getBoundingClientRect();return {width:innerWidth,height:innerHeight,titleX:r.x,titleY:r.y,cardHeight:card.height,railWidth:document.querySelector('.rail').getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    if (geometry.titleX !== 104 || geometry.titleY !== 32 || geometry.cardHeight !== 140 || geometry.railWidth !== 64 || geometry.overflow) throw new Error(`Workflow list differs from V3: ${JSON.stringify(geometry)}`);
    checks.push({ surface: 'list', ...geometry });
    fs.writeFileSync(path.join(path.dirname(output), `workflows-list-${width}x${height}-${iteration}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await window.loadFile(page, { hash: `workflow/${marker.flowId}` }); await wait('[data-ued-node="workflow.canvas"]');
  for (const surface of ['canvas', 'script', 'runs', 'configuration']) {
    if (surface === 'script') await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[aria-label="工作流显示模式"] button')).find(b=>b.textContent.includes('脚本')).click()`);
    if (surface === 'runs' || surface === 'configuration') await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[aria-label="工作流详情内容"] button')).find(b=>b.textContent===${JSON.stringify(surface === 'runs' ? '执行记录' : '详情配置')}).click()`);
    await wait(surface === 'runs' ? '[data-ued-node="workflow.run-detail"]' : `[data-ued-node="workflow.${surface}"]`);
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      window.setContentSize(width, height);
      await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const geometry = await window.webContents.executeJavaScript(`(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};return {width:innerWidth,height:innerHeight,rail:box('.rail'),topbar:box('.workspace-topbar'),canvas:box('.flow-canvas'),tabs:box('.flow-tabs'),runList:box('.flow-run-list'),steps:document.querySelectorAll('.flow-node').length,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      if (geometry.rail.width !== 64 || geometry.topbar.x !== 64 || geometry.topbar.height !== 49 || geometry.tabs.width !== 225 || geometry.overflow || (surface === 'canvas' && geometry.steps !== 2) || (surface === 'runs' && geometry.runList.width !== 335)) throw new Error(`Workflow detail differs from V3: ${JSON.stringify(geometry)}`);
      checks.push({ surface, ...geometry });
      fs.writeFileSync(path.join(path.dirname(output), `workflows-${surface}-${width}x${height}-${iteration}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.top-actions button')).find(b=>b.textContent.includes('添加触发方式')).click()`); await wait('.automation-dialog');
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    window.setContentSize(width, height);
    const geometry = await window.webContents.executeJavaScript(`(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {width:innerWidth,height:innerHeight,dialog:box('.automation-dialog'),footer:box('.dialog-footer'),scroll:box('.dialog-body')}})()`);
    if (geometry.dialog.width !== 800 || geometry.dialog.height !== height - 64 || geometry.footer.y + geometry.footer.height > height || geometry.scroll.y < 0) throw new Error(`Workflow automation dialog is clipped: ${JSON.stringify(geometry)}`);
    checks.push({ surface: 'automation-dialog', ...geometry });
    fs.writeFileSync(path.join(path.dirname(output), `workflows-automation-${width}x${height}-${iteration}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`document.querySelector('dialog .dialog-close').click()`);
  if (iteration > 1) {
    const resumed = await window.webContents.executeJavaScript(`(async()=>{const api=window.soulDesktop;await api.workflows.resume(${JSON.stringify(marker.runId)},'installed-workflow-resume');for(let n=0;n<200;n++){const r=(await api.workflows.read()).runs.find(item=>item.id===${JSON.stringify(marker.runId)});if(r?.status==='completed')return (await api.tasks.read()).tasks.find(item=>item.id===r.taskId);await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Installed workflow did not resume')})()`);
    if (resumed.rounds.length !== 3 || resumed.rounds[0].id !== marker.firstRound || resumed.messages.filter((item: any) => item.role === 'user').length !== 1 || resumed.messages.filter((item: any) => item.role === 'assistant').length !== 2) throw new Error('Completed workflow repeated earlier steps or polluted user history');
    checks.push({ installedWorkflowResume: { runId: marker.runId, taskId: resumed.id, retainedRound: marker.firstRound, newCalls: 1, finalStatus: resumed.status }, evidence: 'controlled provider; no network calls' });
  } else {
    await window.webContents.executeJavaScript(`(async()=>{const api=window.soulDesktop.workflows,f=(await api.read()).workflows.find(item=>item.id===${JSON.stringify(marker.flowId)});await api.configure(f.id,f.version,{...f.config,prompt:'安装验收：漏执行',enabled:true,triggers:[{id:'installed-offline-timer',type:'timer',schedule:'once',repeat:'daily',at:new Date(Date.now()+1000).toISOString(),time:'09:00',weekday:1,day:1,branch:'main',apiName:'trigger',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,nextAt:null,lastCommit:'',error:''}]},'installed-offline-config')})()`);
  }
  return checks;
}
