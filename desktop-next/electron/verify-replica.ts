import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrowserWindow } from 'electron';

// Explicit installation gate only: isolated profile, controlled model, no external calls.
export async function verifyReplica(window: BrowserWindow, page: string, output: string, profile: string, iteration: number) {
  const markerPath = path.join(profile, 'qoderwake-install-fixture.json');
  const execute = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const wait = (selector: string) => execute(`new Promise((resolve,reject)=>{let attempts=0;const poll=()=>{if(document.querySelector(${JSON.stringify(selector)}))return document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(++attempts>250)return reject(new Error('Replica route did not initialize'));setTimeout(poll,30)};poll()})`);
  const read = () => execute(`(async()=>({library:await soulDesktop.readLibrary(),settings:await soulDesktop.settings.read(),resources:await soulDesktop.resources.read('finance-expert'),tasks:await soulDesktop.tasks.read(),assistant:await soulDesktop.assistant.read()}))()`);
  let marker: { taskId: string; pendingId: string; chatId: string; feedbackId: string; taskHash: string; artifactHash: string };
  let feedbackImageInputs: { drop: boolean; paste: boolean; limit: boolean; invalidRejected: boolean; oversizedRejected: boolean } | undefined;
  if (iteration === 1) {
    await window.loadFile(page, { hash: 'workspace-assistant' }); await wait('main h1');
    const imageBytes = [...fs.readFileSync(path.join(path.dirname(page), 'assets/assistant/mascot.png'))];
    feedbackImageInputs = await execute(`(async()=>{
      const bytes=new Uint8Array(${JSON.stringify(imageBytes)}),api=soulDesktop.assistant;
      let invalidRejected=false,oversizedRejected=false;
      try{await api.importImage(new Uint8Array([1,2,3]));}catch{invalidRejected=true;}
      try{await api.importImage(new Uint8Array(5*1024*1024+1));}catch{oversizedRejected=true;}
      [...document.querySelectorAll('button')].find(b=>b.textContent==='问题反馈').click();
      const waitFor=async(test)=>{for(let n=0;n<250;n++){if(test())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Feedback image input did not complete');};
      await waitFor(()=>document.querySelector('.assistant-feedback-dialog .dialog-body'));
      const body=document.querySelector('.assistant-feedback-dialog .dialog-body'),count=()=>body.querySelectorAll('.assistant-feedback-images img').length;
      const transfer=()=>{const value=new DataTransfer();value.items.add(new File([bytes],'安装验收截图.png',{type:'image/png'}));return value;};
      body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer()}));await waitFor(()=>count()===1);
      body.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer()}));await waitFor(()=>count()===2);
      const tooMany=transfer();tooMany.items.add(new File([bytes],'第二张.png',{type:'image/png'}));
      body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:tooMany}));await waitFor(()=>body.querySelector('[role="alert"]')?.textContent.includes('最多添加3张'));
      const images=[...body.querySelectorAll('.assistant-feedback-images img')].map(img=>img.src);
      window.replicaFeedbackImages=images;
      [...document.querySelectorAll('.assistant-feedback-dialog button')].find(b=>b.textContent==='取消').click();
      return {drop:true,paste:true,limit:images.length===2,invalidRejected,oversizedRejected};
    })()`);
    if (!feedbackImageInputs || !Object.values(feedbackImageInputs).every(Boolean)) throw new Error('Feedback image limits or decoding were not enforced');
    await execute(`soulDesktop.installExpert('finance-expert')`);
    fs.mkdirSync(path.join(profile, 'pending-output'), { recursive: true });
    const created = await execute(`(async()=>{const api=soulDesktop,s=await api.settings.read();await api.settings.save({...s.preferences,theme:'dark',reply:'English',startup:s.startupActual,deviceName:'安装验收设备'});const resource=await api.resources.read('finance-expert');await api.resources.saveMemory('finance-expert','安装验收：只使用合成资料',resource.memory.revision,'用户偏好');const chatId=crypto.randomUUID(),feedbackId=crypto.randomUUID();await api.assistant.createChat(chatId);await api.assistant.feedback({id:feedbackId,text:'安装验收：本机合成反馈',email:'qa@example.invalid',images:window.replicaFeedbackImages});const send=(text,pending=false)=>api.tasks.send({requestId:crypto.randomUUID(),taskId:'',expertId:'finance-expert',groupId:'',model:'Auto',directory:pending?${JSON.stringify(path.join(profile, 'pending-output'))}:${JSON.stringify(profile)},projectId:'',text,attachments:[]});const taskId=await send('安装验收：批准后才写入合成成果'),pendingId=await send('安装验收：待审批记录重启保留',true);for(let n=0;n<250;n++){const tasks=(await api.tasks.read()).tasks;if([taskId,pendingId].every(id=>tasks.find(t=>t.id===id)?.status==='waiting')){const task=tasks.find(t=>t.id===taskId);await api.tasks.approve(taskId,task.approvals[0].id,true,'合成安装验收','replica-install-approve');break;}if(n===249)throw new Error('Controlled approvals did not initialize');await new Promise(r=>setTimeout(r,20));}for(let n=0;n<250;n++){const task=(await api.tasks.read()).tasks.find(t=>t.id===taskId);if(task?.status==='completed')return {taskId,pendingId,chatId,feedbackId};await new Promise(r=>setTimeout(r,20));}throw new Error('Approved task did not finish');})()`);
    const state = await read(), task = state.tasks.tasks.find((t: any) => t.id === created.taskId);
    const artifact = task.artifacts[0];
    if (!artifact || !fs.existsSync(artifact.path) || fs.readFileSync(artifact.path, 'utf8') !== '受控安装验收成果，非真实模型产物。') throw new Error('Approved artifact missing or incorrect');
    marker = { ...created, taskHash: digest(task), artifactHash: crypto.createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex') };
    fs.writeFileSync(markerPath, JSON.stringify(marker));
  } else marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const state = await read(), task = state.tasks.tasks.find((t: any) => t.id === marker.taskId), pending = state.tasks.tasks.find((t: any) => t.id === marker.pendingId);
  const artifact = task?.artifacts[0];
  if (digest(task) !== marker.taskHash || !artifact || crypto.createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex') !== marker.artifactHash) throw new Error('Restart changed completed task, usage or artifact');
  if (pending?.status !== 'waiting' || pending.approvals[0]?.state !== 'pending' || fs.existsSync(pending.approvals[0].destination)) throw new Error('Pending approval was lost or unapproved output was written');
  if (!state.library.experts.some((e: any) => e.id === 'finance-expert' && e.installed) || state.settings.preferences.deviceName !== '安装验收设备' || state.settings.preferences.reply !== 'English' || !state.resources.memory.content.includes('安装验收：只使用合成资料')) throw new Error('Installed expert, memory or preferences did not persist');
  if (!state.assistant.chats.some((c: any) => c.id === marker.chatId && c.turns.length === 0) || !state.assistant.feedback.some((f: any) => f.id === marker.feedbackId && f.state === 'local' && f.images.length === 2)) throw new Error('Independent assistant or feedback images did not persist');
  const replicaPersistence = { iteration, completedTaskUnchanged: true, artifactUnchanged: true, pendingApprovalRetained: true, unapprovedWritePrevented: true, expertAndMemoryRetained: true, settingsRetained: true, assistantAndFeedbackRetained: true, networkModelCalls: 0 };
  const routes = ['expert-management', 'recruitment-market', 'work-management', 'autonomous-work', 'at-expert', ...['plugins', 'skills', 'connectors', 'knowledge', 'flows', 'projects'].map(p => `resources/${p}`), 'chat/expert/finance-expert', `task/${marker.pendingId}`, ...['', '/settings', '/board', '/autonomous', '/evolution', '/recording', '/memory', '/skills', '/knowledge', '/projects', '/connectors', '/permissions'].map(p => `expert/finance-expert${p}`), ...['preferences', 'system', 'network', 'environments', 'updates'].map(p => `app-settings/${p}`), 'workspace-assistant', 'personal-avatar'];
  const replicaRenderChecks: any[] = [];
  for (const route of routes) {
    await window.loadFile(page, { hash: route }); await wait('main h1');
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      window.setContentSize(width, height);
      await execute(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(innerWidth===${width}&&innerHeight===${height})return requestAnimationFrame(()=>requestAnimationFrame(resolve));if(++n>250)return reject(new Error('Replica viewport mismatch'));setTimeout(poll,20)};poll()})`);
      const g = await execute(`(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};return {width:innerWidth,height:innerHeight,rail:box('.workspace-sidebar'),sidebar:box('.expert-sidebar'),heading:box('main h1'),title:document.querySelector('main h1').textContent,overflow:document.documentElement.scrollWidth>innerWidth,fontLoaded:document.fonts.check('13px "DM Sans"'),ipc:typeof soulDesktop.readLibrary==='function',nodeDisabled:typeof window.require==='undefined',missingImages:[...document.images].filter(i=>!i.complete||i.naturalWidth===0).length,errors:[...document.querySelectorAll('main [role="alert"]')].map(e=>e.textContent),presetCount:document.querySelectorAll('.recruitment-card').length,columns:document.querySelector('.recruitment-grid')?getComputedStyle(document.querySelector('.recruitment-grid')).gridTemplateColumns.split(' ').length:0}})()`);
      if (g.rail?.width !== 240 || g.overflow || !g.fontLoaded || !g.ipc || !g.nodeDisabled || g.missingImages || g.errors.length || g.heading.x < 240) throw new Error(`Replica route failed: ${route} ${JSON.stringify(g)}`);
      if (route === 'recruitment-market' && (g.presetCount !== 12 || g.columns !== (width === 1440 ? 4 : 3))) throw new Error('Creation must retain exactly eleven generic roles and Xiaodu with the reference grid');
      if (route.startsWith('app-settings/') && (g.sidebar?.width !== 240 || g.sidebar.x !== 240 || g.heading.x !== 520 || g.heading.y !== 50)) throw new Error('Settings must retain the reference two-column navigation and 40px page inset');
      if (route === 'app-settings/preferences') {
        g.selectIconsInside = await execute(`Array.from(document.querySelectorAll('.settings-select')).every(control=>{const box=control.querySelector('select').getBoundingClientRect(),icon=control.querySelector('svg').getBoundingClientRect();return icon.x>=box.x&&icon.y>=box.y&&icon.right<=box.right&&icon.bottom<=box.bottom;})`);
        if (!g.selectIconsInside) throw new Error('Preference selectors must keep their arrows within the control');
      }
      replicaRenderChecks.push({ route, ...g });
      fs.writeFileSync(path.join(path.dirname(output), `replica-${route.replaceAll('/', '-')}-${width}-${iteration}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  await window.loadFile(page, { hash: 'expert-management' }); await wait('main h1');
  await execute(`document.querySelector('[aria-label="收起侧栏"]').click()`); await wait('.shell-collapsed');
  const collapsed = await execute(`document.querySelector('.workspace-sidebar').getBoundingClientRect().width`);
  if (collapsed !== 64) throw new Error('Collapsed navigation must remain 64px');
  await execute(`document.querySelector('[aria-label="展开侧栏"]').click()`); await wait('.shell:not(.shell-collapsed)');
  replicaRenderChecks.push({ route: 'navigation-collapse', width: collapsed, restored: true });
  return { verificationSchema: 'qoderwake-cn-2026-10-10', replicaRenderChecks, replicaPersistence, feedbackImageInputs };
}
