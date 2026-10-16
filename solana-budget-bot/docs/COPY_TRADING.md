# Copy trading in version 4

`STRATEGY=hybrid`, a public `COPY_LEADER` and a positive `COPY_ALLOCATION_PCT` enable the copy allocation. The supplied target is `4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9`. Default split: 50% normal / 30% copy / 20% idle. One portfolio prevents double-counting funds. The target's claimed 400 green days have not been verified.

## Detection and verification

Standard WebSocket subscriptions observe the leader's native account and classic SPL token accounts filtered to that owner. Processed balance changes wake checks; duplicate unchanged balances are ignored. This avoids treating every transaction mentioning a busy address as its trade. Heartbeat, reconnect, bounded bytes/account maps and persisted usage protect the local feed.

A notification is not a trade instruction. Helius `getTransactionsForAddress` queries successful own-token-transfer history with `jsonParsed`, transaction version support through v1, ordered bounded pages and the configured commitment. The own-transfer filter requires finalized commitment on Helius; confirmed and processed settings are refused. Actual leader signer, token ownership/balance deltas and known swap discriminators must match. The follower constructs its own guarded Jupiter order rather than copying transaction bytes.

Supported observations include known Jupiter, PumpSwap, Raydium, Orca and Meteora swaps. Unknown instructions, LP operations, failed trades, non-signing address mentions and complex/uninterpretable bundles are skipped. The follower supports classic SPL tokens and retains the 48-hour age/security gates even if the leader buys a new launch. Supported decoder coverage is not a claim that every transaction from those venues will be followed.

## Freshness and recovery

First start establishes a future **finalized** slot baseline, not historical positions. Account activity wakes a history check without waiting for the 60-second fallback. Default event fetch cooldown is 750 ms. Because a processed hint may precede indexing, bounded retries revisit overlapping slots; persisted signature claims prevent duplicate fills. Slot coverage, partial-page cursors and claims are retained across restarts/reconnects. Dense or malformed histories fail closed rather than silently jumping over uncovered pages.

Copy buys must still satisfy source age (60 seconds), worse-price (1%), follower-size quote, security, reverse route, costs and allocation/global limits. The bot skips buys when a holding already exists, while entry/settlement is unresolved, when the stream is not ready or when source/usage guards block the allocation. A crash after claiming a buy but before execution can miss that buy; replaying it would risk a duplicate order.

The physical paper base is SOL with the supplied settings, so an accepted source swap can lead to a SOL → token paper buy irrespective of whether the leader paid SOL or USDC. Source unit prices are compared in USDC equivalents using references. Optional live execution remains USDC-based.

## Sales and protection

`COPY_EXIT_POLICY=proportional` queues the observed leader sale fraction of its prior token balance against the remaining follower holding. Queued sales combine once, and claims/sales persist together. A sale observed while the follower buy is pending is retained for the eventual holding. A sub-one-USDC residual is closed fully to avoid uneconomic dust. `full` closes the follower holding on any supported observed reduction.

Own stops, take profit, trail, maximum hold and manual flatten can override the leader. A live pending order is reconciled before another order is submitted. Missing routes keep unsold holdings visible, and repeated failures produce a zero risk mark plus a halt.

A broken/incomplete history source blocks copy and requests closing copied holdings; normal trading can continue unless global controls halt it. Stream disconnection blocks new copy entries; a gap over five seconds requests exits. A source gap or exhausted credit guard cannot guarantee closure. `resume-copy` retries after the source is fixed; it does not erase loss halts.

## Acceptance and usage

Run `doctor`, `feed-check` and `leader-check` with your keys locally. Doctor warnings can leave normal trading available while copying remains unavailable. Standard Helius subscriptions are documented for all plans; history still needs the supported account/API method and quotas. No paid account is bought automatically.

Daily counters separately guard estimated history reservations (20,000) and stream usage (2,000). They omit other RPC traffic and are not a complete bill. Busy source activity and index retries can exhaust the history guard early. Monitor your provider dashboard.

The automated tests include controlled notification → SOL paper entry, proportional sale, reconnect, late indexing, overlapping deduplication, pending-buy sales and confirmed/finalized receipt recovery. They do not test your authenticated account, prove this exact leader is compatible, measure real follower returns or reconstruct 400 days of equity.

References: https://www.helius.dev/docs/rpc/websocket, https://www.helius.dev/docs/rpc/gettransactionsforaddress, https://solana.com/docs/rpc/websocket/programsubscribe and https://www.helius.dev/docs/billing/credits.
