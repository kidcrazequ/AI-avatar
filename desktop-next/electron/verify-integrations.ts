import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
export async function verifyIntegrationPages(window: BrowserWindow, page: string, output: string, iteration: number): Promise<unknown[]> {
  const checks: unknown[]=[];
  const wait=async(selector:string)=>window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(document.querySelector(${JSON.stringify(selector)}))return document.fonts.ready.then(resolve);if(++n>200)return reject(new Error('Integration renderer timeout'));setTimeout(poll,20)};poll()})`);
  const resize=async(width:number,height:number)=>{window.setContentSize(width,height);await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(innerWidth===${width}&&innerHeight===${height})return requestAnimationFrame(()=>requestAnimationFrame(resolve));if(++n>250)return reject(new Error('Integration resize timeout'));setTimeout(poll,20)};poll()})`);};
  const surfaces=[['expert/finance-expert/connectors','[data-integration-ready="true"]','connectors'],['expert/finance-expert/permissions','[data-integration-ready="true"]','permissions'],['im','[data-integration-ready="true"]','im'],...['preferences','system','network','environments','updates'].map(p=>[`app-settings/${p}`,'[data-settings-ready="true"]',p])];
  for(const [hash,selector,surface] of surfaces){
    await window.loadFile(page,{hash});await wait(selector);
    for(const [width,height] of [[1440,900],[1280,800]]){
      await resize(width,height);
      const g=await window.webContents.executeJavaScript(`(()=>{const box=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};return {width:innerWidth,height:innerHeight,title:box('h1'),rail:box('.rail'),sidebar:box('.expert-sidebar'),card:box('.connector-card'),master:box('.guard-master'),tabs:box('.resource-tabs'),banner:box('.im-banner'),font:getComputedStyle(document.querySelector('h1')).fontSize,overflow:document.documentElement.scrollWidth>innerWidth,missingImages:[...document.images].filter(i=>!i.complete||i.naturalWidth===0).map(i=>i.src)}})()`);
      if(g.rail.width!==64||g.overflow||g.missingImages.length||g.font!=='28px')throw new Error(`Integration frame mismatch: ${surface} ${JSON.stringify(g)}`);
      if(surface==='im'){if(g.title.x!==104||g.title.y!==32||g.banner.height!==148)throw new Error('IM differs from V3');}
      else if(g.sidebar.width!==240||g.title.x!==(width===1440?392:344)||g.title.y!==50)throw new Error(`Settings/resource layout differs from V3: ${JSON.stringify(g)}`);
      if(surface==='connectors'&&(g.card.y!==236||g.card.height!==82||g.card.width!==(width===1440?472:440)))throw new Error(`Connector card differs from V3: ${JSON.stringify(g)}`);
      if(surface==='permissions'&&(g.tabs.width!==586||g.tabs.height!==36||g.master.height!==140))throw new Error('Permissions differ from V3');
      checks.push({surface,...g});fs.writeFileSync(path.join(path.dirname(output),`integrations-${surface}-${width}x${height}-${iteration}.png`),(await window.webContents.capturePage()).toPNG());
    }
  }
  await window.loadFile(page,{hash:'im'});await wait('[data-integration-ready="true"]');
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='开通 @Soul').click()`);await wait('.im-pair-dialog');
  const dialog=await window.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.im-pair-dialog').getBoundingClientRect();return {width:r.width,height:r.height,y:r.y,bottom:r.bottom}})()`);
  if(dialog.width!==800||dialog.height!==565||dialog.y<0||dialog.bottom>800)throw new Error(`IM pairing dialog differs from V3: ${JSON.stringify(dialog)}`);checks.push({surface:'pairing-dialog',...dialog});
  await window.webContents.executeJavaScript(`document.querySelector('.im-pair-dialog .dialog-close').click()`);
  const persisted=await window.webContents.executeJavaScript(`(async()=>{const api=window.soulDesktop;const s=await api.settings.read();const p=await api.integrations.read('finance-expert');if(${iteration}===1){await api.settings.save({...s.preferences,reply:'English'});await api.integrations.savePermissions('finance-expert',{...p.permissions,policies:{...p.permissions.policies,read_project_file:'deny'}});return {prepared:true};}return {reply:s.preferences.reply,policy:p.permissions.policies.read_project_file,other:(await api.integrations.read('hr-expert')).permissions.policies.read_project_file};})()`);
  if(iteration>1&&(persisted.reply!=='English'||persisted.policy!=='deny'||persisted.other!=='allow'))throw new Error('Settings/permissions did not persist or isolation failed');checks.push({installedRestartPersistence:persisted});
  await window.loadFile(page,{hash:'app-settings/updates'});await wait('[data-update-ready="true"]');
  const update=await window.webContents.executeJavaScript(`(async()=>{const d=await window.soulDesktop.updates.read();const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='检查更新');if(${iteration}===1)await window.soulDesktop.updates.automatic(false);return {state:d.state,configured:d.configured,automatic:d.automatic,checkDisabled:b?.disabled,title:document.querySelector('h1')?.textContent}})()`);
  if(update.state!=='unconfigured'||update.configured||!update.checkDisabled||update.title!=='更新应用'||(iteration>1&&update.automatic!==false))throw new Error('Unconfigured updater or preferences rendered inaccurately');checks.push({installedUpdateState:update});
  return checks;
}
