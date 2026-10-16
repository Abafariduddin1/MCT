# Version 4.0.2 — beginner Windows setup

Start in paper mode. The included settings use €200 of **virtual SOL**. You do not need to buy crypto, fund a wallet, purchase a computer or pay for an API plan to run the software checks. The app comes after this version is working on your laptop.

## 1. Stop and preserve your old bot

In the old bot's Command Prompt, press **Ctrl+C** once. Wait for its stopped message. Make a private backup of that whole old folder, including its settings and data. Keep the old installation in its own folder.

Version 4 has a new ledger format. Do not copy old `data`, `data-v3` or `state.json` into version 4, and do not delete them. This update starts a separate paper portfolio. If any older installation ever held real funds/positions or an unresolved trade, reconcile that wallet and its original ledger before using it with new software; a new data folder cannot repair funded accounting.

## 2. Extract into a new folder and open Command Prompt

1. Download the new ZIP.
2. Right-click it and select **Extract All**.
3. Choose a new location, for example a folder named `Bot_v4` on your Desktop. Click **Extract**.
4. Open the extracted `solana-budget-bot` folder. You should see `package.json`, `README.md`, `src`, `test` and `docs`.
5. Click File Explorer's **address bar** at the top, where the folder location is shown. This is different from the search box.
6. Type `cmd` and press **Enter**. A Command Prompt opens in that folder.

Use the commands below exactly, including `.cmd`. You do not need an administrator window or a PowerShell execution-policy change.

Run these **one at a time**, pressing Enter after each and waiting for it to finish:

```bat
npm.cmd ci --ignore-scripts
```

Then:

```bat
npm.cmd test
```

Expect **95 passed, 0 failed**. Then:

```bat
npm.cmd run check
```

Expect the syntax checks to pass. Then:

```bat
npm.cmd run demo
```

Expect `SOL BUY CHECK PASSED`, `SOL SELL CHECK PASSED`, `USDC BUY CHECK PASSED` and `USDC SELL CHECK PASSED`. These are made-up markets and fake balances that check buying, selling, fees and accounting. Their gains are not a forecast.

Your previously reported Node v24.21.0 is sufficient. If any check fails, stop at that command and keep the exact error text.

## 3. Make the new settings file

In the **new** project folder:

```bat
copy .env.example .env
```

If it asks whether to overwrite an existing `.env`, choose **N**. Preserve that settings file before changing it. Then open the settings:

```bat
notepad .env
```

Open your old settings locally as well. Copy only your existing **Jupiter API key** and **whole Helius HTTPS mainnet RPC URL** into these two lines in the new settings:

```ini
JUPITER_API_KEY=YOUR_ACTUAL_KEY
RPC_HTTP_URL=YOUR_WHOLE_HELIUS_MAINNET_HTTPS_URL
```

Replace the text after `=` locally, on one line without quotes. Leave `RPC_WS_URL=` blank: the program derives the WSS address from your HTTPS address. A different provider/custom WSS address can be supplied manually, but copy history requires the supported Helius method.

Keep these supplied values:

```ini
MODE=paper
ENABLE_LIVE_TRADING=false
PAPER_BASE=SOL
PAPER_BALANCE_EUR=200
PAPER_INITIAL_SOL=0
EUR_USD_REFERENCE=0
DATA_DIR=./data-v4
STRATEGY=hybrid
NORMAL_ALLOCATION_PCT=50
COPY_ALLOCATION_PCT=30
MONITOR_SECONDS=1
SHORTLIST_SECONDS=1
SHORTLIST_SIZE=30
MAX_CANDIDATES=200
COPY_STREAM_ENABLED=true
COPY_COMMITMENT=finalized
COPY_MAX_AGE_SECONDS=60
LIVE_ACK=
```

