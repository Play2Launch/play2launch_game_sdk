# Lifecycle protocol v1

This protocol is not the existing server's score API. Integration must be added explicitly.

All lifecycle messages have `protocol: "p2l-game-v1"`, `type`, `instance_id`, `game_id`, `rules_version`, and `session_id` (null until initialized). Instance ID is generated per SDK instance to reject delayed messages from previous mounts. All replies echo matching identifiers. Identifiers are 1–128 ASCII letters/numbers/underscore/dot/colon/hyphen. Only the exact configured parent window and origin are accepted.

| Direction | Type | Additional fields / meaning |
| --- | --- | --- |
| Game → host | `p2l:ready` | `sdk_version`; assets ready, awaiting session; repeat is a retry |
| Host → game | `p2l:init` | `session: {id,seed,expires_at,duration_ms,allow_pause}` |
| Game → host | `p2l:initialized` | session acknowledged, sent before init callback |
| Game → host | `p2l:start` | player began initialized session |
| Game → host | `p2l:progress` | `sequence`, `report: {elapsed_ms,score,metrics?}` |
| Game → host | `p2l:pause` / `p2l:resume` | only if session permits pause |
| Game → host | `p2l:finish` | `submission_id`, immutable `report` incl. optional `inputs` |
| Host → game | `p2l:result` | matching `submission_id`, `status: accepted/rejected`, accepted `score`, optional `message` |
| Host → game | `p2l:error` | while submitting: matching `submission_id`, `code`, `message`, `retryable` |
| Host → game | `p2l:error` | while waiting: `stage: init`, current `session_id` or null, `code`, `message`; remains waiting |
| Game → host | `p2l:restart` | previous session ID; host creates NEW session and replies init |
| Game → host | `p2l:exit` | host owns navigation; SDK destroys itself |
| Game → host | `p2l:game-error` | `code`, `message`; can report loading failures before ready |

`expires_at`: Unix milliseconds; `seed`: uint32. Duration: 1000–86400000 milliseconds, additionally restricted by backend per game. Game must obey duration and pause policy. SDK checks declared elapsed time but does not control the game loop. Seed and policy come from authenticated host/API; a seed is not a secret.

State: loading → waiting → initialized → playing ↔ paused → submitting → finished. Demo skips waiting/submitting and returns local result. `restart()` from finished enters waiting (platform) or initialized (demo). Duplicate init does not reset a run; previously seen session IDs cannot be reused. The client limits an instance to 1000 sessions; reload before reaching this limit.

Default initialization/result timeout: 15 seconds; it emits an error, never invents success or falls back. `ready()` retries initialization; host must return the same pending session for repeated ready messages rather than create multiple concurrent sessions. `retrySubmission()` sends the same submission ID and frozen report. Retryable error leaves state submitting; rejection/nonretryable error finishes it. Backend remains authoritative for exactly-once settlement, timeout, expiry, interruption and concurrent rounds.

Progress forwarding interval defaults to 5 seconds; the GAME calls progress from its own loop/timer. SDK throttles but never synthesizes stats. Elapsed must be nondecreasing and within duration. Finish is not throttled. Score <=1e12; metrics <=32 nonnegative numeric entries with key `[a-z][a-z0-9_]{0,47}`; report serialized size <=16,000 characters, finish <=512,000, inputs <=12,000 ordered `{tick,held}` events. These are payload sanity checks, not gameplay validation.

Host must reject messages not bound to the actual iframe window, expected game origin, instance, game, rule, current authenticated session and submission. Never transfer account bearer tokens into the iframe. Real result must come from backend, never echo the submitted score like the mock host. Keep accepted/rejected results idempotent by session, including different malicious submission IDs.

## Communication-check compatibility

Separate protocol `p2l-communication-v1` remains unchanged. Challenge has `game_id,key_id,nonce,expires_at`; nonce is 64 lowercase hex chars, expiry within 60s. Signature input is UTF-8 JSON array `[protocol,game_id,key_id,nonce,expires_at]`. Ed25519 seed is Base64 32 bytes; response signature is Base64 64 bytes. SDK checks source and configured admin origin, rejects expired/replayed challenges, bounds nonce cache, suppresses replies after destruction. Errors use legacy `p2l:error` + nonce, without lifecycle envelope.

Random challenge proves a responding page loaded a compatible SDK/configuration. It does not establish code identity, score integrity, game readiness, publishing permission or reward eligibility. The key embedded in H5 is public in practice. Backend UI should say “SDK 通信测试通过”, separately from “计分已接入”.


## Optional extensions (SDK 0.2.0)

The envelope remains `p2l-game-v1`. `p2l:ready.capabilities` may contain
`metrics-v1` and `realtime-v1`. Omitting capabilities preserves the original
seed/replay lifecycle. PAPERHOOD does not require an SDK upgrade.

### Verified metrics

Accepted `p2l:result` messages may add `metrics: Record<string, number>`.
Keys are bounded lowercase identifiers; values are nonnegative safe integers.
`score` remains the scalar primary result for old integrations. Client report
metrics remain claims only: the platform returns values calculated by its validator.
The game configuration endpoint lists supported metric keys and the primary key.
Market Combo uses `total_score`, `winning_combo`, `losing_combo`.

### Realtime lifecycle

A realtime init has no `seed`. It contains normal session id/expiration plus
`realtime: {version: 'realtime-v1', tick_ms: 2000, starts_at: <UTC milliseconds>}`,
`allow_pause: false`, and `duration_ms: tick_ms * 100 + 3000` (3 seconds preparation + up to
100 beats). The SDK emits `realtime_init`; `sdk.realtimeSession` exposes this
session. Legacy `init` and `sdk.session` retain their original seed-bearing type.

The game calls `sdk.start()` after initialization, then schedules visuals from
server timestamps. Round 1 accepts input from `starts_at` until strictly before
`starts_at + tick_ms`; every subsequent round has the next fixed deadline.

- `sdk.action(round, 'long' | 'short')` sends a generated stable `action_id`.
  Retrying the same direction reuses that id. One direction is locked per beat.
- `action` events acknowledge receipt, not a correct prediction. No future outcome
  is returned before its deadline.
- `snapshot` contains revision, server time, resolved round count, next deadline,
  status, completed rounds, optional locked `pending` input, and verified metrics.
  Use it to restore visuals and input locks after reconnecting. Outdated revisions
  are ignored. A snapshot includes no unresolved random value or seed.
- `sdk.sync()` asks the host to restore its connection. The host reconnects using a
  fresh one-use ticket and replays unacknowledged input with its original id.
- Finished snapshots produce one accepted `result`; cancelled snapshots produce a
  rejected result. `sdk.restart()` is allowed after completion.
- `finish`, `progress` and pause are unavailable in authoritative realtime mode.
  Exiting or losing connectivity does not pause the server clock.

All messages still require exact parent origin, source window, game, rules,
instance and session binding. Bearer credentials and WebSocket tickets stay in
P2L's parent page and never cross into the game iframe.

The existing demo lifecycle stays local and seed-based. A standalone Market Combo
website must implement its own practice clock/visuals; practice results never
enter platform rankings. The independent `PlayToLaunch_marketcombo` website uses only the platform adapter; it deliberately has no local practice mode.

Cadence values are server-defined integers from 1000 through 5000ms, in 100ms steps. The SDK accepts both the original 1000ms and the new default 2000ms. Completed rounds may include `choice: long | short`, allowing charts to show the original prediction alongside its verified outcome.
