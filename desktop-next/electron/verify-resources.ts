import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

// Runs only in the explicit installed-app verification mode with isolated userData.
export async function verifyResourcePages(window: BrowserWindow, page: string, output: string, run: number): Promise<unknown[]> {
  const checks: unknown[] = [];
  const wait = async (selector: string) => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0; const poll = () => {
      if (document.querySelector(${JSON.stringify(selector)})) return document.fonts.ready.then(resolve);
      if (++attempts > 250) return reject(new Error('Resource page did not initialize: ' + location.hash + ' selector ' + ${JSON.stringify(selector)} + ' dialogs ' + [...document.querySelectorAll('dialog')].map(item=>item.getAttribute('aria-label')).join(';') + ' alerts ' + [...document.querySelectorAll('[role="alert"],.toast')].map(item=>item.textContent).join(';')));
      setTimeout(poll, 40);
    }; poll();
  })`);
  for (const route of ['projects', 'knowledge', 'expert/finance-expert/projects', 'expert/finance-expert/knowledge', 'expert/finance-expert/memory', 'expert/finance-expert/skills', 'expert/finance-expert/settings', 'expert/finance-expert/settings/quality']) {
    await window.loadFile(page, { hash: route });
    await wait('[data-resource-ready="true"]');
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      window.setContentSize(width, height);
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const geometry = await window.webContents.executeJavaScript(`(() => {
        const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; };
        return { width: innerWidth, height: innerHeight, title: document.querySelector('h1').textContent, heading: box('h1'),
          headingSize: getComputedStyle(document.querySelector('h1')).fontSize, rail: box('.rail'), sidebar: box('.expert-sidebar'),
          page: box('.resource-page') ?? box('.management'), skill: box('.skill-grid .resource-card'), settings: box('.settings-section'),
          overflow: document.documentElement.scrollWidth > innerWidth, fontLoaded: document.fonts.check('13px "DM Sans"'),
          errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent),
          professionalPending: document.body.innerText.includes('未执行'), ipc: typeof window.soulDesktop.resources.read === 'function' };
      })()`);
      const expert = route.startsWith('expert/');
      const expectedX = expert ? width === 1440 ? 392 : 344 : 104;
      if (geometry.heading.x !== expectedX || geometry.heading.y !== (expert ? 50 : 32) || geometry.headingSize !== (route.includes('/settings') ? '30px' : '28px') || geometry.rail.width !== 64 || (expert && (geometry.sidebar?.width !== 240 || geometry.page.width !== (width === 1440 ? 960 : 896))) || geometry.overflow || !geometry.fontLoaded || geometry.errors.length || !geometry.ipc) throw new Error(`Installed resource layout failed: ${route} ${JSON.stringify(geometry)}`);
      if (route.endsWith('/skills') && (!geometry.skill || geometry.skill.x !== expectedX || geometry.skill.y !== 321 || geometry.skill.width !== (width === 1440 ? 228 : 212) || geometry.skill.height !== 154)) throw new Error(`Installed skill grid differs from V3: ${JSON.stringify(geometry)}`);
      if (route.endsWith('/quality') && !geometry.professionalPending) throw new Error('Professional tests must remain explicitly unexecuted');
      checks.push({ route, ...geometry });
      fs.writeFileSync(path.join(path.dirname(output), `resources-${route.replaceAll('/', '-')}-${width}x${height}-${run}.png`), (await window.webContents.capturePage()).toPNG());
    }
    if (route === 'projects' || route.endsWith('/memory')) {
      const dialogTitle = route === 'projects' ? '新建项目' : '版本管理';
      await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(route === 'projects' ? '.resource-header .btn.primary' : '.memory-summary .btn')}).click()`);
      await wait('dialog[open]');
      const dialog = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('dialog').getBoundingClientRect(); return { title: document.querySelector('dialog').getAttribute('aria-label'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()`);
      if (dialog.title !== dialogTitle || dialog.width !== (route === 'projects' ? 640 : 980) || dialog.height !== (route === 'projects' ? 537 : 720)) throw new Error(`Installed resource dialog differs from V3: ${JSON.stringify(dialog)}`);
      checks.push({ route, dialog });
      fs.writeFileSync(path.join(path.dirname(output), `resources-dialog-${route.replaceAll('/', '-')}-${run}.png`), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript("document.querySelector('dialog .dialog-close').click()");
    }
  }
  const persistence = await window.webContents.executeJavaScript(`(async () => {
    const api = window.soulDesktop;
    const id = 'finance-expert';
    const marker = '安装版资源验收：独立记忆重启保留';
    const before = await api.resources.read(id);
    if (${run} > 1 && !before.memory.content.includes(marker)) throw new Error('Installed resource memory lost on restart');
    await api.installExpert(id);
    await api.resources.saveMemory(id, marker, before.memory.revision, '用户偏好');
    const after = await api.resources.read(id);
    if (!after.memory.content.includes(marker) || after.versions.length < 2) throw new Error('Installed resource IPC did not persist the file and history');
    return { run: ${run}, memorySaved: true, restoredAfterRestart: ${run} > 1, versions: after.versions.length, revision: after.memory.revision, source: after.memory.source };
  })()`);
  checks.push({ persistence });
  const lookup = await window.webContents.executeJavaScript(`(async () => {
    const api = window.soulDesktop.resources, title = '安装版统一查找验收';
    let collection = (await api.read('')).collections.find(item => item.title === title);
    if (!collection) { await api.saveCollection('', title); collection = (await api.read('')).collections.find(item => item.title === title); }
    let document = (await api.documents(collection.id, '')).find(item => item.name === '范围证据.md');
    if (!document) { await api.saveDocument({collectionId: collection.id, id:'',name:'范围证据.md',revision:'',content:'# 安装版范围阅读\\n' + Array.from({length:1500},(_,i) => '原始正文第 '+(i+1)+' 行。').join('\\n') + '\\n尾部标记 INSTALLEDLOOKUP62709'}, ''); document = (await api.documents(collection.id, '')).find(item => item.name === '范围证据.md'); }
    const state = await api.read('finance-expert'); await api.bind('finance-expert', [...new Set([...state.bindings, collection.id])]);
    const resource = await api.lookup.execute('finance-expert', collection.id, {operation:'search',query:'INSTALLEDLOOKUP62709'});
    if (resource.chunks.length !== 1 || resource.chunks[0].lineStart < 1000) throw new Error('Installed lookup did not find the tail');
    return {collectionId:collection.id, documentId:document.id, bodySha256:resource.chunks[0].bodySha256, version:resource.chunks[0].version};
  })()`);
  await window.loadFile(page, { hash: 'expert/finance-expert/knowledge/' + encodeURIComponent(lookup.collectionId) });
  // loadFile with only a hash change can keep the same renderer document. The
  // fixture installed the expert via IPC, so refresh its application snapshot.
  await new Promise<void>(resolve => { window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload(); });
  await wait('.resource-filter input');
  await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('.resource-filter input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'INSTALLEDLOOKUP62709'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await window.webContents.executeJavaScript(`new Promise((resolve,reject) => { let n=0; const poll=()=> { const rows=[...document.querySelectorAll('.resource-table tbody tr')]; if(rows.length===1 && rows[0].innerText.includes('INSTALLEDLOOKUP62709')) return resolve(); if(++n>250) return reject(new Error('Installed resource search did not render')); setTimeout(poll,40); }; poll(); })`);
  await window.webContents.executeJavaScript(`document.querySelector('.resource-table tbody .doc-actions button').click()`);
  await wait('dialog[open] .resource-preview');
  const preview = await window.webContents.executeJavaScript(`({tail:document.querySelector('.resource-preview').textContent.includes('INSTALLEDLOOKUP62709'), hash:document.querySelector('dialog').textContent.includes(${JSON.stringify(lookup.bodySha256)}), overflow:document.documentElement.scrollWidth>innerWidth})`);
  if (!preview.tail || !preview.hash || preview.overflow) throw new Error('Installed range preview lost source evidence');
  checks.push({ installedLookup: { ...lookup, run, ...preview } });
  fs.writeFileSync(path.join(path.dirname(output), 'lookup-preview-' + run + '.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('dialog .dialog-close').click()");
  await window.webContents.executeJavaScript("(() => {const input=document.querySelector('.resource-filter input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const click = async (label: string) => window.webContents.executeJavaScript(`(() => { const root = document.querySelector('dialog[open]') ?? document; const button = [...root.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Installed knowledge action unavailable: ' + ${JSON.stringify(label)}); button.click(); })()`);
  await click('导入资料'); await wait('[data-ued-node="knowledge.import"]');
  await click('选择并导入');
  await window.webContents.executeJavaScript(`new Promise((resolve,reject) => { let n=0; const poll=() => { if(!document.querySelector('dialog[open]') && document.body.innerText.includes('安装版来源.csv')) return resolve(); if(++n>500) return reject(new Error('Installed import did not publish')); setTimeout(poll,40); }; poll(); })`);
  const imported = await window.webContents.executeJavaScript(`(async()=> { const api=window.soulDesktop.resources; const document=(await api.documents(${JSON.stringify(lookup.collectionId)},'finance-expert')).find(item=>item.name==='安装版来源.csv'); const versions=await api.knowledge.versions(${JSON.stringify(lookup.collectionId)},document.id.slice(8,-3),'finance-expert'); if(${run}>1 && versions.length<2) throw new Error('Imported history lost across installed launches'); return {document,versions}; })()`);
  await click('导入记录'); await wait('[data-ued-node="knowledge.batches"]');
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(document.querySelector('dialog')?.innerText.includes('已完成'))return resolve();if(++n>250)return reject(new Error('Batch status not rendered'));setTimeout(poll,40)};poll()})`);
  fs.writeFileSync(path.join(path.dirname(output), 'knowledge-batches-' + run + '.png'), (await window.webContents.capturePage()).toPNG()); await click('关闭');
  const more = () => window.webContents.executeJavaScript("(() => {const row=[...document.querySelectorAll('.resource-table tbody tr')].find(item=>item.innerText.includes('安装版来源.csv'));const button=[...row.querySelectorAll('button')].find(item=>item.textContent==='更多');button.click();})()");
  await more(); await wait('[data-ued-node="knowledge.document-actions"]'); await click('来源与版本'); await wait('.knowledge-hashes');
  const diagnostic = await window.webContents.executeJavaScript(`({hash:document.querySelector('dialog').innerText.includes(${JSON.stringify(imported.versions[0].originalSha256)}), original:document.querySelector('dialog').innerText.includes('打开原件'), tables:document.querySelector('dialog').innerText.includes('物理单元格'), overflow:document.documentElement.scrollWidth>innerWidth})`);
  if (!diagnostic.hash || !diagnostic.original || !diagnostic.tables || diagnostic.overflow) throw new Error('Installed source diagnostics incomplete');
  if (run > 1) {
    await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('#knowledge-version'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${JSON.stringify(imported.versions.at(-1).version)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait('dialog .dialog-footer .primary'); await click('恢复此版本');
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=async()=>{const docs=await window.soulDesktop.resources.documents(${JSON.stringify(lookup.collectionId)},'finance-expert');if(docs.find(d=>d.id===${JSON.stringify(imported.document.id)}).sourceVersion===${JSON.stringify(imported.versions.at(-1).version)})return resolve();if(++n>250)return reject(new Error('Installed source restore failed'));setTimeout(poll,40)};poll()})`);
  }
  fs.writeFileSync(path.join(path.dirname(output), 'knowledge-source-' + run + '.png'), (await window.webContents.capturePage()).toPNG()); await click('关闭');
  await more(); await wait('[data-ued-node="knowledge.document-actions"]'); await click('AI 整理'); await wait('[data-ued-node="knowledge.learning"]');
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{const button=[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='预览来源与用量');if(button&&!button.disabled)return resolve();if(++n>250)return reject(new Error('Learning model not ready'));setTimeout(poll,40)};poll()})`);
  await click('预览来源与用量'); await wait('.knowledge-learning-preview'); await click('确认用量并开始');
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(document.querySelector('.knowledge-learning-record')?.innerText.includes('引用已验证'))return resolve();if(++n>500)return reject(new Error('Installed independent learning did not complete'));setTimeout(poll,40)};poll()})`);
  const learning = await window.webContents.executeJavaScript(`({source:document.querySelector('.knowledge-learning-record').innerText.includes('版本'), quote:Boolean(document.querySelector('.knowledge-learning-record blockquote')), usage:document.querySelector('.knowledge-learning-record').innerText.includes('tokens'), overflow:document.documentElement.scrollWidth>innerWidth})`);
  if (!learning.source || !learning.quote || !learning.usage || learning.overflow) throw new Error('Installed learning lost source or usage');
  fs.writeFileSync(path.join(path.dirname(output), 'knowledge-learning-' + run + '.png'), (await window.webContents.capturePage()).toPNG()); await click('关闭');
  checks.push({ installedKnowledgeUI: { run, selection: 'generated CSV substituted for OS picker in isolated verification mode; real importer and renderer', diagnostic, learning, versions: imported.versions.map((item: any) => item.version), restoredHistory: run > 1 } });
  return checks;
}
