# Speed, bandwidth and measurement — version 4

The target is reacting promptly to data that is actually available. This package removes long fixed polling waits, gives exits priority and batches discovery. It does **not** establish a sub-second confirmed mainnet fill.

## What happens at each stage

| Stage | Implemented behavior | Timing limit |
|---|---|---|
| Wallet wake hint | Processed native/owned classic-token notifications wake the loop immediately | Provider/network delivery; a notification does not establish a successful trade |
| Source verification | Successful finalized Helius history, actual signer/owners and supported swap instructions | Confirmation/index lag and bounded retry; processed source trades are not copied blindly |
| Financial processing | One serialized path; owned exits run ahead of normal scanning; claimed leader sales persist | An already active quote, simulation or unresolved own transaction cannot be skipped safely |
| Copy fetch cadence | At most one event-driven fetch per 750 ms by default; overlapping coverage and up to 4 seconds initial retry | Dense activity, pagination and the 60-second signal age limit can lead to skipped entries |
| Metadata | Holdings + shortlist + SOL/USDC in one bounded batch; default one-second refresh target | General API bandwidth shared with quote and discovery requests |
| Entry | Fresh size/price/security check plus executable buy and reverse-liquidity quotes | These are separate requests; free bandwidth and RPC/simulation can exceed a second |
| Execution | Dedicated submission bucket, one POST attempt and persisted intent | Landing/confirmation/finality; no replay after ambiguous submission |
| Exit | Cached prices trigger urgent consideration; current executable route required before a sale | Cached metadata alone is never treated as sale proceeds |

Helius documents processed delivery around 400 ms, confirmed around 2–3 seconds and finalized around 15–30 seconds. Those are provider estimates, not measurements of this bot. Finalized source verification alone can exceed the desired one-second total. Reference: https://www.helius.dev/docs/rpc/websocket

Jupiter's free general API limit is one request per second. An entry checks two directions, so an end-to-end sub-second purchase cannot be promised with this plan. Exit requests can overtake **queued** discovery; they cannot remove a request already being serviced. Submission uses its separate bucket, as documented by Jupiter, instead of waiting behind the general read queue. References: https://developers.jup.ag/pricing and https://developers.jup.ag/changelog/developer-platform

## Why 200 candidates is feasible but 200 executable quotes per second is not

Broad discovery combines up to five bounded category lists and deduplicates them. It targets 200 unique candidates every minute, with a configurable maximum of 500. Shared membership can produce fewer than the target. A watchlist overrides category discovery and can contain up to 500 mints.

Known token metadata is requested in batches of at most 100 addresses. A smaller eligible shortlist is refreshed more frequently; only an actual entry attempt or route check needs its own trade quote. The default shortlist is 30; it can be increased through 100, with holdings/references also taking space in the one-request refresh batch. A larger number does not create more provider bandwidth or a better signal. Reference: https://developers.jup.ag/docs/tokens/token-information

Routine screening reuses a fresh streamed processed slot to avoid an RPC read every fast scan. That slot is only an age-screen aid: actual entry validation obtains a confirmed RPC slot. If the stream is absent/stale, screening falls back to an RPC read. Normal-only/polling configurations can therefore consume substantially more credits.

## Checks to run

```bat
npm.cmd run feed-check
npm.cmd run latency
npm.cmd run benchmark
npm.cmd run status
```

- `feed-check`: read-only standard subscription handshake and cleanup.
- `latency`: your network's RPC, metadata and USDC/SOL buy/reverse quote timings, including API waits. It does not sign, broadcast, measure confirmation or measure this leader's indexing delay.
- `benchmark`: 30 offline synthetic notifications through the actual SOL paper engine and disk accounting. Providers are mocked; every iteration checks a buy and proportional exit. It never uses keys or real money.
- `status`: samples for paper entry/exit handling, validated copy handling and optional live preparation, with p50/p95, maximum and target-hit proportion. They have different start/end points. The latest copy sample can include time since a wake hint; no field proves internet-to-finality time.

Final controlled run on Linux/Node 24.19.0: 30/30 entries under the 1,000 ms local target; p50 **1.77 ms**, p95 **2.16 ms**, maximum **5.62 ms**. This excludes real network/confirmation/indexing, and does not establish strategy returns. A separate running-loop test verifies immediate waking and a closely spaced hint being handled at its 750 ms cooldown deadline, before an additional one-second scheduler wait.

## Quotas and laptop operation

Standard subscriptions are used; enhanced paid `transactionSubscribe` is not required. Stream bytes and connections are bounded, with an estimated daily credit guard. History pages have a separate conservative reservation guard and persist claims/cursors. Retry reservations, source-slot calls, SDK reads, other applications and provider billing details mean these are not a complete monthly quota model. Check the provider dashboard and keep billing/auto-overage disabled if you want to remain on a free tier. The program does not change account billing settings. Reference: https://www.helius.dev/docs/billing/credits

A stream gap blocks new copy entries. A gap beyond five seconds requests closing existing copied tokens through the normal exit path. Fallback history/reconnect reconciliation can recover missed supported sales, but it cannot guarantee a timely route or replay buys that are already too old. Usage limits can also disable copying for the day.

The laptop must stay awake with stable internet. The GPU is unused. Source account subscriptions and small JSON requests dominate this workload, rather than compute power. Routine fast-token snapshots/rejection logs are suppressed; shortlist console summaries are sampled, and redundant scan-state writes are reduced. Financial fills, pending intents, copy claims and queued exits still persist immediately. Old event logs remain available; archive them privately rather than deleting trade accounting.

The supplied safeguards exclude very young launches and Token-2022. Faster handling does not convert this strategy into first-second launch sniping or establish an edge over specialist infrastructure.
