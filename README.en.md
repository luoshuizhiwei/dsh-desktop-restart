# dsh-desktop-restart

English | **[简体中文](README.md)**

A restart plugin for the **DeepSeek Harness desktop app (Electron)**. It adds a **"Restart Desktop App"** entry at the **top of the left sidebar** (mounted on the official panel slot for third-party plugins — the row itself is drawn by the sidebar, so it looks exactly native), another entry at the **bottom of the sidebar**, a button in the conversation header, a `/restart-desktop` slash command, and a row under Settings → General. Which entries exist is up to you — toggle them in the plugin's own settings section.

Besides restarting, it also ships two small extras (grouped under one **"Bundled extras"** section in the settings, both optional): sweeping the change-snapshot directories DSH leaves behind in the system Temp folder when it is hard-killed, and hiding the easy-to-misclick "Feedback" item that sits right below "Settings" in the account menu. Neither is functionally related to restarting — they just ride along with this plugin.

## Why it exists

The desktop app's process model is nothing like `dsh web` in a terminal:

```
DeepSeek Harness.exe            ← Electron main: window, tray, auto-update
  └── DeepSeek Harness.exe      ← host child (same exe + ELECTRON_RUN_AS_NODE=1)
        └── this plugin         runs dsh-desktop-host, listening on 127.0.0.1
```

Two consequences:

1. **The host exiting ≠ the app restarting.** The main process treats a child exit as a failure and shows a recovery dialog (default button: "Restart app") — workable, but it needs a human click every time.
2. **No restart channel exists for plugins.** The full IPC surface is `shutdown` / `quit-inspection` / `update-tasks` (main → host) and `ready` / `fatal` / `shutdown-complete` / `platform-session` (host → main); the renderer-side `DESKTOP_IPC` table has no restart either. The built-in "Restart app and host" menu item only exists in development builds, and on Windows the app menu bar holds only devTools while the tray menu has "Open" and "Quit".

So a one-click restart can only be done by a process **outside the host**.

## How it works

1. An entry POSTs to this plugin's own host route (same-origin).
2. The host half **checks the state first**: running tasks, and whether an install/update is currently writing the profile (see "Guards" below). If either hits, it answers with a warning and asks the caller to retry with `?force=1`.
3. Once checks pass it writes a handoff description, then spawns a **detached helper** via `process.execPath` (the desktop app itself) with `ELECTRON_RUN_AS_NODE=1`, and immediately replies 202. The helper therefore needs neither a system Node nor `dsh` on PATH.
4. The helper waits 1.5 s for the response to reach the browser, then — while the main process is still alive — asks once for its command line and executable path (the restart should carry the original arguments; the fallback kill also identifies targets by path).
5. The helper ends the **Electron main process** — deliberately **without `/T`**: the host child must survive so it can shut down gracefully after the IPC drop (`application.shutdown`) and flush its session logs. Using `/T` would hard-kill the host too — that is what actually loses data.
6. The helper waits for the main process to disappear, then for the listening port to be released (probed by *connecting*, not *binding* — a probe bind would occupy the very port the replacement needs).
7. If the port won't let go: first sweep leftover processes of the **same executable** (excluding the helper itself, the main process, and the **host**); fall back to image-name matching only when no path is available. If the port is still held after the sweep, the stuck one is the host — which should have exited on its own — and only then is it ended individually, with a log line spelling out that this is a last resort and its session logs may be incomplete (see "Known limitations").
8. The helper relaunches a fresh instance with a clean environment — `ELECTRON_RUN_AS_NODE` must be stripped, or the new "app" would boot in Node mode as a windowless process. If the new instance dies immediately it retries (default 3 times); only after all attempts fail does it give up and pop a dialog asking the user to open the app manually — otherwise the window would simply never come back while the log says "relaunched".
9. The handoff directory keeps only the latest 20 handoff/log pairs; older ones are pruned.

## Guards

"Can restart" is not "should restart". The app's own quit flow first asks the host what would be interrupted (`hasDesktopActiveTasks`: agents generating or running tools, queued messages, background jobs running or stopping) and prompts the user; this plugin ends the main process directly, bypassing that check. Two equivalent guards make up for it:

