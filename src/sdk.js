// Client-side signatures check communication only. They are NOT score credentials.
const VERSION = '0.2.0';
const PROTOCOL = 'p2l-game-v1';
const CHECK_PROTOCOL = 'p2l-communication-v1';
const active = new WeakMap();
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function origin(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.origin !== value || u.username || u.password) throw Error('Expected an exact HTTP(S) origin');
  return value;
}
function snapshot(value, max) {
  const json = JSON.stringify(value);
  if (!json || json.length > max) throw Error('Payload too large or empty');
  return JSON.parse(json);
}
function report(value, final) {
  if (!object(value) || !integer(value.elapsed_ms, 86400000) || !integer(value.score, 1e12)) throw Error('Invalid report');
  const result = { elapsed_ms: value.elapsed_ms, score: value.score };
  if (value.metrics !== undefined) {
    if (!object(value.metrics) || Object.keys(value.metrics).length > 32) throw Error('Invalid metrics');
    result.metrics = {};
    for (const [key, v] of Object.entries(value.metrics)) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(key) || !Number.isFinite(v) || v < 0 || v > 1e12) throw Error('Invalid metric');
      result.metrics[key] = v;
    }
  }
  if (value.inputs !== undefined) {
    if (!final || !Array.isArray(value.inputs) || value.inputs.length > 12000) throw Error('Invalid input log');
    let last = -1;
    result.inputs = value.inputs.map(e => {
      if (!object(e) || !integer(e.tick, 10000000) || e.tick < last || typeof e.held !== 'boolean') throw Error('Invalid input event');
      last = e.tick; return { tick: e.tick, held: e.held };
    });
  }
  return snapshot(result, final ? 512000 : 16000);
}

function verifiedMetrics(value) {
 if (!object(value) || Object.keys(value).length < 1 || Object.keys(value).length > 32) throw Error('Invalid verified metrics');
 const result = {};
 for (const [key, v] of Object.entries(value)) {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(key) || !integer(v, 1e12)) throw Error('Invalid verified metric');
  Object.defineProperty(result,key,{value:v,enumerable:true});
 }
 return result;
}
function realtimeSnapshot(value) {
 if(!object(value) || !integer(value.revision) || !integer(value.server_time) || !integer(value.round,100) ||
  !integer(value.deadline_at) || !['playing','finished','cancelled'].includes(value.status) || !Array.isArray(value.rounds) || value.rounds.length>100) throw Error('Invalid realtime snapshot');
 let last=0;
 const rounds=value.rounds.map(r=>{
  if(!object(r)||!integer(r.round,100)||r.round!==last+1||!['up','down'].includes(r.direction)||
   !['win','loss','miss'].includes(r.outcome)||!integer(r.score,1e12)||!integer(r.combo,100)) throw Error('Invalid round');
  if(r.choice!==undefined&&!['long','short'].includes(r.choice))throw Error('Invalid choice');
  last=r.round;return {...(r.choice?{choice:r.choice}:{}),round:r.round,direction:r.direction,outcome:r.outcome,score:r.score,combo:r.combo};
 });
 if(value.rounds.length!==value.round || !object(value.metrics)) throw Error('Invalid snapshot progress');
 let pending;
 if(value.pending!=null){const p=value.pending;if(!object(p)||p.round!==value.round+1||!integer(p.round,100)||!['long','short'].includes(p.direction)||typeof p.action_id!=='string'||!/^[a-f0-9]{32}$/.test(p.action_id)||value.status!=='playing')throw Error('Invalid pending action');pending={round:p.round,action_id:p.action_id,direction:p.direction};}
 return {...(pending?{pending}:{}),revision:value.revision,server_time:value.server_time,round:value.round,deadline_at:value.deadline_at,status:value.status,rounds,metrics:verifiedMetrics(value.metrics)};
}

