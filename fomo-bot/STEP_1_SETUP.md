# FomoBot — Step 1 setup on Windows

This is the restarted first step of your five-step app prompt, backend version **0.2.0**. You can install and check this backend now. The iPhone app and its controls are added in later steps. **The commands in this guide do not buy or sell anything.**

Keep your current `solana-budget-bot` folder. Extract this project into a separate folder so the existing settings and trading records stay available for the later integration.

## 1. Extract the download

1. Download `FomoBot.zip`.
2. In File Explorer, right-click it and select **Extract All**.
3. Open the extracted `fomo-bot` folder, then open its **backend** folder.
4. You should see `package.json`, `package-lock.json`, `tsconfig.json`, `src`, `test`, `scripts` and `core`.

Windows might put another `FomoBot` folder around `fomo-bot`. That is fine. The folder containing `package.json` is the one you need.

## 2. Open a terminal in that exact folder

1. While you are inside **backend** in File Explorer, click the address bar at the top.
2. Type `cmd` and press **Enter**.
3. A Command Prompt opens with this folder as its working directory.
4. Enter this command:

```bat
dir package.json
```

It should list `package.json`. If it says **File Not Found**, close that terminal and repeat the steps from the folder that actually contains that file.

These instructions use `npm.cmd`, which also works in PowerShell without changing its script-execution policy. An administrator terminal is unnecessary.

## 3. Check Node

```bat
node --version
```

Your `v24.21.0` is suitable. The backend requires Node 24 or newer.

## 4. Install the pinned dependencies

```bat
npm.cmd ci --ignore-scripts
```

Wait for it to finish. Funding notices are informational. If there is an error, copy the text, including its error code. There is no need to purchase an API plan or fund a wallet for these installation checks.

## 5. Compile and check the code

Run each command separately and wait for the prompt to return:

```bat
npm.cmd run build
```

```bat
npm.cmd run check
```

Both should complete without TypeScript errors. Compilation creates a `dist` folder automatically. Do not run the `.ts` source files directly.

## 6. Run the tests

```bat
npm.cmd test
```

This compiles the project, runs **49 backend tests**, then runs the **95 existing bot tests**. Expect two result summaries, each with **fail 0**. Test logs include simulated buys and sells; those tests use temporary state, virtual funds or mocked providers and submit no real transactions.

If the summaries say 49 passed and 95 passed, Step 1's local setup is complete. You can stop here until Step 2 is ready.

## 7. Optional: prepare a separate paper settings file

Only do this if you want to check the read-only connections or feed before Step 2.

Check for an existing settings file first:

```bat
dir .env
```

If it says **File Not Found**, create one:

```bat
copy .env.example .env
```

If `.env` already exists, leave it in place. Do not overwrite your keys.

Open the settings:

```bat
notepad .env
```

Set these two lines using your existing service keys, locally on your own computer:

```dotenv
JUPITER_API_KEY=your_existing_jupiter_api_key
RPC_HTTP_URL=https://mainnet.helius-rpc.com/?api-key=your_existing_helius_api_key
```

Keep these lines as supplied:

```dotenv
MODE=paper
ENABLE_LIVE_TRADING=false
PAPER_BASE=SOL
PAPER_BALANCE_EUR=200
ALLOW_METERED_PUMP_DATA=false
LIVE_BASE=SOL
MAX_BUY_SOL=0.1
EXECUTION_TRANSPORT=jito
WALLET_ENCRYPTION_KEY=
APP_HOST=127.0.0.1
```

Keep `PUMPPORTAL_API_KEY` and the notification settings blank. Save the file with **Ctrl+S** and close Notepad. Verify its name is `.env`, rather than `.env.txt`; File Explorer's **View → Show → File name extensions** makes this visible.

The old bot's `.env` is a separate file. Do not delete or move its saved state. `BOT_DATA_DIR=./data-v4` in this new folder is an isolated path; the controller's ledger migration will be handled in Step 2. If the old bot is running, press **Ctrl+C** in its terminal before trying the optional new feed. Separate processes using the same provider organisation can compete for its rate limit.

## 8. Optional: check read-only connections

```bat
npm.cmd run doctor
```

The output should include a read-only RPC slot and, if a Jupiter key is set, a verified SOL/USD reference. The live settlement asset should be `SOL`. The PumpPortal probe waits up to ten seconds for a launch or migration event. A quiet stream can report that no event was observed; that is different from a failed connection.

This command deliberately does not unlock a wallet, quote a real order, send a bundle, or test profitable trading. It consumes a small number of provider requests. Its RPC quota counter is a local estimate, while your provider dashboard remains the source for billed usage.

If you see an error, send its text after removing any API key or private URL. Never send a seed phrase, wallet secret, vault unlock key or `.env` file.

## 9. Optional: inspect the feed

```bat
npm.cmd run feed
```

This displays incoming feed updates in the terminal until you press **Ctrl+C**. It does not trade. The iPhone feed replaces this terminal display in the later steps.

Some new tokens have no indexed market cap yet. Some show unknown or failing checks. This is expected: unknown values stay unknown, and the retained age/liquidity rules can reject a token that is visible in the feed.

Leave metered trade subscriptions disabled while completing the app. Daily local quotas survive restarts; deleting quota files to restart counting can cause usage to exceed your intended budget.

## Common fixes

| Message | Action |
|---|---|
| `ENOENT` mentioning `package.json` | Open Command Prompt from the extracted **backend** folder. |
| `npm.ps1 cannot be loaded` / execution-policy error | Use the exact `npm.cmd` commands above. |
| `Cannot find module ... dist/src/cli.js` | Run `npm.cmd run build` first. |
| `Set RPC_HTTP_URL` or HTTP 401/403 | Check the separate `.env` and the service key locally. |
| `Provider returned HTTP 429` | Stop the feed, check your provider usage, and wait for the documented limit to reset. An upgrade is not automatically required. |
| `Daily request budget reached` | Stop the feed and inspect the relevant usage. Local counters reset at the next UTC day; keep the counters intact. |
| `Quota reservation locked` | Stop all copies of this backend. Preserve the state files and report the error; a crash may have left a lock. |

## Wallets, phone access and what comes next

You do not need a trading wallet for this step. The `vault:create` command exists for the later explicit live setup, and requires a separate 64-character encryption key. Do not run it or deposit money as part of the instructions above.

Paper accounting remains in SOL. The restarted execution foundation also implements native SOL buys and sells. It wraps SOL inside the swap transaction and unwraps proceeds back to the same wallet. USDC is used to express the existing spending/loss limits, rather than requiring a USDC holding for this native route.

The native SOL ceiling is 0.1 SOL; the separate all-in ceiling remains 10 USDC equivalents, including a conservative fee/rent allowance. The smaller ceiling applies. An order can also be refused because its estimated round-trip cost is too large. The controller will explain these reasons and show amounts that fit the available budget.

Step 2 connects the strategy/copy logic to native SOL accounting and adds the authenticated controller API, normal/copy allocations and position controls. Steps 3–4 add SwiftUI. Step 5 supplies the IPA build pipeline. There is no phone server to connect to in this Step 1 archive, and no funded mainnet swap has been tested.