| Guard | Criterion | What it covers | Outcome |
| --- | --- | --- | --- |
| Tasks running | the `agents` + `jobs` services, same criteria as the app | all sessions, subagents, expert teams, task-board runs, background jobs | **warn only**: confirm once and the restart proceeds |
| Plugin install/update in progress | the process recorded in `<profile>/.plugin-manager/run.json` is **still alive** | the built-in plugin manager, the plugin market, any `dsh plugin` operation | **hard block**: `?force=1` is refused too; wait for it to finish |

**Running tasks only warn**: tasks end on their own, and a user who understands the cost may proceed — the first request returns `409` plus a "what this would interrupt" list, the client shows it and asks for a second click, and only the second request carries `?force=1`.

**An install/update in progress hard-blocks** (2026-10-12): pnpm is writing the profile's `node_modules`; ending the host mid-write leaves the dependency tree half-old-half-new — the new instance may fail to load a plugin, and `package.json` / lockfile may sit in a "edited but not installed" state. That is not a "the user knows, let them" risk, so no `force` path is offered.

The criterion is **whether the process is alive**, not whether the record file exists: `run.json` lingers after a hard kill (the app itself waits 5 s then deletes it), and blocking on file existence would deadlock the restart button — exactly the 2026-10-06 bug. The liveness test **mirrors the app's own** (`treeAlive` from `@deepseek-ai/dsh-plugin-manager`: `process.kill(pid, 0)` not throwing = alive):

- process alive → hard block (just wait, usually a minute or two; the next click after it ends goes through);
- process gone → treat as crash leftover, **don't block** (the recorded pid is still reported for diagnosis);
- no readable pid (truncated file, changed format) → can't tell, **warn only**, `force` allowed — better to ask twice than to guess.

## Install

### From npm

```sh
dsh plugin add @luoshuizhiwei/dsh-desktop-restart
```

### From source