/** Second argument is a browser-like runtime for isolated tests; normally omit it. */
function createGameSDK(options, win = globalThis.window) {
  if (!win || active.has(win)) throw Error('Only one SDK instance per window; destroy the previous instance first');
  if (!options || !id(options.gameId) || !id(options.rulesVersion)) throw Error('Invalid game or rules identifier');
  const capabilities = options.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some(v=>!['metrics-v1','realtime-v1'].includes(v)) || new Set(capabilities).size!==capabilities.length) throw Error('Unknown capability');
  const params = new URLSearchParams(win.location.search);
  const mode = options.mode ?? params.get('mode') ?? 'demo';
  if (!['demo', 'platform'].includes(mode)) throw Error('Unknown mode');
  const origins = new Set((options.allowedParentOrigins ?? []).map(origin));
  const parentOrigin = options.parentOrigin === undefined ? null : origin(options.parentOrigin);
  if (mode === 'platform' && (!parentOrigin || !origins.has(parentOrigin) || win.parent === win)) throw Error('Platform mode requires an iframe and an explicitly allowed parentOrigin');
  const timeoutMs = options.timeoutMs ?? 15000;
  const progressIntervalMs = options.progressIntervalMs ?? 5000;
  if (!integer(timeoutMs, 120000) || timeoutMs < 100 || !integer(progressIntervalMs, 60000) || progressIntervalMs < 100) throw Error('Invalid timing options');
  const crypto = win.crypto;
  const unique = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
  const instanceId = unique();
  const listeners = new Map();
  let state = 'loading', session = null, timer = null, destroyed = false;
  let finalReport = null, submissionId = null, lastProgress = -Infinity, lastElapsed = 0, sequence = 0;
  const seen = new Map();
  const sessionIds = new Set();
  let revision = -1, resolvedRound = 0;
  const actions = new Map();
  const check = options.testConfig;
  if (check && (!id(check.game_id) || check.game_id !== options.gameId || !id(check.key_id) || typeof check.private_key !== 'string')) throw Error('Invalid communication test config');
  const checkOrigin = check ? origin(check.parent_origin) : null;
  const emit = (name, value) => {
    for (const fn of listeners.get(name) ?? []) { try { fn(snapshot(value, 600000)); } catch (error) { win.console?.error('P2L SDK event handler failed', error); } }
  };
  const clearTimer = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  const arm = (code, message) => {
    clearTimer(); timer = win.setTimeout(() => { timer = null; if (!destroyed) emit('error', { code, message, retryable: true }); }, timeoutMs);
  };
  const send = (type, data = {}) => {
    if (destroyed || mode !== 'platform') return;
    win.parent.postMessage({ protocol: PROTOCOL, type, instance_id: instanceId, game_id: options.gameId,
      rules_version: options.rulesVersion, session_id: session?.id ?? null, ...data }, parentOrigin);
  };
  function live(...states) { if (destroyed || !states.includes(state)) throw Error(`Operation not allowed in ${state}`); }
  function resetRound(value) {
    session = value; state = 'initialized'; finalReport = null; submissionId = null;
    lastProgress = -Infinity; lastElapsed = 0; sequence = 0; revision = -1; resolvedRound = 0; actions.clear();
    clearTimer(); if (mode === 'platform') send('p2l:initialized'); emit(session.realtime?'realtime_init':'init', session);
  }
  function demoRound() {
    resetRound({ id: `demo_${unique()}`, seed: crypto.getRandomValues(new Uint32Array(1))[0],
      expires_at: Date.now() + 86400000, duration_ms: 90000, allow_pause: true });
  }
  async function challenge(event, d) {
    if (!check || event.source !== win.parent || win.parent === win || event.origin !== checkOrigin ||
      d.game_id !== check.game_id || d.key_id !== check.key_id || d.protocol !== CHECK_PROTOCOL ||
      typeof d.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(d.nonce) ||
      !integer(d.expires_at) || Date.now() >= d.expires_at || d.expires_at > Date.now() + 60000) return;
    for (const [nonce, expiry] of seen) if (expiry <= Date.now()) seen.delete(nonce);
    if (seen.has(d.nonce) || seen.size >= 100) return;
    seen.set(d.nonce, d.expires_at);
    try {
      const seed = Uint8Array.from(atob(check.private_key), c => c.charCodeAt(0));
      if (seed.length !== 32) throw Error('Invalid test key');
      const der = new Uint8Array(48);
      der.set([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]); der.set(seed, 16);
      const key = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign']);
      const signature = await crypto.subtle.sign('Ed25519', key,
        new TextEncoder().encode(JSON.stringify([d.protocol,d.game_id,d.key_id,d.nonce,d.expires_at])));
      if (!destroyed && Date.now() < d.expires_at) event.source.postMessage({ type: 'p2l:response', protocol: d.protocol,
        game_id: d.game_id, key_id: d.key_id, nonce: d.nonce, expires_at: d.expires_at,
        signature: btoa(String.fromCharCode(...new Uint8Array(signature))) }, event.origin);
    } catch {
      if (!destroyed) event.source.postMessage({ type: 'p2l:error', nonce: d.nonce }, event.origin);
    }
  }
  function receive(event) {
    if (destroyed || !object(event.data)) return;
    const d = event.data;
    if (d.type === 'p2l:challenge') { void challenge(event, d); return; }
    if (mode !== 'platform' || event.source !== win.parent || event.origin !== parentOrigin ||
      d.protocol !== PROTOCOL || d.instance_id !== instanceId || d.game_id !== options.gameId || d.rules_version !== options.rulesVersion) return;
    if (d.type === 'p2l:error' && state === 'waiting' && d.stage === 'init' &&
      d.session_id === (session?.id ?? null) && typeof d.code === 'string') {
      clearTimer(); emit('error', { code: d.code.slice(0,80), message: typeof d.message === 'string' ? d.message.slice(0,500) : '', retryable: true }); return;
    }
    if (d.type === 'p2l:init') {
      const s = d.session;
      const realtime = s?.realtime;
      if (state !== 'waiting' || !object(s) || !id(s.id) || sessionIds.has(s.id) || sessionIds.size >= 1000 ||
        !integer(s.expires_at) || s.expires_at <= Date.now() || !integer(s.duration_ms,86400000) || s.duration_ms<1000 || typeof s.allow_pause!=='boolean') return;
      if (realtime !== undefined) {
       if (!capabilities.includes('realtime-v1') || s.seed!==undefined || s.allow_pause || !object(realtime) || realtime.version!=='realtime-v1' || realtime.tick_ms<1000 || realtime.tick_ms>5000 || !Number.isInteger(realtime.tick_ms) || realtime.tick_ms%100!==0 || !integer(realtime.starts_at) || realtime.starts_at>=s.expires_at) return;
      } else if (!integer(s.seed,0xffffffff)) return;
      sessionIds.add(s.id);
      resetRound({id:s.id,...(realtime?{realtime:{version:'realtime-v1',tick_ms:realtime.tick_ms,starts_at:realtime.starts_at}}:{seed:s.seed}),expires_at:s.expires_at,duration_ms:s.duration_ms,allow_pause:s.allow_pause});
      return;
    }
    if (!session || d.session_id !== session.id) return;
    if (session.realtime && ['initialized','playing'].includes(state)) {
      if(d.type==='p2l:error'&&typeof d.code==='string'){emit('error',{code:d.code.slice(0,80),message:typeof d.message==='string'?d.message.slice(0,500):'',retryable:d.retryable===true});return;}
      if(d.type==='p2l:snapshot') {
       let data;try{data=realtimeSnapshot(d.snapshot);}catch{return;}
       if(data.revision<revision || data.round<resolvedRound) return;
       revision=data.revision;resolvedRound=data.round;
       for(const [round] of actions) if(round<=resolvedRound) actions.delete(round);
       if(data.pending) actions.set(data.pending.round,{...data.pending});
       emit('snapshot',data);
       if(data.status==='finished') {state='finished';emit('result',{mode,status:'accepted',session_id:session.id,score:data.metrics.total_score??data.metrics.score??0,metrics:data.metrics});}
       if(data.status==='cancelled') {state='finished';emit('result',{mode,status:'rejected',session_id:session.id,score:null,message:'Session cancelled'});}
       return;
      }
      if(d.type==='p2l:action-ack') {
       const pending=actions.get(d.round);
       if(!pending || pending.action_id!==d.action_id || typeof d.accepted!=='boolean') return;
       emit('action',{round:d.round,action_id:d.action_id,accepted:d.accepted});return;
      }
    }
    if (d.type === 'p2l:result') {
      if (state !== 'submitting' || d.submission_id !== submissionId || !['accepted', 'rejected'].includes(d.status) ||
        (d.status === 'accepted' && !integer(d.score, 1e12))) return;
      let metrics;try{if(d.status==='accepted'&&d.metrics!==undefined)metrics=verifiedMetrics(d.metrics);}catch{return;}
      clearTimer(); state = 'finished';
      emit('result', { mode, status: d.status, session_id: session.id, score: d.status === 'accepted' ? d.score : null, ...(metrics?{metrics}:{}),
        message: typeof d.message === 'string' ? d.message.slice(0, 500) : '' });
    } else if (d.type === 'p2l:error' && state === 'submitting' && d.submission_id === submissionId && typeof d.code === 'string') {
      clearTimer(); const retryable = d.retryable === true;
      if (!retryable) state = 'finished';
      emit('error', { code: d.code.slice(0, 80), message: typeof d.message === 'string' ? d.message.slice(0, 500) : '', retryable });
    }
  }
  const sdk = {
    get mode() { return mode; }, get state() { return state; },
    get session() { return session && !session.realtime ? snapshot(session,16000) : null; },
    get realtimeSession() { return session?.realtime ? snapshot(session,16000) : null; },
    on(name, handler) {
      if (destroyed || !['init', 'realtime_init', 'result', 'error', 'snapshot', 'action'].includes(name) || typeof handler !== 'function') throw Error('Invalid listener');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler); return () => listeners.get(name)?.delete(handler);
    },
    ready() {
      live('loading', 'waiting');
      if (mode === 'demo') { demoRound(); return; }
      state = 'waiting'; arm('INIT_TIMEOUT', 'Platform initialization timed out; call ready() to retry');
      send('p2l:ready', { sdk_version: VERSION, ...(capabilities.length?{capabilities:[...capabilities]}:{}) });
    },
    start() {
      live('initialized');
      if (Date.now() >= session.expires_at) throw Error('Session expired');
      state = 'playing'; send('p2l:start');
    },
    pause() { live('playing'); if (!session.allow_pause) throw Error('Pause is disabled for this session'); state = 'paused'; send('p2l:pause'); },
    resume() { live('paused'); state = 'playing'; send('p2l:resume'); },
    progress(value) {
      live('playing'); if(session.realtime) throw Error('Realtime scores are server-owned'); const data = report(value, false);
      if (data.elapsed_ms < lastElapsed || data.elapsed_ms > session.duration_ms) throw Error('Invalid elapsed time');
      if (win.performance.now() - lastProgress < progressIntervalMs) return false;
      lastProgress = win.performance.now(); lastElapsed = data.elapsed_ms;
      send('p2l:progress', { sequence: ++sequence, report: data }); return true;
    },
    finish(value) {
      live('playing', 'paused'); if(session.realtime) throw Error('Realtime sessions finish on the server'); const data = report(value, true);
      if (data.elapsed_ms < lastElapsed || data.elapsed_ms > session.duration_ms) throw Error('Invalid elapsed time');
      finalReport = data; submissionId = unique();
      if (mode === 'demo') {
        state = 'finished'; emit('result', { mode, status: 'local', session_id: session.id, score: data.score }); return;
      }
      state = 'submitting'; sdk.retrySubmission();
    },
    action(round, direction) {
      live('playing');
      if(!session.realtime || !integer(round,100) || round<1 || round<=resolvedRound || !['long','short'].includes(direction)) throw Error('Invalid realtime action');
      const previous=actions.get(round);
      if(previous && previous.direction!==direction) throw Error('A round choice is locked');
      if(!previous && actions.size>=2) throw Error('Await round acknowledgement');
      const value=previous??{round,direction,action_id:unique()};actions.set(round,value);
      send('p2l:action',value);return value.action_id;
    },
    sync() {
      live('initialized','playing');if(!session.realtime) throw Error('Realtime capability not negotiated');
      send('p2l:sync',{after_revision:revision});
    },
    retrySubmission() {
      live('submitting'); arm('RESULT_TIMEOUT', 'Result timed out; retry the same submission');
      send('p2l:finish', { submission_id: submissionId, report: snapshot(finalReport, 512000) });
    },
    restart() {
      live('finished');
      if (mode === 'demo') { demoRound(); return; }
      state = 'waiting'; arm('INIT_TIMEOUT', 'New session timed out; call ready() to retry'); send('p2l:restart');
    },
    reportError(code, message) {
      if (destroyed || !id(code) || typeof message !== 'string' || message.length > 500) throw Error('Invalid error report');
      send('p2l:game-error', { code, message });
    },
    exit() { live('loading','waiting','initialized','playing','paused','submitting','finished'); send('p2l:exit'); sdk.destroy(); },
    destroy() {
      if (destroyed) return;
      destroyed = true; state = 'destroyed'; clearTimer(); listeners.clear(); seen.clear();
      win.removeEventListener('message', receive); active.delete(win);
    },
  };
  active.set(win, sdk); win.addEventListener('message', receive); return sdk;
}

