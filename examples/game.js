import { createGameSDK } from '../src/sdk.js';
const $ = id => document.getElementById(id);
const platform = new URLSearchParams(location.search).get('mode') === 'platform';
// Fixed local demo origin, not a value accepted from URL/referrer.
const sdk = createGameSDK({ gameId: 'sdk-example', rulesVersion: 'example-v1',
  ...(platform ? { parentOrigin: 'http://127.0.0.1:5191', allowedParentOrigins: ['http://127.0.0.1:5191'] } : {}),
  progressIntervalMs: 1000, timeoutMs: 5000 });
let score = 0, elapsed = 0;
function log(value) { $('log').textContent = JSON.stringify(value, null, 2); }
function update() {
  $('state').textContent = `${sdk.mode} / ${sdk.state} / score=${score}`;
  for (const [name, states] of Object.entries({start:['initialized'],add:['playing'],pause:['playing','paused'],finish:['playing','paused'],retry:['submitting'],restart:['finished']})) $(name).disabled = !states.includes(sdk.state);
  $('pause').textContent = sdk.state === 'paused' ? '恢复' : '暂停';
}
sdk.on('init', s => { score = 0; elapsed = 0; log(s); update(); });
sdk.on('result', r => { log(r); update(); });
sdk.on('error', e => { log(e); update(); });
const stats = () => ({ score, elapsed_ms: elapsed, metrics: { collected: score / 100 } });
const actions = { start:()=>sdk.start(), add:()=>{score+=100;elapsed+=1000;sdk.progress(stats());},
  pause:()=>sdk.state==='paused'?sdk.resume():sdk.pause(), finish:()=>sdk.finish(stats()),
  retry:()=>sdk.retrySubmission(), restart:()=>sdk.restart(), exit:()=>sdk.exit() };
for (const [name, action] of Object.entries(actions)) $(name).onclick = () => { try { action(); } catch(e) { log(e.message); } update(); };
sdk.ready(); update();
window.addEventListener('pagehide', () => sdk.destroy(), { once: true });
