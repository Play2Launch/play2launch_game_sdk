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