The package lives at `~/.dsh/local-plugins/dsh-desktop-restart` and mounts via the profile manifest:

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "@luoshuizhiwei/dsh-desktop-restart": "link:../../local-plugins/dsh-desktop-restart"
  },
  "dsh": { "profile": { "bundles": [ "...", "@luoshuizhiwei/dsh-desktop-restart" ] } }
}
```

On older desktop builds the `desktop` profile is managed exclusively by the Electron app and `dsh plugin --profile desktop add` is refused (`profile "desktop" is managed exclusively by the Electron application`); declare the dependency and bundle by hand in that case, and the `node_modules` entry becomes a junction pointing at the source directory.

After installing, **restart the app once** to load it — that first restart has to be manual (the plugin isn't running yet).

## Usage

Five entries, all through the same guarded path:

1. **"Restart App" at the top of the left sidebar** — mounted on the official panel slot for third-party plugins (`sidebar.panellist` + `main`); **the row is drawn by the sidebar itself**, so it looks native. Clicking opens the restart panel in the main area; click "Restart" there.
2. **"Restart App" at the bottom of the sidebar** — the official action slot for third-party plugins (a 42px action row; 36×36 circle when the sidebar is collapsed). Click twice to restart.
3. **Conversation header button** — the refresh icon + "Restart" at the right of the conversation header.
4. **Slash command** — type `/restart-desktop` in the composer.
5. **Settings → General → Restart Desktop App** — the fallback entry.

Button-style entries use a two-step confirm: the first click arms (`Restart now?`), a second click within 5 s executes; the slash command executes directly. The page then disconnects, the app restarts, and the page recovers once the new process is ready.

**When tasks are running**: the second click does not restart immediately — instead the **official risk-confirmation dialog** appears (warning + explicit checkbox + confirm button, disabled until checked), spelling out what would be interrupted (e.g. `2 agents generating or running tools, 1 background job running`). The slash command in the same situation just errors and hints `/restart-desktop --force`. Entries also surface the current state in their tooltips before you click. (If the official component is unavailable, it falls back to an inline warning state with a 0.9 s cooldown.)

**The UI uses official components**, not lookalikes:

- The sidebar panel row rides the official panel slot (`sidebar.panellist`): the plugin registers only `id / order / label` and an icon component — the **entire row is drawn by the sidebar**, so it cannot look off. Clicking switches the main area to the matching `main` panel, which triggers the restart with an official `Button` (primary).
- The **main-area panel follows the page layout of its slot-mate** (the task board): it fills the main area's height, paints `--dsw-alias-bg-base`, uses `14px 16px 16px` padding, a 16px/700 title with a status word on the same row, 12px block gaps, and rounds the description, guard warning and result into separate cards. (Reported as a layout bug on 2026-10-20: it used to be a 560px column centred in a full-height area, reading like loose text floating in empty space.)
- The sidebar-footer entry rides the official `sidebar.footer.action` slot (where the app's own plugin panel lives) and copies the 42px action row of its slot-mates verbatim; it becomes a 36×36 circle when the sidebar collapses to a rail (the slot passes `{ wide }`).
- The header button copies the real button in that slot (`ui-jops`' `JobListAction`) measure for measure; below 540px window width only the icon remains.
- Settings rows use the official `Button` (`variant="ghost"`); the icon is the official `IconRefreshOutlineRegular`; interruptions use the official `RiskConfirmation`.
- Color semantics use official tokens: neutral for plain confirmation, `--dsw-alias-state-warn-primary` when work would be interrupted, error red only on failure; the icon spins during handoff (honoring reduced-motion).
- Official components are declared in `dsh.client.inject`; should DSH rename or move a package, the plugin falls back to its own **measure-copied** styles instead of crashing.

The full comparison (including the verbatim CSS and official source paths) is in `docs/official-ui-standard.md`.

## Choosing your entries

The plugin ships a **settings section** with four toggles — changes apply **immediately**, no restart or refresh (the same section also holds the two bundled extras below):

| Toggle | Turning it off |
| --- | --- |
| Sidebar panel entry | the top-of-sidebar row disappears (and its main-area panel) |
| Sidebar footer entry | the bottom-of-sidebar row disappears — it may crowd other plugins' rows in the same slot; turn this off if they collide |
| Conversation header button | the header button disappears |
| Settings → General row | the fallback row in General settings disappears |

All four entries and the slash command are **on by default** (a fresh install shows the entry in all four places); choices are stored in the **local browser** (`localStorage`); **defaults** come from the plugin's config — in `~/.dsh/profiles/<profile>/cordis.patch.yml`, set `config: { panel: false, footer: false, header: false, settingsRow: false, command: false, enabled: false }` on this plugin's row to change them in one place (`command` is the `/restart-desktop` slash command; `enabled` is the master switch).

## Sweeping leftover change snapshots

DSH's built-in change snapshots (the "what changed this round" cards) copy the workspace into the system Temp folder once per session and delete it when the session closes or the app exits **cleanly**. A hard kill (ending the host in Task Manager, a crash, power loss) leaves them behind — one 2026-10-09 disk audit found 25 such directories totalling 10.9 GB.

This plugin takes over that cleanup: **10 s after startup** (async, not competing for startup I/O) it scans the system Temp once and removes directories judged orphaned. **All** of these must hold:

| Condition | Why |
| --- | --- |
| Name has the `dsh-workspace-changes-` prefix | never touches anything else in Temp |
| It is a directory | files with the same prefix are left alone |
| Created before this host started | session dirs inside this process are newer than startup |
| Not written since this host started | someone still writing to it means it isn't alone |
| At least 24 hours old | headroom for a second DSH instance running at the same time |

**Off by default** (since 2026-10-20): a fresh install touches nothing in the system Temp folder — turn it on in **Settings → Plugins → Restart Desktop App** (a deployment that wants it on by default can set `sweep: true` in config); the same row has a "Sweep now" button for a manual pass. The switch is stored host-side (`~/.dsh/desktop-restart/settings.json`) because the sweep must run before any client connects; when off, the host touches nothing.

"Sweep now" uses **the same criteria** — it does not loosen them just because a human clicked — so a directory left by a crash earlier today is only removed after its 24 hours. That is deliberate: the age threshold is exactly what separates "orphan" from "a live session in another instance".

**The result must be visible** (2026-10-10): most sweeps report "scanned 6, removed 0", identical to the last time. An earlier version wrote the receipt as a single 12px tertiary-gray line, which still read as "nothing happened". The result is now its **own row**: the icon spins while running, then the line is colored by outcome — green for success, warning yellow when some directories could not be removed, red on error — and carries a timestamp, so "it ran again" is itself visible.

**Known edge**: with a second DSH instance open (e.g. `dsh web` in a terminal), a session in that instance that stays **completely idle for over 24 hours** can be misjudged as an orphan. The cost is that this session's change-comparison cards stop working (the directory only holds snapshot copies; no user data is touched); restarting that instance restores it. A real fix has to come from upstream.

## Hiding "Feedback" in the account menu

In the account menu (the avatar / "More" at the bottom of the sidebar), right below "**Settings**" sits "**Feedback**" — clicking it opens an external website. The official item is rendered as a `button[role="menuitem"]` with no `id` and no `data-*`, so only a script that recognizes the text can hide it — pure CSS can't select it. This plugin therefore matches **by text** (`意见反馈` / `Feedback`) and removes the item from view once the menu mounts: menus render **on open**, so it's a `MutationObserver`, not a one-time scan.

| Aspect | Behavior |
| --- | --- |
| Default | **not hidden** (since 2026-10-20: a fresh install leaves the menu as it is; turn it on to hide). It used to be hidden by default |
| Toggle | **Settings → Plugins → Restart Desktop App → Bundled extras** |
| Stored | local browser (`localStorage`); the host is not involved |
| After turning off | the hidden item **reappears immediately**, no refresh |
| Unrecognized text | do nothing — rather leave it than harm other menu items |

It touches exactly this one menu item: the test is "this `button[role=menuitem]`'s text equals `意见反馈` / `Feedback`"; every other item is untouched byte for byte (covered by a smoke test).

## Security model

`POST /dsh-desktop-restart/api/restart` completes every check before acting:

| Check | Rejection |
| --- | --- |
| Method is not POST | `405` with `Allow: POST` |
| TCP peer is not loopback | `403` |
| `Host` is not a loopback name | `403` |
| `forwarded` / `x-forwarded-for` / `x-real-ip` present | `403` |
| No `Origin` and `Sec-Fetch-Site` is not `same-origin` | `403` |
| `Origin` present but its host ≠ `Host` | `403` |
| Platform auth: no browser session cookie | `401` (the message says what's missing) |
| Platform auth: trust fence refused (Host / Origin / cross-site marker) | `403` (a distinct message — different fix) |
| Host is not the Electron desktop build | `409` |
| `config.enabled` is false | `403` |
| A restart handoff is already in progress | `409` |
| Tasks running / install in progress, without `?force=1` | `409` + a `guard` payload (counts and plain language only, no paths) |

The order is deliberate: `enabled` → desktop build → already handing off are **hard refusals** that `force` cannot bypass; the guards come last because they ask "continue?" — and `force` is the answer.

**Why a missing `Origin` passes**: the desktop pages load over the `dsh-app://` protocol and the shell forwards in-page `fetch('/…')` to the host port, and such forwarded requests carry **no `Origin`**. Requiring one outright would make the button return 403 forever in the desktop app — one reason the market's `dsh-simple-restart` fails there. So with no `Origin`, every other condition must hold instead (loopback peer, loopback Host, no proxy traces, `Sec-Fetch-Site` absent or `same-origin`).

