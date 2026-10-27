import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createGameSDK, installLegacyBridge, PROTOCOL } from '../src/sdk.js';

function runtime(search='?mode=platform') {
  const sent=[], listeners=new Set(), timers=new Map(); let serial=0, now=0;
  const parent={postMessage:(d,target)=>sent.push({d,target})};
  const win={location:{search}, parent, crypto:webcrypto, console, performance:{now:()=>now},
    addEventListener:(type,fn)=>listeners.add(fn), removeEventListener:(type,fn)=>listeners.delete(fn),
    setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:n=>timers.delete(n)};
  const options={gameId:'paper-run',rulesVersion:'v1',parentOrigin:'https://p2l.test',allowedParentOrigins:['https://p2l.test']};
  const fire=(d,extra={})=>{for(const fn of listeners)fn({source:parent,origin:'https://p2l.test',data:d,...extra});};
  return {win,sent,options,fire,listeners,timers,advance:ms=>now+=ms,timeout:()=>{const all=[...timers.values()];timers.clear();all.forEach(f=>f());}};
}
function platform() {
  const r=runtime(),sdk=createGameSDK(r.options,r.win);sdk.ready();
  const envelope={...r.sent[0].d};
  const session={id:'gs123',seed:42,expires_at:Date.now()+60000,duration_ms:90000,allow_pause:true};
  const init=()=>r.fire({...envelope,type:'p2l:init',session});
  return {...r,sdk,envelope,session,init};
}
const stats={elapsed_ms:1000,score:100,metrics:{collected:1}};
test('initialization errors remain retryable and game loading errors can be reported',()=>{
  const r=platform();let error;r.sdk.on('error',v=>error=v);
  r.fire({...r.envelope,type:'p2l:error',stage:'init',code:'SESSION_UNAVAILABLE',message:'retry'});
  assert.equal(error.code,'SESSION_UNAVAILABLE');assert.equal(r.sdk.state,'waiting');
  r.sdk.reportError('ASSET_FAILED','Could not load texture');assert.equal(r.sent.at(-1).d.type,'p2l:game-error');
  assert.throws(()=>r.sdk.reportError('BAD','x'.repeat(501)));r.sdk.ready();r.init();r.sdk.destroy();
});
test('demo uses local sessions/results and sends no lifecycle messages',()=>{
  const r=runtime(''),sdk=createGameSDK(r.options,r.win);let result;
  sdk.on('result',r=>result=r);sdk.ready();assert.equal(sdk.mode,'demo');assert.match(sdk.session.id,/^demo_/);
  sdk.start();sdk.finish(stats);assert.equal(result.status,'local');assert.equal(r.sent.length,0);
  const first=sdk.session.id;sdk.restart();assert.notEqual(sdk.session.id,first);sdk.destroy();
});
test('embed alone never opts into platform mode',()=>{
  const r=runtime('?embed=1');const sdk=createGameSDK(r.options,r.win);assert.equal(sdk.mode,'demo');sdk.destroy();
});
test('platform requires a parent and exact deployment-controlled origin',()=>{
  const r=runtime();assert.throws(()=>createGameSDK({...r.options,parentOrigin:'*'},r.win));
  assert.throws(()=>createGameSDK({...r.options,allowedParentOrigins:[]},r.win));
  r.win.parent=r.win;assert.throws(()=>createGameSDK(r.options,r.win));
  r.win.location.search='?mode=typo';assert.throws(()=>createGameSDK(r.options,r.win));
});
test('timeout stays waiting and ready can retry; never falls back to demo',()=>{
  const r=platform();let error;r.sdk.on('error',e=>error=e);r.timeout();
  assert.equal(error.code,'INIT_TIMEOUT');assert.equal(r.sdk.state,'waiting');assert.equal(r.sdk.mode,'platform');
  assert.throws(()=>r.sdk.start());r.sdk.ready();r.init();assert.equal(r.sdk.state,'initialized');r.sdk.destroy();
});
test('foreign origin/source/channel/rules and invalid sessions are ignored',()=>{
  const r=platform();const message={...r.envelope,type:'p2l:init',session:r.session};
  r.fire(message,{origin:'https://evil.test'});r.fire(message,{source:{}});
  for(const patch of [{instance_id:'old'},{rules_version:'v2'},{protocol:'wrong'},{game_id:'other'},
    {session:{...r.session,seed:-1}},{session:{...r.session,expires_at:1}},{session:{...r.session,duration_ms:0}}])r.fire({...message,...patch});
  assert.equal(r.sdk.state,'waiting');r.init();assert.equal(r.sdk.state,'initialized');
  assert.equal(r.sent.at(-1).target,'https://p2l.test');r.sdk.destroy();
});
test('ack precedes init callback; duplicate init cannot reset an active run',()=>{
  const r=platform();r.sdk.on('init',()=>r.sdk.start());r.init();r.init();
  assert.equal(r.sdk.state,'playing');assert.deepEqual(r.sent.map(v=>v.d.type),['p2l:ready','p2l:initialized','p2l:start']);r.sdk.destroy();
});
test('progress is rate limited, monotonic, bounded and has no unknown fields',()=>{
  const r=platform();r.init();r.sdk.start();assert.equal(r.sdk.progress({...stats,token:'do-not-send'}),true);
  assert.equal(r.sdk.progress(stats),false);r.advance(5000);assert.equal(r.sdk.progress({...stats,elapsed_ms:6000}),true);
  assert.equal(r.sent.at(-1).d.sequence,2);assert.equal(r.sent.at(-1).d.report.token,undefined);
  assert.throws(()=>r.sdk.progress(stats));assert.throws(()=>r.sdk.progress({...stats,elapsed_ms:100000}));
  assert.throws(()=>r.sdk.progress({...stats,score:NaN}));assert.throws(()=>r.sdk.progress({...stats,metrics:{bad:-1}}));r.sdk.destroy();
});
test('pause policy and state transitions are enforced',()=>{
  const r=platform();r.session.allow_pause=false;r.init();r.sdk.start();assert.throws(()=>r.sdk.pause());r.sdk.destroy();
  const s=platform();s.init();s.sdk.start();s.sdk.pause();assert.throws(()=>s.sdk.progress(stats));s.sdk.resume();assert.equal(s.sdk.state,'playing');s.sdk.exit();assert.equal(s.sdk.state,'destroyed');
});
test('submission snapshot and id stay identical on timeout retry',()=>{
  const r=platform();r.init();r.sdk.start();const data={...stats,metrics:{collected:1},inputs:[{tick:1,held:true}]};
  r.sdk.finish(data);const first=r.sent.at(-1).d;data.metrics.collected=999;data.inputs[0].held=false;
  r.timeout();assert.equal(r.sdk.state,'submitting');r.sdk.retrySubmission();assert.deepEqual(r.sent.at(-1).d,first);
  assert.throws(()=>r.sdk.finish(stats));r.sdk.destroy();
});
test('results bind to session/submission and settle once with server score',()=>{
  const r=platform();r.init();r.sdk.start();r.sdk.finish(stats);let count=0,result;r.sdk.on('result',v=>{count++;result=v;});
  const d={...r.sent.at(-1).d,type:'p2l:result',status:'accepted',score:90};
  r.fire({...d,session_id:'other'});r.fire({...d,submission_id:'other'});r.fire({...d,score:-1});assert.equal(count,0);
  r.fire(d);r.fire(d);assert.equal(count,1);assert.equal(result.score,90);assert.equal(r.sdk.state,'finished');
  r.sdk.restart();r.init();assert.equal(r.sdk.state,'waiting');r.session.id='gs456';r.init();assert.equal(r.sdk.state,'initialized');r.sdk.destroy();
});
test('retryable errors keep final report; rejection permits restart',()=>{
  const r=platform();r.init();r.sdk.start();r.sdk.finish(stats);const d=r.sent.at(-1).d;
  r.fire({...d,type:'p2l:error',code:'TEMP',retryable:true});assert.equal(r.sdk.state,'submitting');r.sdk.retrySubmission();
  r.fire({...d,type:'p2l:result',status:'rejected'});assert.equal(r.sdk.state,'finished');r.sdk.destroy();
});
test('destroy cleans timers/listeners and permits remount',()=>{
  const r=platform();assert.throws(()=>createGameSDK(r.options,r.win));r.sdk.destroy();r.sdk.destroy();
  assert.equal(r.listeners.size,0);assert.equal(r.timers.size,0);assert.throws(()=>r.sdk.ready());
  const next=createGameSDK(r.options,r.win);next.destroy();
});
test('bad or oversized input logs are rejected',()=>{
  const r=platform();r.init();r.sdk.start();
  assert.throws(()=>r.sdk.finish({...stats,inputs:[{tick:2,held:true},{tick:1,held:false}]}));
  assert.throws(()=>r.sdk.finish({...stats,inputs:Array.from({length:12001},(_,tick)=>({tick,held:true}))}));r.sdk.destroy();
});
test('session getter cannot change internal seed/expiration',()=>{
  const r=platform();r.init();r.sdk.session.seed=0;r.sdk.session.expires_at=0;assert.equal(r.sdk.session.seed,42);r.sdk.start();r.sdk.destroy();
});
test('legacy challenge signs the exact original payload, rejects replay and cleans up',async()=>{
  const r=runtime('');const keys=await webcrypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const der=new Uint8Array(await webcrypto.subtle.exportKey('pkcs8',keys.privateKey));
  r.win.P2L_TEST_CONFIG={game_id:'paper-run',key_id:'gk1',private_key:Buffer.from(der.slice(-32)).toString('base64'),parent_origin:'https://p2l.test'};
  const bridge=installLegacyBridge(r.win);assert.equal(installLegacyBridge(r.win),bridge);
  const d={type:'p2l:challenge',protocol:'p2l-communication-v1',game_id:'paper-run',key_id:'gk1',nonce:'a'.repeat(64),expires_at:Date.now()+20000};
  r.fire(d,{origin:'https://evil.test'});assert.equal(r.sent.length,0);r.fire(d);
  for(let i=0;i<100&&!r.sent.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(r.sent.length,1);const response=r.sent[0];assert.equal(response.target,'https://p2l.test');assert.equal(response.d.type,'p2l:response');
  const payload=new TextEncoder().encode(JSON.stringify([d.protocol,d.game_id,d.key_id,d.nonce,d.expires_at]));
  assert.equal(await webcrypto.subtle.verify('Ed25519',keys.publicKey,Buffer.from(response.d.signature,'base64'),payload),true);
  r.fire(d);r.fire({...d,nonce:'b'.repeat(64),expires_at:Date.now()-1});assert.equal(r.sent.length,1);
  bridge.destroy();assert.equal(r.win.P2LBridge,undefined);assert.equal(r.listeners.size,0);
});
test('destroy during signing suppresses late replies',async()=>{
  const r=runtime('');let done;const signature=new Promise(resolve=>done=resolve);
  r.win.crypto={getRandomValues:a=>webcrypto.getRandomValues(a),subtle:{importKey:async()=>({}),sign:()=>signature}};
  const sdk=createGameSDK({...r.options,mode:'demo',testConfig:{game_id:'paper-run',key_id:'gk',parent_origin:'https://p2l.test',private_key:Buffer.alloc(32).toString('base64')}},r.win);
  r.fire({type:'p2l:challenge',protocol:'p2l-communication-v1',game_id:'paper-run',key_id:'gk',nonce:'c'.repeat(64),expires_at:Date.now()+20000});
  await Promise.resolve();sdk.destroy();done(new Uint8Array(64));await Promise.resolve();await Promise.resolve();assert.equal(r.sent.length,0);
});

test('preserves ordered press/release edges in the same tick',()=>{
 const r=platform();r.init();r.sdk.start();
 const inputs=[{tick:0,held:true},{tick:0,held:false},{tick:1,held:true}];
 r.sdk.finish({...stats,inputs});
 assert.deepEqual(r.sent.at(-1).d.report.inputs,inputs);r.sdk.destroy();
});

function realtime() {
 const r=runtime(),sdk=createGameSDK({...r.options,capabilities:['metrics-v1','realtime-v1']},r.win);sdk.ready();
 const envelope={...r.sent[0].d};const session={id:'gsrt1',expires_at:Date.now()+103000,duration_ms:103000,allow_pause:false,realtime:{version:'realtime-v1',tick_ms:1000,starts_at:Date.now()+3000}};
 const init=()=>r.fire({...envelope,type:'p2l:init',session});return {...r,sdk,envelope,session,init};
}
test('realtime is negotiated without a seed, locks inputs and never uploads scores',()=>{
 const r=realtime();let initialized;r.sdk.on('realtime_init',v=>initialized=v);r.init();assert.equal(initialized.id,'gsrt1');assert.equal(r.sdk.session,null);assert.equal(r.sdk.realtimeSession.realtime.tick_ms,1000);
 r.sdk.start();const id=r.sdk.action(1,'long');assert.equal(r.sdk.action(1,'long'),id);assert.throws(()=>r.sdk.action(1,'short'));assert.throws(()=>r.sdk.pause());assert.throws(()=>r.sdk.finish(stats));assert.throws(()=>r.sdk.progress(stats));
 r.sdk.sync();assert.equal(r.sent.at(-1).d.type,'p2l:sync');r.sdk.destroy();
});
test('realtime snapshots are monotonic, session-bound and finish only once',()=>{
 const r=realtime();r.init();r.sdk.start();let results=[];r.sdk.on('result',v=>results.push(v));
 const snapshot={revision:2,server_time:Date.now(),round:1,deadline_at:Date.now()+1000,status:'playing',rounds:[{round:1,direction:'up',outcome:'win',score:10,combo:1}],metrics:{total_score:10,winning_combo:1,losing_combo:0}};
 const message={...r.envelope,session_id:r.session.id,type:'p2l:snapshot',snapshot};r.fire(message);assert.throws(()=>r.sdk.action(1,'long'));
 r.fire({...message,session_id:'other',snapshot:{...snapshot,status:'finished'}});assert.equal(results.length,0);
 r.fire({...message,snapshot:{...snapshot,revision:1,status:'finished'}});assert.equal(results.length,0);
 r.fire({...message,snapshot:{...snapshot,revision:3,status:'finished'}});r.fire(message);assert.equal(results.length,1);assert.equal(results[0].metrics.total_score,10);r.sdk.destroy();
});
test('verified result metrics are optional for v1 and reject malformed values',()=>{
 const r=platform();r.init();r.sdk.start();r.sdk.finish(stats);let result;r.sdk.on('result',v=>result=v);
 const d={...r.sent.at(-1).d,type:'p2l:result',status:'accepted',score:90};r.fire({...d,metrics:{score:Infinity}});assert.equal(result,undefined);
 r.fire({...d,metrics:{score:90}});assert.deepEqual(result.metrics,{score:90});r.sdk.destroy();
});
test('legacy host cannot silently initialize a realtime-capable run with leaked seed',()=>{
 const r=realtime();r.session.seed=12;r.init();assert.equal(r.sdk.state,'waiting');r.sdk.destroy();
 const legacy=platform();delete legacy.session.seed;legacy.session.realtime={version:'realtime-v1',tick_ms:1000,starts_at:Date.now()};legacy.init();assert.equal(legacy.sdk.state,'waiting');legacy.sdk.destroy();
});


test('restored pending input stays locked and acknowledgements are bound to its id',()=>{
 const r=realtime();r.init();r.sdk.start();let snapshots=[],acks=[];
 r.sdk.on('snapshot',v=>snapshots.push(v));r.sdk.on('action',v=>acks.push(v));
 const pending={round:1,action_id:'f'.repeat(32),direction:'short'};
 const snapshot={revision:1,server_time:Date.now(),round:0,deadline_at:Date.now()+1000,status:'playing',rounds:[],pending,metrics:{total_score:0,winning_combo:0,losing_combo:0}};
 r.fire({...r.envelope,session_id:r.session.id,type:'p2l:snapshot',snapshot});
 assert.deepEqual(snapshots[0].pending,pending);assert.throws(()=>r.sdk.action(1,'long'));assert.equal(r.sdk.action(1,'short'),pending.action_id);
 r.fire({...r.envelope,session_id:r.session.id,type:'p2l:action-ack',round:1,action_id:'0'.repeat(32),accepted:true});assert.equal(acks.length,0);
 r.fire({...r.envelope,session_id:r.session.id,type:'p2l:action-ack',...pending,accepted:true});assert.equal(acks.length,1);r.sdk.destroy();
});

test('accepts server-defined cadence and forwards the resolved choice',()=>{
 const r=realtime();r.session.realtime.tick_ms=2000;r.session.duration_ms=203000;r.init();assert.equal(r.sdk.realtimeSession.realtime.tick_ms,2000);r.sdk.start();let got;r.sdk.on('snapshot',v=>got=v);
 const snapshot={revision:1,server_time:Date.now(),round:1,deadline_at:Date.now()+2000,status:'playing',rounds:[{round:1,direction:'down',choice:'long',outcome:'loss',score:10,combo:1}],metrics:{total_score:10,winning_combo:0,losing_combo:1}};
 r.fire({...r.envelope,type:'p2l:snapshot',session_id:r.session.id,snapshot});assert.equal(got.rounds[0].choice,'long');r.sdk.destroy();
 for(const interval of [999,1001,5001,NaN]){const bad=realtime();bad.session.realtime.tick_ms=interval;bad.init();assert.equal(bad.sdk.state,'waiting');bad.sdk.destroy();}
});
