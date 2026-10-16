# Discovery scheduling repair — 4.0.2, 14 October 2026

The first sustained Windows status showed a connected/unblocked copy source but no normal market discovery: `market: null`, zero candidates and an empty shortlist. Copy had not placed a trade, and native SOL was unchanged; the lower EUR estimate reflected market repricing.

Two scheduling faults were reproduced. Ready refresh/copy branches could postpone launching overdue background discovery. Once launched, its lower-priority category queries could be starved by a continuous higher-priority metadata refresh workload.

Version 4.0.2 launches due read-only jobs before ready-result branches return. Urgent quote/critical requests remain first; after two background turns the queue serves its oldest background request, allowing category discovery to progress without exceeding the shared rate interval. Empty shortlist refreshes do not perform a redundant screening RPC or claim a normal scan.

New regression checks exercise overdue launch, queue fairness under repeated metadata requests with an urgent exit, the real engine/Jupiter discovery pipeline reaching 200 candidates and a 30-token shortlist, and the empty-shortlist RPC avoidance. All 95 tests pass; syntax and both paper buy/sell demos pass. The new tests fail against the old implementation before the repair.

The Helius own-transfer filter has also been verified by the user's actual doctor output to require finalized commitment. Defaults and validation now require `COPY_COMMITMENT=finalized`, with `COPY_MAX_AGE_SECONDS=60`; the 1% worse-price gate and all risk/security checks remain. This is slower source availability, not a sub-second leader-following claim. Own live receipts and entry freshness RPC use their separately configured commitments.

`Fix_Trading_Scheduler.cjs` updates an unedited 4.0.1 installation in place, backs up changed code/default-template files, preserves actual `.env` and ledger data, refuses unfamiliar source files before writing, and is idempotent. It checks the default mode run locks and must be applied after stopping the bot. No network access, paid upgrade or dependency reinstall is required.

After repair: tests, start, then status. Expect a populated `market.candidateCount` (up to 200 unique results), `market.shortlist` and discovery diagnostics after the first broad scan, plus continued copy health. Security/signal/cost conditions may still correctly yield no positions. Saved positions, risk limits, quotas and copy claims are retained.
