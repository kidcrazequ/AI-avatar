import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=process.platform==='win32'?path.join(root,'release/win-unpacked/Soul Next.exe'):path.join(root,`release/mac${process.arch==='arm64'?'-arm64':''}/Soul Next.app/Contents/MacOS/Soul Next`);
const target=fs.existsSync(executable)?executable:path.join(root,'node_modules/electron/dist',process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron.exe');
const entry=path.join(root,'dist-electron/integration-test.cjs');
await build({entryPoints:[path.join(root,'tests/integrations.ts')],bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire as soulCreateRequire } from 'node:module'; const require = soulCreateRequire(import.meta.url); const __dirname = import.meta.dirname;"},outfile:entry.replace('.cjs','.mjs'),external:['better-sqlite3','@larksuiteoapi/node-sdk','@modelcontextprotocol/sdk/*','zod','./retriever.cjs','./model.cjs']});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soul-integrations-'));
const crashProfile=fs.mkdtempSync(path.join(os.tmpdir(),'soul-im-crash-'));
const output=path.join(root,'evidence',`integrations-${process.platform}-${process.arch}-runtime.json`);fs.mkdirSync(path.dirname(output),{recursive:true});
try {for(const mode of ['suite','crash-prepare','crash-resume','crash-check']){const report=mode==='suite'?output:output.replace('-runtime.json','-recovery.json');const result=spawnSync(target,[entry.replace('.cjs','.mjs'),path.join(root,'build/resources'),report,mode==='suite'?profile:crashProfile,mode],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:60000});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.error||result.status!==0)throw result.error??new Error(`Integration verification ${mode} exited ${result.status}`);}}finally{for(const directory of [profile,crashProfile])fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
