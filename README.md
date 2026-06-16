# TimeAgent

A lightweight cross-platform (**macOS / Linux / Windows**) menu-bar / tray app that
logs your meeting and task time to **TargetProcess** — automatically when you're in
a call, or manually with one click. It lives in the tray, detects meetings via your
microphone (no Zoom/Teams plugin needed), and keeps a running today / week / month
total always a click away.

---

## Features

### Time logging
- **Task & bug list** — browse the Tasks and Bugs assigned to you, filtered by
  sprint (current sprint by default; switch to a specific sprint or all), state,
  or free-text search.
- **One-click timers** — start/stop a timer on any item; the elapsed time is logged
  to TargetProcess on stop.
- **Direct / backdated logging** — type hours + a date + an optional note and log
  it to any item, on any day.
- **Edit & delete logged time** — click a task's total to expand every time entry
  (date, hours, description) with inline edit and delete, plus the running total.

### Meeting detection
- **Automatic, app-agnostic** — detects when you're in a meeting by watching for an
  active **microphone capture** (works for Zoom, Teams, Meet, Webex, …), with a
  Zoom/Teams process-name fallback. No per-app plugin.
- **End-of-meeting prompt** — when a call ends you choose how to log it:
  - **Daily** — straight to your daily-meeting task.
  - **Defined list** — pick from your own configured meeting shortcuts.
  - **Search** — search your active tasks by name or `#id` and log to the one you pick.
  - **Cancel** / **Skip** — discard the meeting (nothing is logged).
- **Split meeting** — log the current segment and immediately start a new one without
  leaving the call (e.g. switching Zoom breakout rooms). Reachable from the popover
  and the tray menu while a meeting is active.

### Status & workflow
- **Change task / bug status** — flip an item's workflow state from the list, behind
  a confirmation dialog.

### Quality-of-life
- **Recurring entries** — auto-log fixed daily items (e.g. dailies, code review).
- **Days off & holidays** — weekly off-days, custom days off, and a Morocco holiday
  set (civil + editable religious dates) so auto-logging skips them.
- **Signed-in user** — shows your avatar (Gravatar) and name in Settings and the popover.
- **Totals** — today / week / month at a glance, with month navigation.
- **Auto-update** — installed app updates itself from GitHub Releases (macOS notifies
  + downloads the installer, since unsigned apps can't self-install).

---

## Install

Download the latest installer for your platform from
[**Releases**](https://github.com/hatimox/TimeAgent/releases/latest):

| Platform | File |
|----------|------|
| macOS    | `.dmg` (Apple Silicon & Intel) |
| Windows  | `.exe` installer |
| Linux    | `.AppImage` / `.deb` |

> **macOS** is unsigned — on first launch, right-click the app → **Open**, or allow
> it in **System Settings → Privacy & Security**. Microphone access must be granted
> for meeting detection.
>
> **Linux (GNOME)** needs the *AppIndicator and KStatusNotifierItem* shell extension
> for the tray icon to appear.

---

## Configure

On first launch the **Settings** window opens. Enter your TargetProcess **instance URL**
and **API token** (TP → *My Profile → Access Tokens*). Your user is detected
automatically.

> 🔐 The token is stored in the OS secret store (macOS **Keychain**, Linux
> **libsecret**, Windows **Credential Vault**) — never in plaintext. Always change it
> through Settings; editing the fallback file won't take effect while the keychain
> entry exists.

In Settings you can also configure: the daily / meetings task ids, meeting rounding
(minimum + step minutes), extra meeting process names (e.g. Teams), defined-meeting
shortcuts, recurring entries, timezone, and your days off / holidays.

---

## Develop

```bash
npm install
npm start        # or ./run.sh if ELECTRON_RUN_AS_NODE is set in your shell
```

### Project layout

```
src/
  main.js              Electron main process — tray, windows, IPC, auto-update
  tpclient.js          TargetProcess REST client (items, times, states, logging)
  zoomwatcher.js       Meeting detection + end-of-meeting logging flow
  settings.js          Settings store (JSON + .bak) and the keychain token
  holidays.js          Morocco civil + religious holiday data
  preload.js           Bridge for the main window
  promptPreload.js     Bridge for the meeting prompt window
  dynamicPickerPreload.js  Bridge for the defined-meeting picker
  renderer/            UI: main list, popover, settings, prompt, picker
```

Built with **Electron** + **electron-builder**, **electron-updater** (auto-update),
and **keytar** (secret store).

---

## Build & release

Push a version tag (e.g. `v0.0.15`) and GitHub Actions builds installers for all three
platforms and publishes them to **GitHub Releases** — the app then auto-updates from
there. The version is derived from the tag, so don't hand-edit `package.json`.
See [BUILD.md](BUILD.md) for the full flow.

```bash
npm run dist          # build for the current platform
npm run dist:mac      # or :win / :linux
```

---

## License

MIT © Hatim Haffane