**The second gate is the platform's browser auth** (added 2026-10-15): the list above is only half of the fence. DSH guards its own `/api` in two steps — fence + **browser cookie auth** — and the platform opens both to plugin routes: `ctx.connection.requestRejection(request) -> 401 | 403 | undefined`. With only the fence, any local process **sending no headers at all** could give orders (measured: `curl` hit the restart/sweep routes freely while DSH's own `/` returned 401). The write routes now take that step too:

- a platform `401` / `403` is passed through, with two distinct messages (missing credentials vs. Host/Origin mismatch — different fixes, and mixing them sends people guessing at a 403);
- with no `connection` service in the composition, this degrades to "not applicable" and the self-checks above still apply — it's an optional dependency, and its absence must never keep the plugin from loading;
- if the platform call itself throws, it is treated as "don't block" and the error is logged — a transient failure must not escalate into "the app can never be restarted";
- deployments that genuinely need the old behavior (a desktop-shell path without cookies) can set `config.platformAuth` to `false`.

`POST /dsh-desktop-restart/api/sweep` (the sweep toggle and manual run) passes the same gates: non-`POST` → `405`, untrusted origin → `403`, **and platform auth as well** (it really deletes directories on disk — "no Origin means one of us" is not enough), with parameters limited to `?enabled=0|1` and `?run=1` (query params for the same reason as above). What it can delete is pinned down by the checks above — when in doubt, it deletes nothing.

