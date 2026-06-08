# TimeAgent

Cross-platform (macOS / Linux / Windows) tray app that logs your meeting and task
time to **TargetProcess** — with manual timers, direct/backdated logging, Zoom
meeting detection, and today/week/month totals.

## Develop

```bash
npm install
npm start        # or ./run.sh if ELECTRON_RUN_AS_NODE is set in your shell
```

## Configure

On first launch, the Settings window opens. Enter your TargetProcess **URL** and
**API token** (TP → My Profile → Access Tokens). Your user is detected
automatically. The token is stored in the OS secret store (Keychain / libsecret /
Credential Vault), never in plaintext.

## Build & release

Push a version tag (e.g. `v1.0.1`) and GitHub Actions builds installers for all
three platforms and publishes them to GitHub Releases; the app auto-updates from
there. See [BUILD.md](BUILD.md) for the full flow.
