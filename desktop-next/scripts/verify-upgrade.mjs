import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
if (!['darwin','win32'].includes(process.platform)) throw new Error('Native Windows or Mac required');
const { fileURLToPath } = await import('node:url');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(base);
const version = JSON.parse(fs.readFileSync('package.json')).version;
if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) throw new Error('Upgrade fixture requires internal alpha version');
const next = version.replace(/\d+$/, n => String(Number(n)+1));
const folder = path.join(base,'release-upgrade');
const stamp = Date.now();
const evidence = path.join(base,'evidence',`upgrade-${process.platform}-${process.arch}-${stamp}`);
const install = process.platform==='win32'?path.join(process.env.LOCALAPPDATA,`Soul Next Upgrade ${stamp}`):path.join(os.homedir(),'Applications',`Soul Next Upgrade ${stamp}`);
const profile = process.platform==='win32' ? path.join(process.env.LOCALAPPDATA,`Soul Next Upgrade Data ${stamp}`,'测试用户 数据') : path.join(install,'upgrade data');
fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(profile,{recursive:true});
let behavior='normal';
const server = http.createServer((req,res)=>{
  if (behavior==='offline') {res.writeHead(503);res.end();return;}
  const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
  if (path.basename(name)!==name || !fs.existsSync(path.join(folder,name))) {res.writeHead(404);res.end();return;}
  const file=path.join(folder,name);const size=fs.statSync(file).size;res.writeHead(200,{'Content-Length':size,'Content-Type':name.endsWith('.yml')?'text/yaml':'application/octet-stream'});
  const stream=fs.createReadStream(file);if(behavior==='corrupt'&&name.endsWith('.exe')){let first=true;stream.pipe(new Transform({transform(chunk,_encoding,done){if(first){chunk[0]^=1;first=false;}done(null,chunk);}})).pipe(res);}else stream.pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const feed=`http://127.0.0.1:${server.address().port}/`;
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const installMac = dmg => {
 const mount=fs.mkdtempSync(path.join(os.tmpdir(),'soul-upgrade-dmg-'));let attached=false;
 try {run('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg]);attached=true;const destination=path.join(install,'Soul Next.app');if(fs.existsSync(destination))fs.renameSync(destination,destination+'.previous');run('ditto',[path.join(mount,'Soul Next.app'),destination]);}
 finally {if(attached)run('hdiutil',['detach',mount]);fs.rmSync(mount,{recursive:true,force:true});}
};
const executable=process.platform==='win32'?path.join(install,'Soul Next.exe'):path.join(install,'Soul Next.app/Contents/MacOS/Soul Next');
const resources=process.platform==='win32'?path.join(install,'resources'):path.join(install,'Soul Next.app/Contents/Resources');
const launch=async(mode,name)=>{
 const output=path.join(evidence,`${name}.json`),log=fs.openSync(path.join(evidence,`${name}.log`),'w');
 try {await new Promise((resolve,reject)=>{const child=spawn(executable,[`--profile=${profile}`,`--verify-upgrade=${output}`,`--upgrade-mode=${mode}`,`--upgrade-feed=${feed}`],{stdio:['ignore',log,log]});const timer=setTimeout(()=>{child.kill();reject(new Error('Upgrade launch timeout'));},180000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Upgrade mode ${mode} exited ${code}`))});});}
 finally {fs.closeSync(log);}
 const report=JSON.parse(fs.readFileSync(output));if(!report.ok||!report.packaged)throw new Error('Installed upgrade report failed');return report;
};
try {
 const initial=path.join(base,'release',`Soul-Next-${version}-${process.platform==='win32'?'win':'mac'}-${process.arch}.${process.platform==='win32'?'exe':'dmg'}`);
 if(process.platform==='win32')run('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(base,'scripts/upgrade-install-win.ps1'),'-Installer',initial,'-Destination',install]);else installMac(initial);
 const before=await launch('prepare','before');if(before.version!==version)throw new Error('Baseline installed version mismatch');
 console.log(`Installed baseline ${version}; building upgrade fixture ${next}`);
 fs.mkdirSync(folder,{recursive:true});
 await new Promise((resolve,reject)=>{const log=fs.openSync(path.join(evidence,'build-upgrade.log'),'w');const child=spawn(process.execPath,[path.join(base,'node_modules/electron-builder/cli.js'),'--config','electron-builder.upgrade.cjs',process.platform==='win32'?'--win':'--mac','--publish','never'],{env:{...process.env,SOUL_NEXT_TEST_BUILD:'1',SOUL_NEXT_UPDATE_URL:feed,SOUL_NEXT_UPGRADE_VERSION:next},stdio:['ignore',log,log]});child.once('exit',code=>{fs.closeSync(log);code===0?resolve():reject(new Error(`Native upgrade fixture build failed ${code}`))});child.once('error',reject);});
 run(process.execPath,[path.join(base,'scripts/verify-release-files.mjs'),folder,next]);
 behavior='offline';const offline=await launch('offline','offline');behavior='normal';
 let corrupt=null;if(process.platform==='win32'){behavior='corrupt';corrupt=await launch('corrupt','corrupt');behavior='normal';}
 const discovered=await launch(process.platform==='win32'?'install':'check','discovered');if(discovered.discovered.nextVersion!==next)throw new Error('Updater discovered incorrect version');
 if(process.platform==='win32') {
   const deadline=Date.now()+120000;let installed='';
   while(Date.now()<deadline){try{installed=JSON.parse(extractFile(path.join(resources,'app.asar'),'package.json').toString()).version}catch{}if(installed===next)break;await new Promise(resolve=>setTimeout(resolve,500));}
   if(installed!==next)throw new Error('Actual NSIS updater did not replace installed application');
   if(discovered.download.state!=='ready'||!discovered.installed.backup||!fs.existsSync(path.join(discovered.installed.backup,'manifest.json')))throw new Error('Updater skipped checksum staging or backup');
 } else {
   const backup=await launch('backup','manual-backup');if(!backup.backup)throw new Error('Manual upgrade backup missing');
   installMac(path.join(folder,`Soul-Next-${next}-mac-${process.arch}.dmg`));
 }
 const after=await launch('read','after');const restart=await launch('read','restart');if(after.version!==next||restart.version!==next)throw new Error('Updated app version did not persist');
 const artifacts=fs.readdirSync(folder).filter(n=>/\.(exe|dmg|zip)$/.test(n)).map(name=>({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(folder,name))).digest('hex')}));
 const summary={ok:true,platform:process.platform,arch:process.arch,sourceSha:run('git',['rev-parse','HEAD']).trim(),from:version,to:next,before,offline,corrupt,discovered,after,restart,artifacts,automaticInstall:process.platform==='win32',scope:process.platform==='win32'?'Native Windows installed electron-updater → verified download → backup → actual NSIS replacement → two launches; unsigned internal loopback feed':'Native Mac actual updater discovery → backed up manual DMG replacement → two launches; signed automatic installation pending credentials'};
 fs.writeFileSync(path.join(evidence,'upgrade.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({ok:true,evidence,from:version,to:next,automaticInstall:summary.automaticInstall}));
 if(process.platform==='win32')run('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(base,'scripts/upgrade-install-win.ps1'),'-Installer',path.join(install,'Uninstall Soul Next.exe'),'-Uninstall']);
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