**The status route only diagnoses, never blocks**: it must be able to explain why the button doesn't work even when auth fails, so it still answers `200` and reports `{ enforced, available, verdict, error }` in its `platformAuth` field — letting the UI explain instead of leaving people to guess at a 401.

## Known limitations

- **Electron desktop build only.** On `dsh web` the status route truthfully reports `desktop: false` and the button is disabled; that's by design, not a bug.
- **The desktop app no longer uses a fixed port since 0.2.1-rc.2** (19387 is history). Each start picks a free port (observed: 19387 → 14246 → 8418 → 10317), so "did the old port come back" cannot be the readiness test. The helper instead looks for **a loopback listener owned by the same executable** (one `netstat -ano` + one `tasklist`); if the listener table can't be read it says so honestly rather than claiming failure.
- **Running tasks only warn.** After confirmation, running turns and background jobs are interrupted as before; files being written may stop halfway, and the plugin does not roll back. (An install/update in progress is a **hard block** — see the table above.)
- **The install guard judges liveness by pid.** If the recorded process already exited and the OS reused that pid for another process, it can be misjudged as "still installing". Rare in practice: `run.json` exists only during an operation or as crash residue, and the app cleans its own residue; when it happens, the misjudgment clears the moment that process ends. The app itself judges the same way.
- **The main process is hard-killed.** Its own cleanup (window state, tray) doesn't run. The session data that matters lives in the host process, which shuts down gracefully. That's the price of "one click" — the main process exposes no restart channel.
- **The fallback sweep may end the host, whose session logs may then be incomplete.** Only in one scenario: the main process is gone and the port still hasn't been released after 30 s — meaning the host is stuck, and without ending it the new instance can't bind. It is never swept up with the "leftover processes"; the log says so explicitly. Normally the port frees within a second and this path never runs.
- **The main process is identified by `process.ppid`** (the host's parent), cross-checked by image name. If upstream changes the launch scheme, or a recycled pid happens to be another same-named program, the target could in theory be misidentified; a failed cross-check refuses to act rather than killing blindly.
- **The restart carries the original launch arguments** (`--user-data-dir` and friends), but only when certain: unreadable command line, a different executable, escaped quotes, or a Chromium-child/host-looking command line all fall back to "relaunch without arguments". The working directory is fixed to the executable's folder.
- **No guard covers an app auto-update in progress.** The updater leaves no readable state behind; the only defense is not restarting mid-update.
- **May break on DSH upgrades.** The implementation depends on the current process model and the `ELECTRON_RUN_AS_NODE` convention; the guards depend on the `agents` / `jobs` services and `.plugin-manager/run.json`, and silently skip when unavailable (rather than blocking restarts). If upstream changes the host's launch scheme or adds a restart IPC to the main process, switch to the official channel.
- **Only verified on Windows.**
- **Third-party skins (e.g. `dsh-claude-style`) use `aria-label` as a visible row title.** When that skin takes over the sidebar footer it names each row from `aria-label || textContent`. This plugin's `aria-label` therefore carries only **state words of four characters or fewer** ("重启应用", "已排程", "重启中", "重试" — or "Restart", "Scheduled", … in English), while the detailed hint ("Work in progress (2 agents generating or running tools); click twice to restart anyway") lives in visually hidden text referenced by `aria-describedby` — screen readers still announce it, but it is never painted as button text. (Fixed once on 2026-10-20: the hint used to be concatenated into `aria-label` and appeared as a very long row title in the collapsed bottom-left corner.)

## Diagnostics

Each restart writes a handoff description and helper log under `~/.dsh/desktop-restart/` (latest 20 pairs kept):

```
restart-<timestamp>.log       full helper diagnostics
handoff-<timestamp>.json      this handoff's target and parameters
```

A healthy restart logs:

```
helper started: helper=… host=… main=… port=… exe=…\DeepSeek Harness.exe
preserving 0 launch argument(s): []
ending the Electron main process … without /T, so the host can close gracefully
taskkill /PID … /F ok
main process exited
port … released
relaunched "…\DeepSeek Harness.exe" as pid …
relaunched process (pid …) is still alive after 2500ms
the new instance is listening on port … — restart complete
```

It never lies about success:

```
the relaunched process (pid …) is already gone — attempt 1 did not take
relaunch attempt 2/3 in 1500ms
the restart did not take after 3 attempt(s); the application is not running
failure notice dispatched to the user
```

## Development

```sh
node scripts/smoke.mjs
```

Offline smoke tests (112 checks, 4 of them Windows-only): the host half loads with a stub context, verifying route guards and every refusal path; guard criteria (task snapshots, install records, process liveness, platform-auth verdicts, refusal copy, path filters, command-line tokenizing, netstat listener parsing) are pure functions tested directly; the orphan-snapshot rule is a pure function (with the "created after start" / "written after start" / "too young" counterexamples) while the deletion itself runs for real in a temp directory; the client half checks bundle identity, injection style, measure-for-measure alignment with official UI, color semantics, and accessibility attributes; the helper exercises the "image name mismatch", "relaunch dies immediately", "process table unreadable", and "port won't free" branches (these four depend on tasklist / taskkill / where.exe and **run on Windows only** — CI's Linux/macOS skips and counts them; all other pure-function checks run on all three platforms — the first CI run on Linux caught an assertion that had hard-coded Windows behavior as universal). **The suite never restarts anything**, never touches the real system Temp (sweep cases point `TMP`/`TEMP` and `DSH_HOME` at test-local directories), and cleans up after itself.

## Language

UI copy goes through the official locale service (issue #1): the plugin registers a `{ zh, en }` dictionary and the **language follows the main DSH app's setting** — no manual toggle. Host-side error messages have no locale service available (true for official plugins too) and are returned in Chinese; the client substitutes its own translation when it has translatable information, and shows the original text otherwise. Without the locale service in the composition it falls back to the browser language, and never fails to load. The "hide Feedback" match strings (both Chinese and English) are **not translated** — they match the menu item's literal text.

## Releasing

Releases are automated via CI (`.github/workflows/ci.yml`) with **no npm credentials stored locally**:

1. Regular pushes → CI runs the full smoke suite on node 20/22/24;
2. **Release gate (rule since 2026-10-20)**: before tagging `v*`, show the author what changed — the tag is pushed only after the author approves. Pushing the tag publishes automatically, so this human gate is the only checkpoint and may not be skipped;
3. Push a `v*` tag → after the three-way tests pass, the publish job publishes to npm via **OIDC Trusted Publishing** (npm ≥ 11.5.1, no tokens, no OTP), with automatic provenance attestation for public repositories.

One-time registration (done 2026-10-20): npmjs.com → this package → Settings → **Trusted Publisher** → GitHub Actions, with owner `luoshuizhiwei`, repo `dsh-desktop-restart`, workflow `ci.yml`, and **Allowed actions including `npm publish`** (the default allows only staged publish, and direct publishing would be refused without the checkbox). Two official-docs caveats: the first successful publish must happen **within 2 days** of registration or the configuration expires; npm does not validate the form on save — fields are case-sensitive and must match the repository exactly.

## License

MIT
