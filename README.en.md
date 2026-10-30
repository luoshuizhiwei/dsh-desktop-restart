# Restart Desktop App (dsh-desktop-restart)

Adds a **Restart** button to the **DeepSeek Harness desktop app** — no more quitting and reopening by hand.

English | **[简体中文](README.md)**

---

## What problem it solves

The desktop app has no restart entry. To restart it you have to either:

- close the window and open it again (easy to leave background processes behind), or
- kill the process in Task Manager (risky)

This plugin turns "restart" into a button in places you already look. More importantly, **it checks whether you are busy first** — while work is running it will not restart straight away, it asks you.

The first launch after installing needs one manual restart (the plugin is not running yet). After that you never touch it again.

---

## Usage

Restart appears in these places, **all enabled by default**:

| Where | How it works |
| --- | --- |
| Top of the left sidebar | Opens the restart panel in the main area; click Restart there |
| Bottom of the left sidebar | Click twice to restart |
| Conversation header | The Restart button on the right of the session title bar |
| Account menu | Open the avatar menu at the bottom left — it is the top item |
| Slash command | Type `/restart-desktop` and press Enter |
| Settings → General | Read-only status row; does not restart |

Turn off any entry you do not want under **Settings → Restart Desktop App**. Changes apply immediately — no app restart needed.

## Screenshots

**Main panel** — status, restart, refresh, wait-until-idle

