// Client-side signatures check communication only. They are NOT score credentials.
const VERSION = '0.1.1';
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

/** Second argument is a browser-like runtime for isolated tests; normally omit it. */
function createGameSDK(options, win = globalThis.window) {
  if (!win || active.has(win)) throw Error('Only one SDK instance per window; destroy the previous instance first');
  if (!options || !id(options.gameId) || !id(options.rulesVersion)) throw Error('Invalid game or rules identifier');
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
    lastProgress = -Infinity; lastElapsed = 0; sequence = 0;
    clearTimer(); if (mode === 'platform') send('p2l:initialized'); emit('init', session);
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
      if (state !== 'waiting' || !object(s) || !id(s.id) || sessionIds.has(s.id) || sessionIds.size >= 1000 || !integer(s.seed, 0xffffffff) ||
        !integer(s.expires_at) || s.expires_at <= Date.now() || !integer(s.duration_ms, 86400000) || s.duration_ms < 1000 || typeof s.allow_pause !== 'boolean') return;
      sessionIds.add(s.id);
      resetRound({ id:s.id, seed:s.seed, expires_at:s.expires_at, duration_ms:s.duration_ms, allow_pause:s.allow_pause });
      return;
    }
    if (!session || d.session_id !== session.id) return;
    if (d.type === 'p2l:result') {
      if (state !== 'submitting' || d.submission_id !== submissionId || !['accepted', 'rejected'].includes(d.status) ||
        (d.status === 'accepted' && !integer(d.score, 1e12))) return;
      clearTimer(); state = 'finished';
      emit('result', { mode, status: d.status, session_id: session.id, score: d.status === 'accepted' ? d.score : null,
        message: typeof d.message === 'string' ? d.message.slice(0, 500) : '' });
    } else if (d.type === 'p2l:error' && state === 'submitting' && d.submission_id === submissionId && typeof d.code === 'string') {
      clearTimer(); const retryable = d.retryable === true;
      if (!retryable) state = 'finished';
      emit('error', { code: d.code.slice(0, 80), message: typeof d.message === 'string' ? d.message.slice(0, 500) : '', retryable });
    }
  }
  const sdk = {
    get mode() { return mode; }, get state() { return state; },
    get session() { return session ? { ...session } : null; },
    on(name, handler) {
      if (destroyed || !['init', 'result', 'error'].includes(name) || typeof handler !== 'function') throw Error('Invalid listener');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler); return () => listeners.get(name)?.delete(handler);
    },
    ready() {
      live('loading', 'waiting');
      if (mode === 'demo') { demoRound(); return; }
      state = 'waiting'; arm('INIT_TIMEOUT', 'Platform initialization timed out; call ready() to retry');
      send('p2l:ready', { sdk_version: VERSION });
    },
    start() {
      live('initialized');
      if (Date.now() >= session.expires_at) throw Error('Session expired');
      state = 'playing'; send('p2l:start');
    },
    pause() { live('playing'); if (!session.allow_pause) throw Error('Pause is disabled for this session'); state = 'paused'; send('p2l:pause'); },
    resume() { live('paused'); state = 'playing'; send('p2l:resume'); },
    progress(value) {
      live('playing'); const data = report(value, false);
      if (data.elapsed_ms < lastElapsed || data.elapsed_ms > session.duration_ms) throw Error('Invalid elapsed time');
      if (win.performance.now() - lastProgress < progressIntervalMs) return false;
      lastProgress = win.performance.now(); lastElapsed = data.elapsed_ms;
      send('p2l:progress', { sequence: ++sequence, report: data }); return true;
    },
    finish(value) {
      live('playing', 'paused'); const data = report(value, true);
      if (data.elapsed_ms < lastElapsed || data.elapsed_ms > session.duration_ms) throw Error('Invalid elapsed time');
      finalReport = data; submissionId = unique();
      if (mode === 'demo') {
        state = 'finished'; emit('result', { mode, status: 'local', session_id: session.id, score: data.score }); return;
      }
      state = 'submitting'; sdk.retrySubmission();
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

export { VERSION, PROTOCOL, createGameSDK, installLegacyBridge };
