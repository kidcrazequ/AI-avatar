import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ExpertLibrary } from '../electron/expert-library';
import { ResourceStore } from '../electron/resources';
import { TaskRepository } from '../electron/task-repository';
import { TaskRuntime } from '../electron/task-runtime';
import { Permissions } from '../electron/permissions';
import { ConnectorRuntime } from '../electron/connector-runtime';
import { IMRuntime } from '../electron/im-runtime';
import { AppSettings } from '../electron/app-settings';
import type { IncomingIM, IMReplyAddress } from '../electron/feishu-adapter';
import type { IMFactory } from '../electron/feishu-adapter';
import type { ModelCall } from '../electron/task-models';
const [resourcesRoot, output, profile, mode = 'suite'] = process.argv.slice(2);
const checks: string[] = [], check = (name: string, apply: () => void) => { apply(); checks.push(name); };
const codec = { encrypt: (value: string) => Buffer.from('controlled-encrypted:' + value), decrypt: (value: Buffer) => value.toString().slice(21) };
const library = new ExpertLibrary(resourcesRoot, profile); library.installExpert('finance-expert'); library.installExpert('hr-expert');
const resources = new ResourceStore(resourcesRoot, profile, library), repository = new TaskRepository(profile), permissions = new Permissions(profile, id => library.detail(id));
const connectors = new ConnectorRuntime(profile, codec, id => library.detail(id), () => {});
const model = { id:'test-model',label:'受控验收模型',model:'test',baseUrl:'http://127.0.0.1',protocol:'openai' as const,configured:true,apiKey:'' };
let startup = false, wake = false, calls = 0, effects = 0;
const settings = new AppSettings(profile, { list:() => [model] }, { version:'test',experts:[],resources:{ files:900,bytes:0,sha256:'' },checks:[],platform:process.platform,arch:process.arch,sourceSha:'',persistenceRun:1 }, { setStartup:v => { startup=v; },startup:() => startup,wake:v => { wake=v;return v; },encryption:() => true,open:async () => {} });
const call: ModelCall = async (_config,messages) => {
  calls++;
  if (mode === 'crash-prepare') return new Promise(() => {});
  const text = messages.filter(m => m.role === 'user').map(m => m.content).join('');
  if (text.includes('connector') && !messages.some(m => m.role === 'tool')) return { text:'',calls:[{ id:'external-call',type:'function',function:{ name:'call_connector_tool',arguments:JSON.stringify({ connectorId:'test-connector',name:'read_note',arguments:{ query:'Soul' } }) } }] };
  if (text.includes('permission') && !messages.some(m => m.role === 'tool')) return { text:'',calls:[{ id:'read-call',type:'function',function:{ name:'read_project_file',arguments:JSON.stringify({ file:'private.txt' }) } }] };
  return { text:'受控验收回复，未使用真实模型。',calls:[],usage:{ inputTokens:1,outputTokens:1 } };
};
const tasks = new TaskRuntime(repository,library,resources,{ resolve:() => model,list:() => [model] },profile,() => {},call,{ permissions,connectors,preferences:() => settings.preferences() });
const wait = async (condition: () => boolean) => { const deadline=Date.now()+15000; while(!condition()) { if(Date.now()>deadline) throw new Error('验收等待超时'); await new Promise(r => setTimeout(r,10)); } };
const serverSessions = new Map<string,{ transport:StreamableHTTPServerTransport; server:McpServer }>();
const httpServer = http.createServer(async (req,res) => {
  try {
    let body='';for await(const part of req)body+=part;
    const data=body ? JSON.parse(body) : undefined;
    const sid=req.headers['mcp-session-id'] as string|undefined;
    let entry=sid ? serverSessions.get(sid) : undefined;
    if(!entry) {
      const server=new McpServer({ name:'受控协议服务',version:'1' });
      server.registerTool('read_note',{ description:'读取测试便签',inputSchema:{ query:z.string() },annotations:{ readOnlyHint:true } },async ({query}) => { effects++;return { content:[{ type:'text',text:'source:test-note.txt; '+query }] }; });
      server.registerTool('write_note',{ description:'写测试便签',inputSchema:{},annotations:{ readOnlyHint:false } },async () => { effects++;return { content:[{type:'text',text:'written'}] }; });
      const transport=new StreamableHTTPServerTransport({ sessionIdGenerator:()=>crypto.randomUUID(),onsessioninitialized:id => serverSessions.set(id,{transport,server}) });
      entry={transport,server};await server.connect(transport);
    }
    await entry.transport.handleRequest(req,res,data);
  } catch {res.writeHead(500);res.end();}
});
await new Promise<void>(r => httpServer.listen(0,'127.0.0.1',r));
const address=httpServer.address() as {port:number};
let receive: ((message:IncomingIM)=>void)|undefined, sent=0, failSend=false;
const deliveredRoutes:Array<IMReplyAddress|undefined>=[];
const factory:IMFactory = () => { let state='idle';return { start:async handler=> {receive=handler;state='connected';},state:()=>state,send:async(_message,_text,_id,reply)=> {sent++;deliveredRoutes.push(reply);if(mode==='crash-resume'){fs.writeFileSync(path.join(profile,'send-attempts.json'),JSON.stringify({attempts:sent}));process.exit(0);}if(failSend)throw new Error('controlled lost receipt');return 'controlled-receipt';},close:()=> {state='idle';} }; };
let im = new IMRuntime(profile,codec,library,tasks,()=>{},factory);
try {
  if (mode === 'crash-prepare') {
    await im.saveChannel({id:'crash-channel',name:'跨进程受控验收',appId:'cli_test',secret:'controlled-test-secret',enabled:true});
    receive!({chatId:'crash-chat',senderId:'person',messageId:'crash-message',type:'direct',text:'跨进程验收'});
    const eventId=im.events()[0].id;im.pair(eventId,{id:'crash-session',name:'跨进程配对',channelId:'crash-channel',chatId:'crash-chat',senderId:'person',type:'direct',expertId:'finance-expert',groupId:'',directory:'',model:'Auto',enabled:true});
    await wait(()=>calls===1);const task=repository.get(im.events()[0].taskId);
    fs.writeFileSync(output,JSON.stringify({eventId,taskId:task.id,roundId:task.rounds[0].id}));process.exit(0);
  }
  if (mode === 'crash-resume' || mode === 'crash-check') {
    const saved=JSON.parse(fs.readFileSync(output,'utf8'));await im.start();assert.equal(calls,0);
    if(mode==='crash-resume') {
      assert.equal(repository.get(saved.taskId).status,'interrupted');assert.equal(repository.get(saved.taskId).rounds[0].id,saved.roundId);assert.equal(repository.get(saved.taskId).rounds[0].state,'unknown');
      tasks.resume(saved.taskId,'im-crash-resume');await wait(()=>repository.get(saved.taskId).status==='completed');im.synchronize();assert.equal(im.events()[0].state,'ready');assert.equal(calls,1);
      await im.sendReply(saved.eventId);throw new Error('Crash adapter must terminate before returning a receipt');
    }
    assert.equal(im.sessions().length,1);assert.equal(im.events()[0].taskId,saved.taskId);assert.equal(im.events()[0].state,'unknown');await assert.rejects(im.sendReply(saved.eventId));assert.equal(sent,0);assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'send-attempts.json'),'utf8')).attempts,1);
    const report={...saved,ok:true,platform:process.platform,arch:process.arch,checks:['im-task-recovers-after-process-exit-with-one-explicit-model-call','im-unknown-send-recovers-after-process-exit-without-retry'],newCallsOnRestart:calls,newSendsOnRestart:sent};fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } else {
  fs.writeFileSync(path.join(profile,'private.txt'),'secret fixture');
  const p=permissions.read('finance-expert');
  check('expert-permission-default-and-isolation',()=> { permissions.save('finance-expert',{...p,paths:[path.join(profile,'private.txt')]});assert.equal(permissions.read('hr-expert').paths.length,0); });
  check('deny-sensitive-read-before-file-access',()=>assert.equal(permissions.decision({expertId:'finance-expert',directory:profile} as any,{id:'p',type:'function',function:{name:'read_project_file',arguments:'{"file":"private.txt"}'}}),'deny'));
  check('deny-sensitive-artifact-at-actual-task-output-path',()=> {const target=path.join(profile,'Soul-Outputs','task-path');fs.mkdirSync(target,{recursive:true});permissions.save('finance-expert',{...p,paths:[target]});assert.equal(permissions.decision({expertId:'finance-expert',directory:profile} as any,{id:'p',type:'function',function:{name:'write_artifact',arguments:'{"file":"output.md","content":"draft"}'}},'task-path'),'deny');});
  check('mandatory-external-approval-even-allow-policy',()=> { permissions.save('finance-expert',{...p,policies:{...p.policies,call_connector_tool:'allow'}});assert.equal(permissions.decision({expertId:'finance-expert'} as any,{id:'p',type:'function',function:{name:'call_connector_tool',arguments:'{}'}}),'ask'); });
  check('model-allowlist-blocks-unapproved-service',()=> { permissions.save('finance-expert',{...p,model:true,models:[]});assert.throws(()=>tasks.send({requestId:'denied-model',taskId:'',expertId:'finance-expert',groupId:'',directory:'',projectId:'',model:'Auto',attachments:[],text:'hello'}),/模型安全/);permissions.save('finance-expert',p); });
  await connectors.save({id:'test-connector',expertId:'finance-expert',catalog:'mcp',name:'受控协议连接',transport:'http',url:`http://127.0.0.1:${address.port}/mcp`,command:'',args:[],mode:'read',secret:''});
  check('configured-is-not-connected',()=>assert.equal(connectors.read('finance-expert')[0].state,'idle'));
  await connectors.connect('test-connector');
  check('actual-mcp-handshake-and-tool-discovery',()=> {assert.equal(connectors.read('finance-expert')[0].state,'connected');assert.equal(connectors.tools('finance-expert').length,2);assert.equal(connectors.tools('hr-expert').length,0);});
  check('readonly-mode-denies-write-tools',()=>assert.throws(()=>connectors.binding('finance-expert','test-connector','write_note'),/仅允许/));
  const taskId=tasks.send({requestId:'connector-task',taskId:'',expertId:'finance-expert',groupId:'',directory:'',projectId:'',model:'Auto',attachments:[],text:'connector'});
  await wait(()=>repository.get(taskId).status==='waiting');
  check('external-tool-waits-for-review-with-no-side-effect',()=> {assert.equal(effects,0);assert.equal(repository.get(taskId).approvals[0].kind,'tool');});
  tasks.approve(taskId,repository.get(taskId).approvals[0].id,true,'','approve-external');
  await wait(()=>repository.get(taskId).status==='completed');
  check('approved-mcp-call-records-result-and-once-only',()=> {assert.equal(effects,1);assert.equal(repository.get(taskId).approvals[0].execution,'done');assert.equal(repository.get(taskId).messages.filter(m=>m.role==='user').length,1);});
  await new Promise<void>(resolve => setImmediate(resolve));
  await connectors.remove('test-connector');
  const recovered=repository.get(taskId);recovered.status='interrupted';recovered.rounds=recovered.rounds.slice(0,1);recovered.messages=recovered.messages.filter(m=>m.role==='user');recovered.checkpoint.member=0;recovered.checkpoint.calls=recovered.rounds[0].calls;recovered.checkpoint.callIndex=0;recovered.checkpoint.wire=recovered.checkpoint.wire.filter(m=>m.role!=='tool');repository.put(recovered);
  tasks.resume(taskId,'resume-durable-result');await wait(()=>repository.get(taskId).status==='completed');
  check('durable-mcp-result-reused-after-connector-removed',()=>assert.equal(effects,1));
  await im.saveChannel({id:'channel',name:'受控飞书协议适配器',appId:'cli_test',secret:'controlled-test-secret',enabled:true});
  receive!({chatId:'chat',senderId:'person',messageId:'message',type:'direct',text:'hello'});
  receive!({chatId:'chat',senderId:'person',messageId:'message',type:'direct',text:'hello'});
  check('im-unknown-sender-pairing-and-message-dedup',()=> {assert.equal(im.events().length,1);assert.equal(im.events()[0].state,'pairing');assert.equal(im.events()[0].taskId,'');});
  const eventId=im.events()[0].id;
  im.pair(eventId,{id:'session',name:'受控配对会话',channelId:'channel',chatId:'chat',senderId:'person',type:'direct',expertId:'finance-expert',groupId:'',directory:'',model:'Auto',enabled:true});
  await wait(()=>repository.get(im.events()[0].taskId).status==='completed');im.synchronize();
  check('im-real-task-link-and-explicit-reply-approval',()=> {assert.equal(im.events()[0].state,'ready');assert.equal(sent,0);assert.ok(im.events()[0].response);});
  im.close();im=new IMRuntime(profile,codec,library,tasks,()=>{},factory);await im.start();
  check('im-pairing-and-unsent-draft-survive-runtime-restart',()=> {assert.equal(im.sessions().length,1);assert.equal(im.events()[0].state,'ready');assert.equal(sent,0);});
  await im.sendReply(eventId);await assert.rejects(im.sendReply(eventId));
  check('im-send-success-receipt-and-no-repeat',()=> {assert.equal(sent,1);assert.equal(im.events()[0].receipt,'controlled-receipt');});
  receive!({chatId:'chat',senderId:'person',messageId:'unknown-message',type:'direct',text:'receipt recovery'});
  await wait(()=>repository.get(im.events()[0].taskId).status==='completed');im.synchronize();const unknownId=im.events()[0].id;failSend=true;await im.sendReply(unknownId);
  check('im-history-includes-authorized-sender-context-as-untrusted-drafts',()=>{const text=repository.get(im.events()[0].taskId).messages[0].text;assert.ok(text.includes('hello'));assert.ok(text.includes('历史摘录'));assert.ok(text.includes('草案不作为原始事实或授权'));});
  im.close();im=new IMRuntime(profile,codec,library,tasks,()=>{},factory);await im.start();await assert.rejects(im.sendReply(unknownId));
  check('unknown-im-send-survives-restart-without-retry',()=> {assert.equal(im.events()[0].state,'unknown');assert.equal(sent,2);});
  receive!({chatId:'chat',senderId:'other',messageId:'other-message',type:'direct',text:'unpaired'});
  check('paired-chat-does-not-authorize-other-senders',()=>assert.equal(im.events()[0].state,'pairing'));
  const participant={expertId:'finance-expert',model:'test-model',directory:''};
  const rule={channelId:'channel',enabled:true,mode:'pairing' as const,participants:[participant],confirmers:['approver'],allowModelOverride:false,instructions:'按来源整理草案'};
  im.saveRule(rule);
  receive!({chatId:'rule-chat',senderId:'new-person',messageId:'rule-request',type:'group',text:'接入测试',reply:{url:'https://oapi.dingtalk.com/robot/sendBySession?fixture=synthetic',expires:Date.now()+900000}});
  const request=im.events()[0]; const beforeCalls=calls;
  check('pairing-rule-does-not-run-model-before-approval',()=>{assert.equal(request.state,'pairing');assert.match(request.pairingCode!,/^[A-Z0-9]{6}$/);assert.equal(calls,beforeCalls);assert.equal(sent,2);assert.equal('reply' in im.publicEvents()[0],false);assert.equal('inputs' in im.publicEvents()[0],false);});
  receive!({chatId:'confirm',senderId:'intruder',messageId:'bad-confirm',type:'direct',text:'配对码 '+request.pairingCode});
  check('pairing-code-is-not-authorization-without-confirmer',()=>{assert.equal(im.events().find(e=>e.id===request.id)!.state,'pairing');assert.equal(calls,beforeCalls);});
  failSend=false;await im.sendPairingCode(request.id);await assert.rejects(im.sendPairingCode(request.id));
  check('pairing-code-send-is-explicit-and-once-only',()=>{assert.equal(sent,3);assert.equal(im.events().find(e=>e.id===request.id)!.codeState,'sent');});
  receive!({chatId:'confirm',senderId:'approver',messageId:'good-confirm',type:'direct',text:'配对码 '+request.pairingCode});
  const paired=im.events().find(e=>e.id===request.id)!;
  await wait(()=>repository.get(paired.taskId).status==='completed');im.synchronize();
  check('authorized-confirmation-binds-original-sender-and-one-task',()=>{assert.equal(im.sessions().find(s=>s.chatId==='rule-chat')!.senderId,'new-person');assert.equal(im.events().find(e=>e.id===request.id)!.state,'ready');assert.equal(calls,beforeCalls+1);assert.equal(sent,3);});
  const multi={...rule,mode:'open' as const,participants:[participant,{...participant,expertId:'hr-expert'}]};im.saveRule(multi);
  receive!({chatId:'multi-chat',senderId:'multi-person',messageId:'multi-message',type:'direct',text:'多专家接入'});
  const multiple=im.events()[0];await wait(()=>multiple.taskIds!.every(id=>repository.get(id).status==='completed'));im.synchronize();
  check('open-rule-creates-independent-expert-drafts-without-auto-send',()=>{assert.equal(multiple.taskIds!.length,2);assert.equal(new Set(multiple.taskIds).size,2);assert.equal(im.events().find(e=>e.id===multiple.id)!.state,'ready');assert.equal(sent,3);});
  const disabled=im.sessions().find(s=>s.chatId==='multi-chat')!;im.saveSession({...disabled,enabled:false});
  const beforeDisabled=calls;receive!({chatId:'multi-chat',senderId:'multi-person',messageId:'disabled-message',type:'direct',text:'停用后消息'});
  check('disabled-session-is-not-reopened-by-open-access-rule',()=>{assert.equal(im.events()[0].state,'rejected');assert.equal(calls,beforeDisabled);assert.equal(im.sessions().find(s=>s.id===disabled.id)!.enabled,false);});
  im.saveRule({...rule,allowModelOverride:true,mode:'open'});
  receive!({chatId:'model-chat',senderId:'model-person',messageId:'invalid-model',type:'direct',text:'/模型 unknown-service\n测试'});
  check('explicit-model-override-rejects-unconfigured-model-without-call',()=>{assert.equal(im.events()[0].state,'failed');assert.equal(calls,beforeDisabled);});
  const p2=permissions.read('hr-expert');permissions.save('hr-expert',{...p2,model:true,models:[]});im.saveRule(multi);
  receive!({chatId:'blocked-multi',senderId:'blocked-person',messageId:'blocked-multi',type:'direct',text:'全部专家先验证权限'});
  check('multi-expert-permissions-preflight-prevents-partial-model-work',()=>{assert.equal(im.events()[0].state,'failed');assert.equal(calls,beforeDisabled);});permissions.save('hr-expert',p2);
  im.close();im=new IMRuntime(profile,codec,library,tasks,()=>{},factory);await im.start();
  check('per-channel-rule-and-disabled-bindings-survive-restart',()=>{assert.equal(im.rules()[0].participants.length,2);assert.equal(im.sessions().find(s=>s.id===disabled.id)!.enabled,false);assert.equal(sent,3);});
  await im.sendReply(request.id);
  check('private-reply-route-survives-restart-with-distinct-qq-sequence',()=>{assert.equal(deliveredRoutes.at(-1)!.url,'https://oapi.dingtalk.com/robot/sendBySession?fixture=synthetic');assert.equal(deliveredRoutes.at(-1)!.sequence,2);assert.equal(sent,4);assert.equal('reply' in im.publicEvents().find(e=>e.id===request.id)!,false);});
  settings.save({...settings.preferences(),theme:'dark',reply:'English',awake:true});settings.activity(true);
  check('preferences-persist-and-wake-follows-active-tasks',()=> {assert.equal(settings.read().preferences.reply,'English');assert.equal(wake,true);settings.activity(false);assert.equal(wake,false);});
  const report={ok:true,platform:process.platform,arch:process.arch,checks,provider:'controlled model and IM adapter; real loopback MCP HTTP protocol',calls,effects,sent};fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }
} finally {
  im.close();tasks.close();settings.close();permissions.close();await connectors.close();repository.close();resources.close();library.close();
  for(const entry of serverSessions.values())await entry.server.close();httpServer.closeAllConnections();await new Promise<void>(r=>httpServer.close(()=>r()));
}
