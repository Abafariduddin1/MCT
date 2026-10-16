# Copy-history repair — 4.0.1, 14 October 2026

The first authenticated Windows doctor check found Helius error -32602: `tokenTransfer amount filter requires mint`. The previous global amount-greater-than-zero predicate was invalid because copying discovers swaps across unknown mints.

The request now retains `tokenTransfer: {direction: "any"}`, successful status, changed owned token-account coverage, slot bounds, chronological pagination and parsed v1 support. Only the incompatible amount predicate is removed. The local decoder still requires the leader signature, owned token balances, known swap instruction and nonzero opposing token/base deltas. No mint-specific filter is added, since that would omit swaps of other assets.

The existing history contract test now reproduces the reported API rejection with the old request and accepts the corrected one, then decodes the returned supported swap. The full 91-test suite and syntax checks passed after the repair. These checks do not use user credentials; rerun doctor locally to verify the real provider response.

`Fix_Copy_History.cjs` repairs the original 4.0.0 install from its project folder. It validates all four original/repaired source/test/package file hashes before writing, backs up changed files, and refuses unfamiliar files. It performs no network request and does not access settings, keys, wallet files or trading state. Repeat execution is safe. A partially applied repair can be rerun. No dependency reinstall or ledger reset is required.

Source: https://www.helius.dev/docs/rpc/gettransactionsforaddress. The reported runtime error establishes the mint requirement; the documentation describes the direction/amount filters and own-transfer semantics.