`EUR_USD_REFERENCE=0` uses the ECB daily USD-per-EUR reference. At first start the bot combines that with indicative SOL/USDC prices to create a virtual SOL balance worth about €200. If you instead set a positive `PAPER_INITIAL_SOL`, that exact SOL amount becomes your initial balance; it overrides the EUR starting amount. Once a ledger exists, changing a starting-balance setting does not reset its capital.

The initial split is approximately €100 normal, €60 copy and €40 idle, represented as SOL allocations in one virtual wallet. Risk settings named `USDC` still mean USDC equivalents: `MAX_POSITION_USDC=10` is not 10 SOL. Idle SOL can rise or fall in EUR; the idle allocation is not a stable-value savings balance.

The example already contains your public copy target `4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9`. Its 400-day claim remains unverified. You never need its private key.

Press **Ctrl+S** to save, then close Notepad. Do not share your filled `.env`, wallet key or credential URLs.

## 4. Check the real connections without spending money

Run one command at a time:

```bat
npm.cmd run doctor
```

Look for RPC/Jupiter connectivity, a EUR/USD reference, responding filtered history and responding standard copy WebSocket subscriptions. Doctor can finish while printing a copy warning: that means copy is **not ready** even if the normal connection check passed. Keep paper mode and fix the reported source issue.

Then:

```bat
npm.cmd run feed-check
```

Expect `ready: true`. This opens read-only subscriptions, verifies acknowledgements and closes them. It does not buy anything or prove real fill speed.

Then:

```bat
npm.cmd run latency
```

This reports your laptop's RPC, metadata and two quote times, including rate-limit waits. It uses a USDC/SOL reference pair even when your paper trading base is SOL; it does not change your balance or submit a trade. A result longer than a second is expected to be possible with free APIs.

Then:

```bat
npm.cmd run diagnose
npm.cmd run leader-check
```

Diagnose reports candidates passing security checks and reasons for rejection. Leader-check samples supported successful signed swaps of the target wallet. Zero supported swaps can mean there was no compatible activity in that small sample; it is not a 400-day performance audit.

For an error, copy the error text with keys/credential URLs removed. Do not upload settings. If the old `HTTP 400` returns, keep the detailed message: version 4 sends the required minimum `JITO_TIP_LAMPORTS=1000` and reports validation details. An error with another field needs its own diagnosis.

## 5. Start the SOL paper bot

```bat
npm.cmd start
```

Leave this window open, keep internet connected and prevent the laptop from sleeping. The display may turn off; the GPU is not needed.

What should happen:

- Broad discovery targets up to 200 unique candidates roughly each minute. Duplicated lists or provider limits can yield fewer. It does not make 200 individual quote requests.
- Up to 30 eligible shortlisted tokens, open holdings and base references are refreshed in a batch on a one-second target. Active quote requests/queue waits can stretch this cadence. Routine shortlist console summaries are reduced to about every 15 seconds so the terminal is readable.
- Normal momentum needs at least three minutes of advancing observations; breakout/pullback needs about ten. This warmup measures a market pattern. Faster code does not create that history instantly.
- Account changes wake copy reconciliation early. Source trades are finalized/decoded before copying, and quotes/cost/security checks still apply. Index lag can require short bounded retries. Fallback reconciliation runs about every 60 seconds, plus request time.
- An accepted normal or copy signal automatically creates a costed paper position. The bot can also sell it, follow proportional leader sales and apply its own protective exits. SOL is spent/received virtually; no real wallet is used.

The defaults exclude new launches under 48 hours, Token-2022, unsafe/incomplete audits and uneconomic routes. Those checks can leave the portfolio empty. Do not remove them just to make the bot buy. A one-second processing target is not a guarantee of a one-second mainnet purchase; see `docs/PERFORMANCE.md`.

## 6. View status and control it

Open another Command Prompt in the same project folder using File Explorer's address bar. Run:

```bat
npm.cmd run status
```

