# Play2Launch Game SDK

零运行时依赖的浏览器游戏 SDK。一个游戏 build 同时支持独立体验和 P2L 平台接入；适用于原生 H5、Canvas、React、Vue。

**当前是 SDK/协议层，不是计分服务器。** 随机挑战只检查 SDK 通信，不证明游戏身份、分数可信或防作弊；正式成绩必须由 P2L 后端核验局次并结算。PAPERHOOD 和管理端尚未切换使用本仓库。

## 开发与下载

Node.js 22+，无第三方依赖：

```sh
npm ci
npm test
npm run build
npm run dev
```

模拟平台位于 http://127.0.0.1:5191，独立体验示例位于 `/examples/game.html`。示例只模拟输入、分数和结算，可切换接受、拒绝、可重试失败及超时；不请求真实服务端、不写榜单。示例固定允许此本机地址，如换域名需明确修改部署配置。

构建产物（`dist/`，不提交 Git）：

| 文件 | 用途 |
| --- | --- |
| `p2l-sdk.js` | 普通 script，全局 `P2LGameSDK`，无自动实例化 |
| `p2l-sdk.mjs` | ESM 模块 |
| `p2l-sdk.d.ts` | TypeScript 类型 |
| `p2l-bridge.js` | 旧版后台通信测试包的兼容脚本，自动读取 `P2L_TEST_CONFIG` |

GitHub Actions 每次推送测试并构建，可在对应运行的 Artifacts 下载 `p2l-game-sdk`。未发布 npm 包；源码可作为本地 package 或固定 Git 提交依赖使用。

## 一个 build，两种模式

- 普通链接默认 `demo`：SDK 生成本地随机种子和 `demo_` 局次，结束返回 `status: local`，不发送平台计分消息。
- `?mode=platform`：必须处于 iframe，且配置可信父页面 origin。SDK 等待平台初始化，没有初始化不允许开局；超时不会降级成体验版。
- `embed=1` 只由游戏控制布局，SDK 不读取它；体验版也可以嵌入 iframe。
- URL 不授予计分权限。平台创建的局次和后端核验才决定能否计分。
- 体验模式当前默认 90 秒、允许暂停；平台时长和暂停规则由初始化下发。

## 游戏接入

```html
<script src="/sdk/p2l-sdk.js"></script>
<script>
const sdk = P2LGameSDK.createGameSDK({
  gameId: 'paper-run',
  rulesVersion: 'paper-run-v1',
  parentOrigin: 'https://app.example.com',
  allowedParentOrigins: ['https://app.example.com'],
  // testConfig: window.P2L_TEST_CONFIG, // optional, retains admin challenge checks
});
sdk.on('init', session => {
  // Reset your game with session.seed and session.duration_ms.
  // Only enable the start button after this callback.
});
sdk.on('result', result => {
  // Show the platform's returned score, or a clearly local demo result.
});
sdk.on('error', error => {
  // INIT_TIMEOUT: show retry -> sdk.ready().
  // RESULT_TIMEOUT/retryable submit error: show retry -> sdk.retrySubmission().
});
// Call only after loading assets and registering handlers:
sdk.ready();
</script>
```

From game events:

```js
sdk.start(); // when the player actually starts the initialized round
sdk.progress({ elapsed_ms: 5000, score: 450, metrics: { distance: 35, collected: 1 } });
// Call progress regularly. Default forwarding limit: once per 5000ms, using a monotonic clock.
sdk.finish({ elapsed_ms: 90000, score: 9000, metrics: { distance: 700, collected: 20, won: 1 },
  inputs: [{ tick: 1, held: true }, { tick: 12, held: false }] });
// Optional inputs are saved for future verification, not replayed by this SDK.
// After result: sdk.restart() requests a NEW platform session, or initializes a local demo round.
// sdk.pause()/resume() require allow_pause; game must pause its own simulation.
// sdk.exit() notifies host then destroys the SDK. Host owns navigation.
```

Reports use integer nonnegative `elapsed_ms` and `score`. Metrics are a flat map of finite nonnegative numbers (up to 32 keys). Unknown report fields are stripped; never put account tokens/private data into messages. Input ticks must be strictly increasing; if the game records multiple transitions on one tick, normalize before submitting. Report schema limits are transport hygiene, **not anti-cheat rules**.

Call `reportError(code,message)` for asset/loading/game failures; do not include credentials in messages. Game functions throw for invalid states/data, so UI handlers should catch and display errors. Framework unmount must call `destroy()`; one SDK instance per window. React StrictMode remount is supported with cleanup. SDK never edits the DOM, router, pointer/keyboard events, or framework state.

## 随机挑战兼容

保留原来的 `p2l-communication-v1`、`p2l:challenge` / `p2l:response` 和 Ed25519 签名 payload，不改变后台现有测试格式。

新游戏：将后台生成的 `p2l-config.js` 提供给 `createGameSDK({..., testConfig: window.P2L_TEST_CONFIG})`，不要再加载旧 bridge。

只做旧通信测试：按顺序加载 `p2l-config.js` 和构建后的 `p2l-bridge.js`，仍提供 `P2LBridge.destroy()`。**不要同时加载旧 bridge 和手动创建完整 SDK。** 不提交实际生成的配置/密钥到仓库；H5 中的测试私钥本身视为公开，只检查通信。

测试 parent_origin 可以是管理端域名，与真实运行 parentOrigin 分开。完整游戏使用严格的实际 origin；旧后台 opaque sandbox 的 origin=null 回复规则仅限其通信测试，不能当作正式游戏的计分通道。Ed25519 检查需要 HTTPS 或 localhost 安全上下文及浏览器支持。

## 平台端职责与边界

见 [完整协议](docs/protocol.md)。平台负责认证、创建服务端局次、向 iframe 初始化、接收并上报数据、将后端结算结果转回游戏。校验 `event.source`、准确 `event.origin`、instance/session/submission，使用明确 targetOrigin。

本仓库没有登录 token、真实局次数据库、Go 回放或可信验分。服务端需对每一局幂等结算（不能只按提交 ID）、限制并发和频率、保存种子/规则/队伍快照并检查计分合理性。后续规则以服务端配置为准，不能由客户端选择跳过验证。

生产环境建议游戏独立域名，用 CSP `frame-ancestors` 限定平台/管理端，避免 `X-Frame-Options` 阻止合法 iframe。本地 host 示例使用同源 iframe 和 `allow-same-origin` 仅便于开发，不能作为隔离不可信游戏的生产方案。部署配置是静态可信配置，禁止直接把任意 URL 参数或 referrer 作为可信来源。