![Main panel](https://raw.githubusercontent.com/luoshuizhiwei/dsh-desktop-restart/master/docs/images/panel.png)

**Account menu entry** — open the avatar menu at the bottom left; it is the top item

![Account menu](https://raw.githubusercontent.com/luoshuizhiwei/dsh-desktop-restart/master/docs/images/account-menu.png)

**Sidebar footer entry** — click twice to restart

![Sidebar footer](https://raw.githubusercontent.com/luoshuizhiwei/dsh-desktop-restart/master/docs/images/sidebar-footer.png)

**Settings page** — five entry toggles, countdown, sign-in data health

![Settings](https://raw.githubusercontent.com/luoshuizhiwei/dsh-desktop-restart/master/docs/images/settings-entries.png)

**Conversation header button** — always within reach

![Header button](https://raw.githubusercontent.com/luoshuizhiwei/dsh-desktop-restart/master/docs/images/header-button.png)

---

## How it protects you

When work is running (generating, running tools, queued messages, background jobs), one click does **not** restart:

1. First click: the button turns red, the label becomes "Restart anyway?", and it tells you what would be interrupted
2. Second click: the restart actually happens
3. Or choose "Restart when idle": it waits and restarts once the work finishes

The red warning **expires after 15 seconds** so a stray click later cannot restart the app (configurable 5–60 seconds).

"Restart when idle" waits at most **30 minutes**; on timeout it states clearly that no restart was performed.

**While a plugin is being installed or updated, restart is hard-blocked** — killing the process then would corrupt the dependency tree. Wait for it to finish (usually a minute or two).

---

## After a restart

It reports **how long the app was down** and whether the new instance came up.

To be precise: that receipt proves the new app loaded this plugin. It does not mean all your plugins and background tasks have recovered. **Interrupted work is yours to resume** — this plugin will not restore conversations or tasks, and it does not send messages to sessions.

---

## Bundled extras (each can be turned off)

These three are unrelated to restarting; they ship along with this plugin.

### Sign-in data check

DSH stores a sign-in credential on every launch, and those credentials are never cleaned up. Once enough accumulate, the app can **fail to start** (reported as `Web authentication failed`).

Settings shows the last check: how much is used, the limit (16 KiB), and how many records exist. **By default it only checks during a restart performed by this plugin** (that is when the database is not locked).

> The database is always opened read-only. **It never deletes or modifies your sign-in data.** You can enable "back up on restart" to keep the last 3 copies; when usage is near the limit it tells you how to clean up manually and gives the exact path.

### Leftover temp file preview

DSH leaves change-snapshot copies in the system temp folder while diffing; a crash can leave them behind.

This feature **only scans and previews — it never deletes anything**, because there is no reliable way to tell which copies another instance may still be using. It reports how many candidates exist and roughly how much space they take; deleting them is your call.

### Hide "Feedback" in the account menu

In the account menu, "Feedback" sits directly below "Settings" and opens an external web page — easy to hit by accident.

This toggle hides it (**off by default**). If the item cannot be identified, nothing happens — it would rather leave it than touch the wrong entry.

---

## Install

### From npm (recommended)

```sh
dsh plugin add @luoshuizhiwei/dsh-desktop-restart
```

### From source

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "@luoshuizhiwei/dsh-desktop-restart": "link:../../local-plugins/dsh-desktop-restart"
  },
  "dsh": { "profile": { "bundles": [ "...", "@luoshuizhiwei/dsh-desktop-restart" ] } }
}
```

The app must be **restarted once** after installing — that first one is manual.

---

## FAQ

**Why not use one of the "restart dsh web" plugins?**
The desktop app's process model is completely different from `dsh web` in a terminal; those plugins do not work in the desktop app. See "Why a dedicated desktop restart plugin" below.

**Will a restart lose data?**
A normal shutdown saves sessions. The plugin ends the Electron main process and deliberately lets the host child exit gracefully so session logs are flushed. A reply that is still streaming is interrupted and will not resume automatically.

**The button says "Locked" and does nothing?**
A wait or countdown is in progress. Use "Cancel waiting" next to it.

**The red "Restart anyway?" never goes away?**
It expires after 15 seconds. If it stays, status reading is failing — try "Refresh status".

**The app fails to start after installing the plugin?**
Most likely the sign-in data described above. Fully quit the app, delete `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`, then reopen (the file is recreated; you will need to sign in again).

---

# Technical details

The rest is for readers who want the implementation or want to contribute. Not needed for normal use.

## Why a dedicated desktop restart plugin

The desktop app's process model differs completely from `dsh web` in a terminal:

```
DeepSeek Harness.exe            ← Electron main: window, tray, auto-update
  └── DeepSeek Harness.exe      ← host child (same exe + ELECTRON_RUN_AS_NODE=1)
        └── this plugin          runs dsh-desktop-host, listens on 127.0.0.1
```

Two consequences:

1. **The host exiting is not an app restart.** The main process treats the child exit as a failure and shows the "startup failed" recovery dialog (its default button is "Restart"). It works, but needs a human click every time.
2. **The main process exposes no restart channel.** The full IPC surface is `shutdown` / `quit-inspection` / `update-tasks` (main → host) and `ready` / `fatal` / `shutdown-complete` / `platform-session` (host → main); the renderer-side `DESKTOP_IPC` table has no restart either. The built-in "Restart App and Host" menu item is only added in development builds.

So a one-click restart has to come from a process **outside the host**.

## How the restart is performed

1. The entry sends a same-origin POST to the plugin's own host route.
2. The host checks the install guard, then owns waiting, countdown, pause questions and execution state. Normal requests wait for verified idle; explicit immediate execution still passes install and identity guards.
3. After validation it writes a handoff record, spawns a **detached helper** via `process.execPath` (the desktop app itself) + `ELECTRON_RUN_AS_NODE=1`, and answers 202 immediately. The helper therefore needs neither a system Node nor `dsh` on PATH.
4. The helper waits 1.5 s so the response reaches the browser, then — while the main process is still alive — reads its command line and executable path (the relaunch must preserve original arguments; a fallback kill must identify the process by path).
5. The helper ends the **Electron main process** — deliberately without `/T`: the host child must survive so it can run its own graceful shutdown (`application.shutdown`) after IPC drops and flush session logs. `/T` would kill the host too, which is what actually loses data.
6. The helper waits for the main process to disappear, then for the listening port to be released (probing by *connecting*, not *binding* — a speculative bind would occupy the very port the replacement needs).
7. If the port is slow to release, only processes provably belonging to this instance (parent/child relationship, path and launch identity) are handled. It never widens the scope by image name, and never ends another instance merely for sharing a path; when identity cannot be proven it aborts and records why.
8. The helper relaunches with a clean environment — `ELECTRON_RUN_AS_NODE` must be removed, or the "app" would start in Node mode as a windowless process. If the new instance exits immediately it retries (default 3 attempts), then gives up and asks the user to open it manually.
9. The handoff directory keeps the latest 20 handoff/log sets; completed operation records are pruned to the latest 20 per profile, while pending, unknown and notice-referenced records are protected.

## Guard criteria

"Can restart" is not "should restart". The app's own quit path asks the host what work would be interrupted (`hasDesktopActiveTasks`) and shows a dialog; this plugin ends the main process directly and bypasses that check. So it implements equivalent guards:

| Guard | Criterion | Blocks | Way out |
| --- | --- | --- | --- |
| Work running, or state unknown | `agents` + `jobs` services | sessions, tools, queued messages, background jobs of this instance | normal request waits; new work during countdown pauses with a question; explicit confirmation allows immediate execution |
| Plugin installing/updating | the process recorded in `<profile>/.plugin-manager/run.json` **is alive right now** | built-in plugin manager, plugin market, any `dsh plugin` operation | **hard block**: `?force=1` does not bypass it |

**Task changes are decided by the host**: re-checked every 5 s while waiting, up to once per second during countdown. New work creates a single question id; the question offers "continue waiting / restart now / cancel". Continuing waiting recomputes a full countdown but does not extend the original deadline.

The criterion is **the process being alive**, not "the record file existing": `run.json` survives a hard kill, so blocking on file existence would lock the restart button forever.

## Receipt

The receipt is bound to the current profile, installation instance and the unique id of this restart; the helper passes that id only to the instance it launched, and the new host claims and consumes it once within a short window. A failed schedule invalidates the record.

The receipt distinguishes request time from **host ready time**; it proves the new host loaded the plugin, not that the whole UI, every plugin or background task recovered. `downtimeMs` is presented as handoff duration, not as an exact UI downtime.

## UI standards

The UI uses the **official components**, not look-alikes:

- The top sidebar entry mounts on the official panel slot (`sidebar.panellist`): the plugin registers only `id / order / label` plus an icon component, and the sidebar draws the entire row — so it cannot look non-native.
- The main panel follows the page layout of the same slot's occupant (task board): full main-area height, official background token, 16px/700 title on the same line as the status word.
- The bottom sidebar entry mounts on `sidebar.footer.action` and copies the 42px action-row spec of that slot's other occupants; it becomes a 36×36 circle when the sidebar collapses to a rail.
- The header button copies the real official button in the same slot (`JobListAction` from `ui-jobs`).
- Colour semantics use official tokens: danger red for confirm/warn, secondary warning for waiting/countdown, error colour for failure; no spinner under "reduce motion".
- Official components are declared in `dsh.client.inject` and registered by the loader before this plugin runs; if DSH renames or moves a package and `require` fails, the plugin falls back to its own copy of the **verbatim official values**.

Full comparison (verbatim official CSS and source paths) is in `docs/official-ui-standard.md`.

## Entry toggles and defaults

The five UI entries, the header refresh button and the slash command are **on by default** (the header refresh button defaults to off; the account-menu item still has to pass a structure check). Choices are stored **locally in the browser** (`localStorage`); **defaults** come from the plugin config — set them in the plugin's row in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
config: { panel: false, footer: false, header: false, settingsRow: false, accountMenu: false, command: false, enabled: false }
```

(`command` is the slash command, `enabled` is the master switch, `headerRefresh` controls the header refresh button.)

| Toggle | When off |
| --- | --- |
| Top-left panel entry | The sidebar row disappears (and the main-area panel with it) |
| Bottom sidebar entry | The bottom sidebar row disappears |
| Conversation header button | The header button disappears |
| Header refresh button | The "Refresh" button in the header disappears (off by default) |
| Settings → General row | The read-only status row disappears |
| Account menu entry | The restart item disappears from the account menu |

## Sign-in credential health

Settings shows the last downtime check: estimated usage, the 16 KiB default limit, the number of auth cookies and the check time. It is not live monitoring. Without a sample it shows "no downtime check result yet"; ordinary manual starts and quits do not update it.

"Back up the cookie database on restart" is off by default; "warn at 80%" is on. The database is always opened read-only; the optional consistent backup keeps the last 3 copies and **never deletes any cookie**. Above the limit it shows how to quit DSH, keep a backup and clean up manually. This feature does not raise the request header limit.

The check runs in a worker thread with an 8-second budget, then terminates and waits for the thread to exit, so a stuck database cannot stall the restart. Backups are written as `.partial` and renamed, so only complete files count toward retention.

## Leftover snapshot preview

DSH keeps change-comparison snapshots under `dsh-workspace-changes-*` in the system temp folder; a crash can leave copies behind, but age alone does not prove a copy is orphaned.

**Currently it only scans and previews; it never deletes.** Upstream has no reliable record of which snapshots are active, and the production route will not fabricate a deletion permit. The scan toggle remains "scan on startup" (off by default): when enabled it scans once 10 s after startup, and a manual scan is also available.

A candidate must be a real directory with the expected prefix, created before this host started, at least 24 hours old, with no writes anywhere in the tree since startup. Symlinks, junctions, read failures and trees that cannot be fully inspected are skipped conservatively. Results show scanned count, candidate count, estimated size and the reason nothing was deleted; candidate size is never presented as reclaimed space.

## API

`GET /dsh-desktop-restart/api/status` returns `restartRequest` with `state` (idle / waiting / countdown / paused / executing / terminal), `countdownRemainingMs`, `countdownUntil`, `deadlineAt`, `pausedReason` and `ask`. The legacy `waiting` field still appears while waiting, counting down or paused.

`POST /dsh-desktop-restart/api/restart?choice=wait|now|cancel` is valid only while paused; new clients also send `ask`, and a stale id returns 409. Cancel in other stages uses `cancelWait=1`; immediate execution accepts `force=1&now=1`.

`POST /dsh-desktop-restart/api/prefs?countdown=<integer>` stores the next countdown (0–60); out-of-range or non-integer values return 400 and leave the previous value untouched.

The client only mirrors host state over a single 2-second poll; the countdown display is derived from the host's `countdownUntil` plus a local one-second clock and never decides execution.

## Security model

`POST /api/restart` completes all checks before doing anything:

| Check | Rejection |
| --- | --- |
| Method is not POST | `405` with `Allow: POST` |
| TCP peer is not loopback | `403` |
| `Host` is not a loopback name | `403` |
| Any `forwarded` / `x-forwarded-for` / `x-real-ip` | `403` |

When the platform auth service is unavailable, write routes return 503 instead of allowing the request.

## Diagnostics and settings storage

Host settings live in `desktop-restart/settings-<profileId>.json`, isolated by profile directory identity. When the new file is missing and a legacy `settings.json` exists, the new file is created exclusively and copied once; the legacy file keeps its original content.

Failures and unconfirmed results create one redacted diagnostic record per operation id and result class, and attempt a Windows toast. Without permission or confirmation the plugin still shows an unread reminder until it is explicitly marked read. Diagnostics never contain process paths, command lines or credentials.

Cross-process restarts use `desktop-restart/restart.lock` (atomic creation plus stale-lock takeover) so two instances cannot end the same main process concurrently.

## Known limitations

- Package version `0.4.6`.
- Accepted on a real machine: the full restart chain (including downtime measurement and receipt), account-menu first-open injection, panel button states, log redaction.
- Not yet accepted: screen readers, frame-by-frame absence of visual flicker, menu keyboard navigation, multi-window concurrency, per-theme and narrow-width pixel layout.
- Offline tests cover the state machine, fail-safes, concurrency and isolated fixtures; passing `npm test` does not mean the real-machine items above are accepted.
- Core restart requires Node.js ≥ 20; the sign-in credential check requires Node.js ≥ 22.16 (`node:sqlite`) and is skipped automatically on older versions.