This gives a snapshot; run it again to refresh. Look for `cashSol`, `estimatedEquitySol`, `estimatedEquityEur`, `openPositions`, allocations, `health.stream`, `copyHealth`, diagnostics and latency. A null win rate means there are no completed positions yet. Overall SOL price gains and realized trading profit are reported separately.

Useful controls:

```bat
npm.cmd run pause
npm.cmd run resume
npm.cmd run resume-copy
npm.cmd run flatten
npm.cmd run export
```

Pause prevents new entries while exits continue. Resume cannot clear loss halts. Resume-copy retries the copy source after its issue is fixed. Flatten pauses and requests closing token holdings; **keep the main bot running** until status confirms closure. An unavailable route may leave a holding open. SOL paper flatten returns tokens to SOL, not to EUR/USDC. Export writes `trades.csv` in the active mode's data folder; it is a performance ledger, not a tax-ready return.

Press Ctrl+C in the main window to stop and save. It does not sell holdings and protective monitoring stops. Background reads are cancelled; an already active trade/reconciliation can still need time to finish safely. Restarting reads the saved ledger and reconciles unresolved outcomes before another order.

To change the split, first flatten and verify the portfolio is empty, then stop. For 60% normal / 20% copy / 20% reserve:

```bat
npm.cmd run allocate -- 60 20
```

Set `NORMAL_ALLOCATION_PCT=60` and `COPY_ALLOCATION_PCT=20` in `.env` before restarting. This changes allocation accounting while preserving global loss history and existing halts. Changing percentages in settings alone is refused for an existing ledger.

After a crash, a stale `run.lock` may block restarting. Restart Windows so the old process is definitely stopped, and back up the active data folder. Delete **only** `data-v4\paper\run.lock` for paper or `data-v4\live\run.lock` for live. Do not delete `state.json`, positions or pending transactions to bypass a mismatch.

Keep an eye on Helius's usage dashboard. Stream/history counters are estimates for those features, not total account billing. Other RPC requests and applications also use the same quota. The bot does not purchase a paid plan or extra credits.

## 7. Live operation is a separate later choice

The supplied configuration is paper. Live code can buy/sell **using Solana USDC plus native SOL for gas**, after explicit local activation. Native-SOL live trading has not been implemented or tested by the new SOL paper setting. No funded mainnet buy/sale or authenticated copy integration was performed during development.

A later technical trial requires a dedicated locally generated wallet (`npm.cmd run wallet`), its private `wallet.json`, genuine Solana USDC and enough native SOL for fees/rent while retaining the minimum reserve. Do not put your main wallet or the whole €200 in this unaccepted trial.

An optional no-broadcast preflight is:

```bat
npm.cmd run preflight -- EXACT_CLASSIC_TOKEN_MINT 1
```

It uses the dedicated local key to sign/simulate a one-USDC order, but never broadcasts. Unknown route layouts, missing balances, unsafe mints and excessive costs fail validation.

Actual opt-in requires `MODE=live`, `ENABLE_LIVE_TRADING=true`, `LIVE_ACK=I_ACCEPT_REAL_TRADES` and the correct `WALLET_FILE`. Paper/live ledgers remain separate. The example chooses confirmed settlement followed by persistent finality verification; `LIVE_SETTLEMENT_COMMITMENT=finalized` waits for finality before booking. Any unresolved transaction blocks replacement orders. Verify actual buy/sale signatures and wallet changes yourself before unattended operation.

For now, complete steps 1–6 in paper mode and retain the checks/status output. Those records will give the next dashboard meaningful data to display.


## Existing 4.0.1 installation

Stop the bot with Ctrl+C and wait for its stopped message. Save `Fix_Trading_Scheduler.cjs` alongside `package.json`, run `node Fix_Trading_Scheduler.cjs`, then `npm.cmd test` (95 passed expected), `npm.cmd start`, and status from a second terminal after about a minute. Keep your current finalized/60-second copy settings. The repair preserves your actual settings and saved portfolio; do not delete your ledger or reinstall dependencies.
