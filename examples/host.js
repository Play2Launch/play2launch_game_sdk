import { PROTOCOL } from '../src/sdk.js';
const frame = document.getElementById('game');
let channel = null, session = null;
const results = new Map();
function log(d) { const el=document.getElementById('log'); el.textContent=(JSON.stringify(d)+'\n'+el.textContent).slice(0,16000); }
function send(type, data={}) { frame.contentWindow.postMessage({ ...channel, type, session_id:session?.id ?? null, ...data }, location.origin); }
function initialize() {
  session = { id: 'mock_'+crypto.randomUUID(), seed: crypto.getRandomValues(new Uint32Array(1))[0],
    duration_ms:90000, expires_at:Date.now()+300000, allow_pause:true };
  send('p2l:init',{session});
}
window.addEventListener('message', e => {
  const d=e.data;
  if (e.source!==frame.contentWindow || e.origin!==location.origin || !d || d.protocol!==PROTOCOL || d.game_id!=='sdk-example' || d.rules_version!=='example-v1') return;
  log(d);
  if(d.type==='p2l:ready') {
    if(channel?.instance_id!==d.instance_id) { channel={protocol:PROTOCOL,instance_id:d.instance_id,game_id:d.game_id,rules_version:d.rules_version}; initialize(); }
    else send('p2l:init',{session});
    return;
  }
  if(!channel || d.instance_id!==channel.instance_id || d.session_id!==session?.id) return;
  if(d.type==='p2l:restart') { initialize(); return; }
  if(d.type!=='p2l:finish') return;
  const key=session.id+':'+d.submission_id;
  if(results.has(key)) { send('p2l:result',results.get(key));return; }
  const response=document.getElementById('response').value;
  if(response==='timeout')return;
  if(response==='retry') { send('p2l:error',{submission_id:d.submission_id,code:'MOCK_UNAVAILABLE',message:'模拟暂时失败，请切换到接受后重试',retryable:true});return; }
  // Simulation only! A real host must forward to its authenticated API, never accept this score itself.
  const result={submission_id:d.submission_id,status:response,score:d.report.score,message:'模拟结果，不计入榜单'};
  results.set(key,result);send('p2l:result',result);
});
document.getElementById('reload').onclick=()=>{channel=null;session=null;results.clear();frame.src='game.html?mode=platform&embed=1';};
