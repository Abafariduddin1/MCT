# Step 2 verification — backend 0.3.0

Verified on 16 October 2026 with Node 24.19.0 in the Linux build workspace.

| Check | Result |
| --- | --- |
| Strict TypeScript compilation/type check | Passed |
| Backend tests, including 49 retained foundation tests | 86 passed, 0 failed |
| Unchanged 4.0.2 core regression tests | 95 passed, 0 failed |
| Actual native validator + controller + RPC transport integration | Passed against controlled RPC fixtures |
| HTTP/WebSocket authentication and command integration | Passed on loopback sockets |

There are 181 distinct backend/core tests in this run. The 95 core tests are the retained standalone tests, not another independent set of 95 trading strategies.

Run from `backend`:

```bat
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
```

The current logs are included at the outer handoff's `evidence/step2-typecheck.txt` and `evidence/step2-tests.txt`. The prior Step 1 verification is preserved in `STEP_1_VERIFICATION.md`. No new dependency audit is claimed; dependency versions remain pinned to the supplied foundation.

## Added coverage

- Exact cash, allocation and cost-basis conservation through entry, partial/full exits and fee-only failures.
- A stricter funding/carrying-cost invariant and refusal of malformed/corrupt state.
- All-in limits, protected reserve, single unresolved intent and rejection of overlapping trades/reallocation.
- Manual trades subject to stale/failed/incomplete evidence and the existing entry policy.
- New launches blocked under all profiles; profile labels cannot change mint/age/capital gates.
- Durable command replay protection, payload mismatch rejection and lookup after reconnect.
- Persist-before-send, unknown outcome recovery, no automatic resend and exactly-once receipt booking.
- Confirmed/finalized matching, failed transaction fees and halt on finality disagreement.
- A real guarded native SDK transaction connected to the operational controller gate, file ledger, RPC executor and receipt validator. Signing and two simulations use an unfunded generated test key and controlled RPC responses; nothing is broadcast to a real service.
- Panic during preparation, visible holdings after failed sell routes, protection with auto-pilot off and persisted partial take profit.
- SOL reference movement separated from native realized trading results.
- Reallocation preserving existing drawdown/halts.
- Future-only copy baseline, overlap claims, stale buys, later sales and queued leader sales during unresolved follower buys.
- Finalized history filters and its connection to the shared RPC meter.
- HTTP/WebSocket authentication, rejected URL credentials/origins, invalid and oversized messages, persisted ACK/status and remote TLS configuration requirements.
- Slow mark refresh remaining outside the protection scheduler; shared queue exit priority and discovery fairness.
- Notification failure isolated from trade state and missing provider setup rejected before wallet access.

## Acceptance still needed

No funded trade, real Jupiter/Jito/RPC fill, Windows run, phone connection, Telegram delivery, remote certificate/tunnel test, measured end-to-end mainnet latency or strategy return was established. This is not a production security audit.

The source includes guarded live execution, but the delivered settings remain paper. The native app and IPA remain Steps 3–5. Provider schemas and current signing/toolchain support must be checked when those integrations are exercised.
