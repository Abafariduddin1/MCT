# FomoBot — Step 5: Cloud IPA Build, Sideloading, and iPhone Setup

Step 5 completes the five-step build plan by packaging the untouched Step 4 SwiftUI application (`FomoBotApp`, `FomoBotCore`, and `FomoBotUI`) into `FomoBot.ipa` using GitHub Actions and installing it onto your iPhone.

**Important safety rule:** Never upload your `.env`, `wallet.vault.json`, wallet keys, or `APP_ACCESS_TOKEN` to GitHub. The cloud build only compiles the Swift interface; you enter your connection URL and access token directly on your iPhone after installing the app.

---

## 1. Verify your local folder before uploading to GitHub

1. Open File Explorer and navigate to your extracted **`source\fomo-bot`** folder.
2. Confirm these files exist:
   - `project.yml` (in `source\fomo-bot\project.yml`)
   - `.github\workflows\build-ipa.yml` (in `source\fomo-bot\.github\workflows\build-ipa.yml`)
   - `ios\Package.swift` and `ios\App\FomoBotApp.swift`
   - `backend\package.json`
3. Make sure your private `backend\.env` and `backend\state` stay only on your laptop. The `.gitignore` file automatically blocks `.env`, `state/`, `data*/`, and `*.vault.json` when using Git, and the GitHub workflow also checks and refuses the build if any secret file is present.

---

## 2. Build `FomoBot.ipa` on GitHub Actions

1. Create a new repository on [GitHub](https://github.com/new).
   - **Note on runner minutes:** GitHub provides standard hosted macOS runner builds for free on public repositories, whereas private repositories draw from your account's included monthly Actions minutes. Because no secrets or keys are in `source/fomo-bot`, the code itself contains no credentials.
2. Upload or push the contents of `source/fomo-bot` so that `.github/workflows/build-ipa.yml` and `project.yml` sit at the root of the repository:

```bat
cd path\to\source\fomo-bot
git init
git branch -M main
git add .
git status
```

Check the `git status` list to verify that `.env` and `state/` are **not** listed, then commit and push:

```bat
git commit -m "FomoBot Step 5 IPA build pipeline"
git remote add origin [https://github.com/YOUR_USERNAME/YOUR_REPO.git](https://github.com/YOUR_USERNAME/YOUR_REPO.git)
git push -u origin main
```

3. On GitHub, click the **Actions** tab at the top of your repository.
4. Click **Build FomoBot IPA** on the left sidebar. If it has not started automatically, click **Run workflow → Run workflow**.
5. Wait roughly 2–4 minutes for **Build Unsigned Release IPA (macOS)** to turn green.
6. Scroll to the **Artifacts** section at the bottom of the completed workflow run and click **`FomoBot-IPA`** to download `FomoBot-IPA.zip`.
7. Extract `FomoBot-IPA.zip` on your computer or iPhone. Inside you will find:
   - `FomoBot.ipa`
   - `SHA256SUMS.txt`
   - `build-logs/` (containing `toolchain.txt`, `apple-syntax.log`, `apple-types.log`, `swift-tests.log`, and `xcodebuild.log`)

---

## 3. Sign and install `FomoBot.ipa` on your iPhone 15

The artifact produced by GitHub Actions has an ad-hoc linker signature with no Apple provisioning profile. An iPhone requires `FomoBot.ipa` to be re-signed with a certificate/provisioning profile associated with your device UDID or Apple ID before iOS will launch it.

Choose **one** of the following routes:

### Option A: Signulous (On-Device, No PC Refresh Needed)
1. Open [Signulous](https://www.signulous.com/) in Safari on your iPhone (requires an active device registration for your iPhone UDID).
2. Tap **Upload App** and select `FomoBot.ipa` from your iPhone's **Files** app.
3. Tap **Sign App**, wait for signing to finish, and tap **Install App**.

### Option B: Sideloadly (Windows Laptop + USB/Wi-Fi)
1. Connect your iPhone 15 to your Windows laptop via USB and open **Sideloadly**.
2. Drag `FomoBot.ipa` into the IPA slot in Sideloadly.
3. Enter your Apple ID and click **Start**.
4. Once installed, on your iPhone open **Settings → General → VPN & Device Management**, select your Apple ID under Developer App, and tap **Trust**.
5. Enable **Developer Mode** if prompted under **Settings → Privacy & Security → Developer Mode**.

### Option C: SideStore (On-Device Refresh via WireGuard/Local VPN)
1. Save `FomoBot.ipa` to the **Files** app on your iPhone.
2. Turn on your SideStore loopback VPN, open **SideStore**, go to **My Apps**, tap **+**, and select `FomoBot.ipa`.

---

## 4. Connect your iPhone to the Windows laptop backend

1. On your Windows laptop, open Command Prompt inside `source\fomo-bot\backend`.
2. Ensure `.env` stays in **paper mode** (`MODE=paper`, `ENABLE_LIVE_TRADING=false`) and has your generated `APP_ACCESS_TOKEN` (from `npm.cmd run token:create`).
3. **Important networking rule:**
   - `127.0.0.1` on an iPhone refers to the iPhone itself, **not** your Windows laptop.
   - To connect from your iPhone, expose the laptop controller over a trusted HTTPS/WSS endpoint (for example, Tailscale HTTPS `tailscale serve --https=8787 http://127.0.0.1:8787` between your laptop and iPhone, or a local TLS certificate configured via `APP_TLS_CERT` and `APP_TLS_KEY` on a non-loopback `APP_HOST` trusted by your iPhone).
4. Start the backend on your laptop:

```bat
npm.cmd start
```

5. Open **FomoBot** on your iPhone:
   - Enter your `https://...` controller URL and your `APP_ACCESS_TOKEN`.
   - Tap **Connect**. The token is stored in your iPhone's Keychain, and the app waits for both the authoritative portfolio snapshot and feed snapshot before displaying **Ready**.
