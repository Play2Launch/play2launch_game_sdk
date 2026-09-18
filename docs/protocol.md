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