// Drop-in compatibility for the existing admin ZIP: config first, bridge second.
function installLegacyBridge(win = globalThis.window) {
  if (!win?.P2L_TEST_CONFIG || win.P2LBridge) return win?.P2LBridge;
  const config = win.P2L_TEST_CONFIG;
  const sdk = createGameSDK({ gameId: config.game_id, rulesVersion: 'communication-only', mode: 'demo', testConfig: config }, win);
  win.P2LBridge = { destroy() { sdk.destroy(); delete win.P2LBridge; } };
  return win.P2LBridge;
}

// Casual-game services are separate from verified competition sessions. No
// credential is ever sent into the game; the parent owns authenticated calls.
function createArcadeSDK(options, win = globalThis.window) {
  const origin = new URL(options.parentOrigin).origin;
  if (origin !== options.parentOrigin || !/^https?:/.test(origin) || win.parent === win) throw Error('A trusted parent origin and iframe are required');
  const pending = new Map(); let destroyed = false;
  const receive = event => {
    if (event.source !== win.parent || event.origin !== origin) return;
    const value = event.data?.p2lArcade;
    const item = pending.get(value?.id);
    if (!item || value.method !== item.method + 'Result') return;
    pending.delete(value.id); clearTimeout(item.timer);
    if (value.result?.state === 'success') item.resolve(value.result.data);
    else item.reject(Error(value.result?.data?.message || 'Game request failed'));
  };
  win.addEventListener('message', receive);
  const call = (method, payload = {}) => {
    if (destroyed) return Promise.reject(Error('SDK destroyed'));
    const id = win.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Request timed out; query the order before retrying a purchase')); }, method === 'purchase' || method === 'openInvoice' ? 300000 : 30000);
      pending.set(id, { method, resolve, reject, timer });
      win.parent.postMessage({ p2lArcade: { id, method, payload } }, origin);
    });
  };
  return {
    ready: () => call('ready'), getUserProfile: () => call('getUserProfile'),
    loading: value => call('loading', { value }),
    getData: key => call('getDataV2', { key }),
    setData: (key, data, version) => call('setData', { key, data, version }),
    report: (metric, value, requestId = win.crypto.randomUUID()) => call('report', { metric, value, request_id: requestId }),
    getTasks: () => call('getTasks'), getBalance: () => call('getBalance'), getProducts: () => call('getProducts'),
    requestPayment: (product, requestId = win.crypto.randomUUID()) => call('requestPayment', { ...product, request_id: requestId }),
    openInvoice: paymentId => call('openInvoice', { paymentId }),
    purchase: (productId, quantity = 1, payload = '', requestId = win.crypto.randomUUID()) => call('purchase', { product_id: productId, quantity, payload, request_id: requestId }),
    getOrder: orderId => call('getOrder', { order_id: orderId }), getOrders: () => call('getOrders'),
    confirmDelivery: orderId => call('confirmDelivery', { order_id: orderId }),
    exit: () => call('exit'),
    destroy() { if (destroyed) return; destroyed = true; win.removeEventListener('message', receive); for (const v of pending.values()) { clearTimeout(v.timer); v.reject(Error('SDK destroyed')); } pending.clear(); },
  };
}

export { VERSION, PROTOCOL, createGameSDK, installLegacyBridge, createArcadeSDK };
