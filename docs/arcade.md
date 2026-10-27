# P2L 游戏服务 SDK

本模块与既有 `createGameSDK` 验证协议并存。水晶与 P2L Points 独立；不提供充值、传统支付或广告网络。游戏页面部署在与 P2L 不同的 origin。身份凭证只由父页面持有。

## 现有 DF 游戏

已经使用 `window.parent.postMessage({dashfun:{method,payload}}, '*')` 的构建可直接放入 P2L 游戏目录，不需要重新接入或重做商店。父页面校验 iframe 的 source 和登记入口的 origin。

| 方法 | 输入 | 成功回调 data |
|---|---|---|
| getUserProfile | 空 | id、displayName、userName、avatarUrl、language 等原字段；id 为 P2L 用户 ID |
| loading | value: 0..1 | 空；旧协议 value=1 撤销加载遮罩 |
| getData | key | Base64 字符串，保持 DF 原编码语义 |
| getDataV2 | key | `{key,data: Base64字符串}` |
| setData | key、原始字符串 data | 本容器已读取/写入的存档键值表 |
| requestPayment | title、desc、info、整数 price | `{paymentId,invoiceLink:''}`，只创建订单 |
| openInvoice | paymentId | `{paymentId,status:'paid',msg:''}`；平台先显示确认窗口再扣水晶 |
| openTelegramLink | value | 只允许 HTTPS t.me 链接 |

旧回调为 `{dashfun:{method:方法名+'Result',result:{state:'success'或'error',data}}}`。失败 data 带 message/msg，支付失败带 paymentId 和 status。失败不返回 paid。未开放计费时平台弹窗提示，并返回失败回调。

`requestAd` 明确返回未开放，不产生订单或奖励。直接请求 DF API、硬编码 DF 域名或依赖 DF 专有账号数据的构建不属于纯桥接兼容范围。旧回调没有请求相关 ID，不能保证游戏自身不会重复发道具。平台只保证订单扣款幂等，不盲目重放成功回调。

`bridges/unity/Legacy` 与 `bridges/cocos/Legacy` 保存从本地 DF integration 核对的原桥接及已有 meta。保留 C# 命名空间、组件名和回调签名。现有构建无须覆盖这些文件；需要重新构建时保持原资源路径和 meta，避免序列化引用丢失。Unity 原 JavaScript 中 `dashfunBridge` 是工厂函数，仍按原模板调用。

## 新 P2L API

```js
import {createArcadeSDK} from '@play2launch/game-sdk';
const sdk = createArcadeSDK({parentOrigin:'https://你的P2L域名'});
await sdk.getUserProfile();
const save = await sdk.getData('main');
// 完成资源、玩家和存档初始化以后：
await sdk.loading(1); // 新协议只表示资源完成
await sdk.ready();   // 可以游玩，撤销遮罩
await sdk.setData('main', JSON.stringify({level:2}), save.version);
await sdk.report('score', 100, crypto.randomUUID());
```

parentOrigin 来自可信部署配置，不能直接相信 URL 查询参数或任意 referrer。新协议存档是原始字符串和 version，不再 Base64。显式保存成功后才可提示“已保存”；关闭浏览器时的保存不保证完成。

`report(metric,value,requestId)` 仅支持后台登记的非负整数指标。每会话每指标每秒最多一个新事件，开始后至少一秒；同一业务请求 ID 重试可以查询原结果，改变值会冲突。普通会话四小时；活动会话五分钟以内并受活动截止时间约束。活动绑定的计分指标应在本局结束时上报一次，第一条成功值结算本局，新的游戏局次须新建会话。其他指标可用于个人记录。客户端结果仍然可以伪造，不得当作验证成绩。

活动当前沿用 P2L 个人最高分计分。任务的 max 是最高值，count/sum 每会话只计一次；平台任务统计产生有效上报的不同会话。一次性、日、周周期均由服务端 UTC 决定，周一开始。

`getTasks()`、`getBalance()`、`getProducts()`、`getOrders()`、`getOrder(id)`、`confirmDelivery(id)` 提供查询及发货确认。平台任务页面和游戏详情承载任务 UI。测试会话返回 test=true，其存档、水晶、订单与正式数据隔离，不发正式 Points。

## 互斥商品模式

游戏传入模式：
```js
const requestId=crypto.randomUUID(); // 保存到本局状态，网络重试复用
const order=await sdk.requestPayment({title:'Sword',desc:'One sword',price:20,info:'sword'},requestId);
const paid=await sdk.openInvoice(order.paymentId);
```

服务端商品模式：
```js
const products=await sdk.getProducts();
const order=await sdk.purchase(products[0].id,1,'custom data',crypto.randomUUID());
// 按 order.id 去重发货，然后：
await sdk.confirmDelivery(order.id);
```

价格单位始终是整数水晶。服务端模式拒绝客户端传价；游戏传入模式拒绝 productId，不自动切换。旧订单的价格、数量、商品版本和模式保留快照。订单十五分钟过期；创建与确认都检查实时计费开关。充值关闭时余额不足返回错误，没有外部付费入口。

支付请求超时必须先查询原订单，不能换 requestId 猜测重买。已支付且未确认发货的订单由游戏自身按订单 ID 恢复发货。退款回水晶，不能保证收回单机道具；恢复存档不会回退账本。

## 引擎封装

- H5：ESM 导入，或加载 `dist/p2l-sdk.js` 后使用 `P2LGameSDK.createArcadeSDK`。
- Cocos：安装本 SDK 包，使用 `bridges/cocos/P2LArcade.ts`；组件持有一个实例，在 onDestroy 调用 destroy。
- Unity WebGL：模板加载 `dist/p2l-sdk.js`，加入 `P2LArcade.jslib` 与 `P2LArcadeBridge.cs`。Initialize 配置固定父 origin，Call 接受方法名与 JSON 参数数组，Result 事件收到包含 id/state/data 或 message 的 JSON。GameObject 名称须唯一。原 DashFunBridge 可以继续使用，不需要更换商店代码。

`examples/arcade.html` 是新接口联调页；先修改可信父 origin，再在后台登记该页面。它不是正式游戏内容。Legacy 文件未经本次 Unity/Cocos 引擎重新编译；应在目标引擎和实际构建环境做发布前验收。
