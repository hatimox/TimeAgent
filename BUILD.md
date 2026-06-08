# Building & updating TimeAgent (macOS + Linux + Windows)

The app uses **electron-builder** to make installers and **electron-updater** to
auto-update from **GitHub Releases**.

## One-time setup

1. Create a GitHub repo (e.g. `omnevo/timeagent`) and push this `TimeAgentElectron`
   folder to it as the repo root.
2. In `package.json` → `build.publish`, replace:
   - `REPLACE_GH_OWNER` → your GitHub user/org (e.g. `omnevo`)
   - `REPLACE_GH_REPO`  → the repo name (e.g. `timeagent`)
3. That's it for free, unsigned distribution. (Code signing/notarization is
   optional — see bottom.)

## Releasing a new version (the whole flow)

1. Bump the version in `package.json` (e.g. `1.0.1`).
2. Commit, then tag and push:
   ```
   git commit -am "v1.0.1"
   git tag v1.0.1
   git push && git push --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) automatically:
   - builds **macOS (.dmg/.zip), Linux (.AppImage/.deb), Windows (.exe)**
   - publishes them to a **GitHub Release** for that tag
4. Users' apps check GitHub Releases on launch and **auto-update** to the new
   version. Nothing else to do.

The version tag MUST match `package.json`'s version (electron-builder checks).

## Building locally (optional, for testing)

- macOS:  `npm run dist:mac`     → `dist/*.dmg`, `dist/*.zip`
- Linux:  `npm run dist:linux`   → `dist/*.AppImage`, `dist/*.deb`
- Windows: build on Windows or via CI (can't reliably build on macOS).

Local builds are unsigned; use `CSC_IDENTITY_AUTO_DISCOVERY=false` on mac to skip
signing during a test build.

## How auto-update works

- `src/main.js` calls `autoUpdater.checkForUpdatesAndNotify()` on launch and every
  6 hours. It only runs in a **packaged** app (no-op in `npm start`).
- It reads the GitHub Releases feed defined by `build.publish`.
- New version → downloaded in the background → installed on next quit/restart.

## Code signing / notarization (optional but recommended)

Unsigned apps trigger OS warnings on first launch:
- **macOS**: "unidentified developer" — needs an Apple Developer ID + notarization
  ($99/yr). Set repo secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; electron-builder notarizes in CI.
- **Windows**: SmartScreen warning — needs a code-signing cert (paid). Optional.
- **Linux**: no signing needed; AppImage just runs.

Without signing, distribution still works — users do a one-time "open anyway"
(mac: right-click → Open). For wide/non-technical rollout, sign mac at least.
