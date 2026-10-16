# Controller protocol v1

All endpoints require `Authorization: Bearer <APP_ACCESS_TOKEN>`. Never put credentials in query strings. Remote access requires HTTPS/WSS. The server limits payloads, connections and request rates, refuses browser origins by default, and disconnects slow WebSocket clients.

## HTTP

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/state` | Authoritative portfolio snapshot |
| GET | `/v1/feed` | Compact feed rows; no full chart histories |
| GET | `/v1/commands/<id>` | Original durable command/status |
| POST | `/v1/command` | Validate and acknowledge one command |

POST bodies use `Content-Type: application/json`, maximum 16 KiB. Extra or missing fields are rejected. A successful POST returns HTTP 202 with a `COMMAND_ACK`; inspect its stage, including rejection, rather than assuming execution succeeded.

## WebSocket

Connect to `/stream` with the same Authorization header at upgrade. Authentication happens before any portfolio data is sent. The server sends a portfolio and feed snapshot on each new connection. Do not automatically replay trades with new command IDs on reconnect.

Every server frame has:

```json
{"v":1,"type":"PORTFOLIO_UPDATE","seq":12,"at":1791990000000,"ledgerSeq":7,"data":{}}
```

`seq` orders frames for the running server and may restart when the process restarts. `ledgerSeq` refers to durable events. Request a fresh snapshot on every reconnect. Alerts have their own durable event sequence inside `data`; deduplicate by it.

Server types: `PORTFOLIO_UPDATE`, `FEED_UPDATE`, `CHART_HISTORY`, `COMMAND_ACK`, `COMMAND_ERROR`, `TRADE_ALERT`.

Read-only client frames:

```json
{"v":1,"type":"GET_SNAPSHOT"}
{"v":1,"type":"GET_CHART","mint":"ACTUAL_MINT_ADDRESS"}
```

Chart responses contain up to 512 observed timestamped market-cap points and the available safety report. No chart data is fabricated when history is absent. Feed rows retain at most 30 sparkline values. State/feed bursts are coalesced to one batch per second.

## Commands

Every mutating command requires `v: 1`, a `type`, and an unpredictable unique `id` of 16–80 ASCII letters, digits, underscores or hyphens. UUIDs work. IDs and canonical payload hashes are saved before work starts. Reusing the same ID/payload returns the original action; using a different payload with that ID fails.

| Type | Other required fields |
| --- | --- |
| `QUICK_TRADE` buy | `side: "buy"`, `mint`, `amountSol` as a positive decimal string, maximum nine fractional places |
| `QUICK_TRADE` sell | `side: "sell"`, `mint`, `percentBps` as an integer 1–10000 |
| `SET_BOT_PRESET` | `preset`: Safe/Fast/Degen; booleans `autoPilot`, `normalEnabled`, `copyEnabled`; `amountSol` string |
| `SET_ALLOCATIONS` | Integer `normalPct`, `copyPct`, `reservePct`, each 0–100, summing to 100 |
| `PAUSE_ENTRIES` | Boolean `paused` |
| `PANIC_CASH_OUT_ALL` | No other fields |

Example (replace the mint):

```json
{"v":1,"id":"e6d4d249-48e0-4a6c-830c-04dd1c685e86","type":"QUICK_TRADE","side":"buy","mint":"ACTUAL_MINT_ADDRESS","amountSol":"0.05"}
```

Never send raw floating-point token quantities. The server computes sale quantity from its actual managed position. Manual purchases consume the normal allocation and use the same financial and token-policy gates as automatic entries.

## States and display rules

Commands can be `received`, `accepted` (a control change), `preparing`, `prepared`, `submitted`, `unknown`, `confirmed`, `finalized`, `failed` or `rejected`.

- `prepared`: exact signature and native audit are durably saved; not proof of submission.
- `submitted`: transport accepted the request; not a fill.
- `unknown`: submission or recovery is ambiguous; the original signature remains reserved.
- `confirmed`: receipt effects have been booked once and are awaiting finality. New finances remain blocked.
- `finalized`: final receipt accepted. Paper fills use this stage with `mode: paper` and no real signature.
- `failed`: a reconciled failed transaction, including its actual fee. A rejected preflight/command is `rejected` instead.

Only `TRADE_FILLED` durable events can produce a fill toast. Label paper events **Paper fill**. A confirmed result must not be shown as finalized. `TRADE_SUBMITTED` is an acknowledgment, not a successful trade.

Snapshots include cash, reserved cash, unreserved cash, conservative affordable buy ceilings, actual SOL cost basis, estimated exit PnL, reference valuations, allocations, halts, copy health, pending orders and recent commands. Raw amounts are decimal strings. Unknown/stale marks yield null valuation/PnL, not zero or an invented price. `referenceOnlyChangeUsd` isolates the movement of the original SOL funding reference; it is not realized trading PnL or a complete FX attribution model.

`maxAffordableBuyLamports` excludes estimated entry overhead but is only an upper bound. Token checks, position conflicts, own-size quotes and round-trip costs can still reject an order. Exit protections continue with auto-pilot off while the backend remains running.

No server frame contains a wallet key, vault secret, provider credential or signed transaction. The future Swift app must store its controller credential in Keychain and must not contain backend secrets.

## Step 3 additions (backend 0.3.1)

Authenticated `GET /v1/performance` and read-only WebSocket `{"v":1,"type":"GET_PERFORMANCE"}` return `STRATEGY_REPORT`. The response contains mode/base, receipt source, unfinalized-effect flag, total native realized PnL, and per-entry-strategy counts, costs, realized PnL, fees/rent and open-position counts. Raw financial amounts remain strings. This is recorded performance, not a predictive signal or backtest.

The Swift client package in `../ios` implements this protocol, requiring current state/feed snapshots before commands and preserving original command IDs across interruptions. See `STEP_3_ARCHITECTURE.md` for its recovery and credential rules.
