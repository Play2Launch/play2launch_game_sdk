import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

test('build produces valid framework-free script and legacy auto-loader',()=>{
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/build.mjs',import.meta.url))]);
  const script=readFileSync(new URL('../dist/p2l-sdk.js',import.meta.url),'utf8');
  const context=vm.createContext({});vm.runInContext(script,context);
  assert.equal(typeof context.P2LGameSDK.createGameSDK,'function');
  assert.equal(context.P2LGameSDK.PROTOCOL,'p2l-game-v1');
  // Legacy loader is safe when no config/browser is provided.
  vm.runInNewContext(readFileSync(new URL('../dist/p2l-bridge.js',import.meta.url),'utf8'),{});
  assert.equal(readFileSync(new URL('../dist/p2l-sdk.mjs',import.meta.url),'utf8'),readFileSync(new URL('../src/sdk.js',import.meta.url),'utf8'));
});
