import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createStreamAdapter, type IMTransport } from '../electron/im-adapters';
import type { IncomingIM } from '../electron/feishu-adapter';
const output=process.argv[2], checks:string[]=[], requests:Array<{url:string;body:any;headers:http.IncomingHttpHeaders}>=[], sockets:any[]=[];
let provider='dingtalk', rejectReply=false;
const server=http.createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const url=decodeURIComponent(req.url!.slice(1)); const body=text?JSON.parse(text):{};requests.push({url,body,headers:req.headers});
  res.setHeader('content-type','application/json');
  if(url.includes('/connections/open'))res.end(JSON.stringify({endpoint:'wss://gateway.dingtalk.com/connect',ticket:'synthetic-ticket'}));
  else if(url.includes('gettoken'))res.end(JSON.stringify({errcode:0,access_token:'synthetic-token',expires_in:7200}));
  else if(url.includes('getAppAccessToken'))res.end(JSON.stringify({access_token:'synthetic-token',expires_in:'7200'}));
  else if(url.endsWith('/gateway'))res.end(JSON.stringify({url:'wss://api.bot.qq.com/websocket/'}));
  else if(url.includes('sendBySession'))res.end(JSON.stringify({errcode:rejectReply?400:0}));
  else res.end(JSON.stringify(rejectReply?{code:400}:{id:'local-qq-receipt'}));
});
const wss=new WebSocketServer({server});wss.on('connection',socket=>{
  sockets.push(socket);socket.on('message',raw=>{
    const data=JSON.parse(raw.toString());
    if(provider==='wecom'&&data.cmd==='aibot_subscribe')socket.send(JSON.stringify({headers:data.headers,errcode:0}));
    if(provider==='wecom'&&data.cmd==='aibot_respond_msg')socket.send(JSON.stringify({headers:data.headers,errcode:rejectReply?400:0}));
    if(provider==='qq'&&data.op===2)socket.send(JSON.stringify({op:0,t:'READY',s:1,d:{session_id:'local-session'}}));
  });
  if(provider==='dingtalk')socket.send(JSON.stringify({type:'SYSTEM',headers:{topic:'REGISTERED'},data:'{}'}));
  if(provider==='qq')socket.send(JSON.stringify({op:10,d:{heartbeat_interval:45000}}));
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
const transport:IMTransport={fetch:(url,options)=>fetch(`http://127.0.0.1:${port}/`+encodeURIComponent(String(url)),options),socket:()=>new WebSocket(`ws://127.0.0.1:${port}`)};
const wait=async(condition:()=>boolean)=>{const end=Date.now()+3000;while(!condition()){if(Date.now()>end)throw new Error('Protocol timeout');await new Promise(r=>setTimeout(r,5));}};
try{
  for(const p of ['dingtalk','wecom','qq'] as const){provider=p;const received:IncomingIM[]=[];const adapter=createStreamAdapter(p,'synthetic-app','synthetic-secret',()=>{},transport);await adapter.start(m=>received.push(m));assert.equal(adapter.state(),'connected');const socket=sockets.at(-1);
    const route='https://oapi.dingtalk.com/robot/sendBySession?session=synthetic-route';
    const data=p==='dingtalk'?{type:'CALLBACK',headers:{topic:'/v1.0/im/bot/messages/get',messageId:'frame-id'},data:JSON.stringify({msgId:'ding-message',msgtype:'text',conversationId:'chat',conversationType:'2',isInAtList:true,senderStaffId:'person',text:{content:'controlled text'},sessionWebhook:route,sessionWebhookExpiredTime:Date.now()+900000})}:p==='wecom'?{cmd:'aibot_msg_callback',headers:{req_id:'callback-req'},body:{msgid:'wecom-message',chattype:'group',chatid:'chat',from:{userid:'person'},msgtype:'text',text:{content:'controlled text'}}}:{op:0,t:'GROUP_AT_MESSAGE_CREATE',s:2,d:{id:'qq-message',group_openid:'chat',author:{member_openid:'person'},content:'controlled text',timestamp:new Date().toISOString()}};
    socket.send(JSON.stringify(data));await wait(()=>received.length===1);assert.equal(received[0].senderId,'person');assert.equal(received[0].type,'group');
    const receipt=await adapter.send(received[0].messageId,'受控合成回复','local-test',received[0].reply);assert.ok(receipt);checks.push(`${p}-official-text-frame-and-explicit-reply-over-loopback`);
    const before=requests.length;assert.throws(()=>adapter.validateReply!('expired',{...received[0].reply,expires:Date.now()-1}),/过期/);assert.equal(requests.length,before);checks.push(`${p}-expired-reply-window-has-no-network-effect`);
    rejectReply=true;await assert.rejects(adapter.send(received[0].messageId,'rejected','local-reject',received[0].reply));rejectReply=false;checks.push(`${p}-provider-rejection-is-not-a-success-receipt`);
    if(p==='dingtalk'){socket.send(JSON.stringify({...data,data:JSON.stringify({msgId:'not-at',msgtype:'text',conversationType:'2',isInAtList:false})}));await new Promise(r=>setTimeout(r,20));assert.equal(received.length,1);assert.throws(()=>adapter.validateReply!('redirect',{url:'https://evil.example/robot/sendBySession',expires:Date.now()+900000}));checks.push('dingtalk-ignore-nonmention-and-reject-untrusted-reply-host');}
    if(p==='qq'){const replyRequest=requests.findLast(r=>r.url.includes('/groups/'))!;assert.equal(replyRequest.headers.authorization,'QQBot synthetic-token');assert.equal(replyRequest.body.msg_seq,1);checks.push('qq-current-access-token-and-passive-reply-sequence');}
    if(p==='wecom'){socket.send(JSON.stringify({cmd:'aibot_event_callback',body:{event:{eventtype:'disconnected_event'}}}));await wait(()=>adapter.state()==='failed');checks.push('wecom-replaced-connection-stops-without-fighting-new-connection');}
    adapter.close();assert.equal(adapter.state(),'idle');
  }
  const report={ok:true,provider:'Official message schemas exchanged with a local synthetic HTTP/WebSocket service; no platform accounts',checks};fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{for(const socket of sockets)socket.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
