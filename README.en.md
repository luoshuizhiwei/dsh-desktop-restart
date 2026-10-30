# dsh-desktop-restart

This worktree passed the full npm test suite after batch-one safety fixes on 2026-10-29. The new cross-process lock and read-only Cookie backup have not been accepted through a real DSH restart. Earlier desktop restarts establish only the source tested then. The package remains 0.4.5 and differs from the published release.

English | **[简体中文](README.md)**

A restart plugin for the **DeepSeek Harness desktop app (Electron)**. It adds a **"Restart Desktop App"** entry at the **top of the left sidebar** (mounted on the official panel slot for third-party plugins — the row itself is drawn by the sidebar, so it looks exactly native), another entry at the **bottom of the sidebar**, a button in the conversation header, a `/restart-desktop` slash command, and a row under Settings → General. Which entries exist is up to you — toggle them in the plugin's own settings section.

**Waits for verified idle by default**: generation, tools, jobs, queued messages or unknown task state keep the request waiting. Idle starts the captured countdown (0–60 seconds, default 0). New work observed during countdown pauses with one question; no answer means no execution. All pre-execution stages share the original 30-minute deadline.


Besides restarting, it also ships two small extras (grouped under one **"Bundled extras"** section in the settings, both optional): previewing leftover change-snapshot candidates in the system Temp folder (currently without deletion), and hiding the easy-to-misclick "Feedback" item that sits right below "Settings" in the account menu. Neither is functionally related to restarting — they just ride along with this plugin.

## Why it exists

Version 0.4.5 is the current release. HTTP 202 means scheduling was accepted; the UI continues reading the host's actual progress and result. A failed status read preserves the last confirmed operation and offers a retry. If the helper's identity or execution outcome cannot be established, another restart remains blocked; manually quit and reopen the desktop app when required instead of clearing records to bypass the lock.

Snapshot permission errors and incomplete scans are reported separately, and candidate sizes are estimates. The real-DSH restart chain, host/client recovery receipts and handoff duration were verified locally; the duration is not exact UI downtime. Screen-reader acceptance has not been performed, and offline tests do not establish it.

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
2. The host checks the installation hard guard, then owns waiting, countdown, pause and execution. Immediate execution still passes installation and identity guards.
3. Once checks pass it writes a handoff description, then spawns a **detached helper** via `process.execPath` (the desktop app itself) with `ELECTRON_RUN_AS_NODE=1`, and immediately replies 202. The helper therefore needs neither a system Node nor `dsh` on PATH.
4. The helper waits 1.5 s for the response to reach the browser, then — while the main process is still alive — asks once for its command line and executable path (the restart should carry the original arguments; the fallback kill also identifies targets by path).
5. The helper ends the **Electron main process** — deliberately **without `/T`**: the host child must survive so it can shut down gracefully after the IPC drop (`application.shutdown`) and flush its session logs. Using `/T` would hard-kill the host too — that is what actually loses data.
6. The helper waits for the main process to disappear, then for the listening port to be released (probed by *connecting*, not *binding* — a probe bind would occupy the very port the replacement needs).
7. If the port remains held, only processes proved to belong to this instance by ancestry, executable path and creation identity may be ended. The helper never broadens to image-name matching or treats an identical executable path as proof of instance ownership. Unverifiable identity stops the operation with a diagnostic. A stuck host is considered separately and rechecked before a last-resort termination, with an explicit warning about incomplete session logs.
8. The helper relaunches a fresh instance with a clean environment — `ELECTRON_RUN_AS_NODE` must be stripped, or the new "app" would boot in Node mode as a windowless process. If the new instance dies immediately it retries (default 3 times); only after all attempts fail does it give up and pop a dialog asking the user to open the app manually — otherwise the window would simply never come back while the log says "relaunched".
9. The handoff directory keeps only the latest 20 handoff/log pairs; older ones are pruned.

## Guards

"Can restart" is not "should restart". The app's own quit flow first asks the host what would be interrupted (`hasDesktopActiveTasks`: agents generating or running tools, queued messages, background jobs running or stopping) and prompts the user; this plugin ends the main process directly, bypassing that check. Two equivalent guards make up for it:

| Guard | Criterion | What it covers | Outcome |
| --- | --- | --- | --- |
| Tasks running or unknown | `agents` + `jobs` services | this instance’s generation, tools, queues and jobs | wait normally; new work during countdown pauses; an additional confirmation permits immediate execution |
| Plugin install/update in progress | the process recorded in `<profile>/.plugin-manager/run.json` is **still alive** | the built-in plugin manager, the plugin market, any `dsh plugin` operation | **hard block**: `?force=1` is refused too; wait for it to finish |

**The host detects task changes**: waiting samples every five seconds; countdown samples at most every second. New work creates one stable question with Continue waiting / Restart now / Cancel. Continue starts a full countdown on the next idle observation without extending the original deadline. Restart now requires one additional confirmation. An unanswered question stays paused until cancellation or expiry.

**An install/update in progress hard-blocks** (2026-10-12): pnpm is writing the profile's `node_modules`; ending the host mid-write leaves the dependency tree half-old-half-new — the new instance may fail to load a plugin, and `package.json` / lockfile may sit in a "edited but not installed" state. That is not a "the user knows, let them" risk, so no `force` path is offered.

The criterion is **whether the process is alive**, not whether the record file exists: `run.json` lingers after a hard kill (the app itself waits 5 s then deletes it), and blocking on file existence would deadlock the restart button — exactly the 2026-10-06 bug. The liveness test **mirrors the app's own** (`treeAlive` from `@deepseek-ai/dsh-plugin-manager`: `process.kill(pid, 0)` not throwing = alive):

- process alive → hard block (just wait, usually a minute or two; the next click after it ends goes through);
- process gone → treat as crash leftover, **don't block** (the recorded pid is still reported for diagnosis);
- no readable pid (truncated file, changed format) → can't tell, **warn only**, `force` allowed — better to ask twice than to guess.

## After a restart: receipt

Version 0.4.5 binds a receipt to the current profile, installation instance and a unique restart identifier. The helper passes that identifier only to the replacement application. Its new host claims and consumes the receipt once within a short validity window. A failed scheduling attempt invalidates its marker.

The receipt separates the request time from **Host recovery time**. It proves that the new host loaded the plugin; it does not certify that every window, plugin or background task is ready.

The plugin does not send messages to sessions or automatically restart model turns or background jobs. Results appear only in the plugin UI; users continue interrupted work themselves. There are no session-resume modes or related settings/API parameters.

The replacement process strips old Node-mode, session, URL, shell and restart identifiers while preserving DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR. The helper explicitly supplies the new one-time identifier.

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

Five action entries and a read-only settings row share host state:

1. **"Restart App" at the top of the left sidebar** — mounted on the official panel slot for third-party plugins (`sidebar.panellist` + `main`); **the row is drawn by the sidebar itself**, so it looks native. Clicking opens the restart panel in the main area; click "Restart" there.
2. **"Restart App" at the bottom of the sidebar** — the official action slot for third-party plugins (a 42px action row; 36×36 circle when the sidebar is collapsed). Click twice to restart.
3. **Conversation header button** — the refresh icon + "Restart" at the right of the conversation header.
4. **Slash command** — type `/restart-desktop` in the composer.
5. **Account menu → Restart Desktop App** — above Settings. Injection depends on the host menu structure; unsupported layouts are skipped with a diagnostic reason code.
6. **Settings → General → Restart Desktop App** — read-only status and refresh, without a restart action. Countdown is configured in the plugin settings section.

When idle, button entries require two clicks within five seconds to submit a normal waiting request; `/restart-desktop` submits once. With known active work, the first click arms a danger warning; after 900ms a second click forces an immediate restart, skipping waiting and countdown. The warning expires after 15 seconds by default (configurable 5–60). Header confirmation/warning text stays visible at every width; details remain in tooltips and accessible descriptions. A 202 response means accepted, not completed. Repeated normal submissions preserve the first deadline.

**While waiting or counting down**, the main button is locked; use Cancel waiting. **The pause question** also offers Restart now anyway with an additional confirmation. Immediate execution skips task waiting and countdown, while installation and identity hard guards remain mandatory. Cancellation after executing returns `cancelled:false` and the UI rereads host state. Expiry explicitly reports that no restart was executed. The compatibility command `/restart-desktop --force` explicitly accepts the risk of immediate execution.

**The UI uses official components**, not lookalikes:

- The sidebar panel row rides the official panel slot (`sidebar.panellist`): the plugin registers only `id / order / label` and an icon component — the **entire row is drawn by the sidebar**, so it cannot look off. Clicking switches the main area to the matching `main` panel, which triggers the restart with an official `Button` (primary).
- The **main-area panel follows the page layout of its slot-mate** (the task board): it fills the main area's height, paints `--dsw-alias-bg-base`, uses `14px 16px 16px` padding, a 16px/700 title with a status word on the same row, 12px block gaps, and rounds the description, guard warning and result into separate cards. (Reported as a layout bug on 2026-10-20: it used to be a 560px column centred in a full-height area, reading like loose text floating in empty space.)
- The sidebar-footer entry rides the official `sidebar.footer.action` slot (where the app's own plugin panel lives) and copies the 42px action row of its slot-mates verbatim; it becomes a 36×36 circle when the sidebar collapses to a rail (the slot passes `{ wide }`).
- The header button copies the real button in that slot (`ui-jops`' `JobListAction`) measure for measure; non-idle state text remains visible at all widths, with a tighter limit below 540px.
- Settings rows use official buttons and prefer the official refresh icon. A shared store assigns the pause question or immediate confirmation to one mounted action entry. Legacy guard responses still support official `RiskConfirmation`.
- Color semantics use official tokens: danger red for header confirmation/warning and the panel force warning, secondary warning color while waiting/counting down, and error color for failures; the icon spins during handoff (honoring reduced-motion).
- Official components are declared in `dsh.client.inject`; should DSH rename or move a package, the plugin falls back to its own **measure-copied** styles instead of crashing.

The full comparison (including the verbatim CSS and official source paths) is in `docs/official-ui-standard.md`.

## Choosing your entries

The plugin ships a **settings section** with five entry toggles — changes apply **immediately**, no restart or refresh (the same section also holds the two bundled extras below):

| Toggle | Turning it off |
| --- | --- |
| Sidebar panel entry | the top-of-sidebar row disappears (and its main-area panel) |
| Sidebar footer entry | the bottom-of-sidebar row disappears — it may crowd other plugins' rows in the same slot; turn this off if they collide |
| Conversation header button | the header button disappears |
| Settings → General row | the read-only General settings row disappears |
| Account menu entry | the injected restart item disappears; diagnostics remain available |

All five UI entry switches and the slash command are **on by default** (menu injection still requires a compatible structure); choices are stored in the **local browser** (`localStorage`); **defaults** come from the plugin's config — in `~/.dsh/profiles/<profile>/cordis.patch.yml`, set `config: { panel: false, footer: false, header: false, settingsRow: false, accountMenu: false, command: false, enabled: false }` on this plugin's row to change them in one place (`command` is the `/restart-desktop` slash command; `enabled` is the master switch).

## Authentication Cookie health and recovery confirmation

Settings show the last downtime estimate, the default 16 KiB limit, authentication Cookie count and check timestamp. This is not live monitoring. With no sample the UI says No downtime sample yet. Normal manual launches/exits do not refresh the sample; Recheck only schedules work for the next plugin restart and never opens the database while the app is running.

Cookie backup defaults off; the 80% warning defaults on. Database access is read-only. Optional consistent backups retain three copies; no Cookies are automatically deleted. Legacy authCookieClean values do not enable the new switch. Over-limit samples show instructions to quit DSH, keep a backup and handle Cookies manually. Surviving old-instance processes or unverified identities skip database work without stopping the restart. The plugin does not raise the HTTP header limit.

Recovery requires this restart nonce's host receipt, an authenticated client acknowledgement after a renderer frame, and transport owned by the verified new instance. An inspector listener alone is not success. This confirms host/restart-client connectivity, not every plugin or task. Legacy hosts without receipts remain unconfirmed. The existing downtimeMs is labeled handoff duration, not exact UI downtime.

Submissions and status reads have a ten-second deadline. A missing submission reply is reconciled with host state rather than blindly retried. New hosts reject submissions delayed beyond expiresAt; a status observed after that deadline can safely reconcile the UI. Legacy hosts without that proof stay conservatively locked and suggest a manual quit/reopen. Status preserves the last terminal result until a new request; another reader cannot consume it.

Completed operation records retain the latest twenty eligible records per profile. Pending/unknown records and unread diagnostic references remain protected.

## Previewing leftover change snapshots

DSH stores change-comparison snapshots under system Temp directories named dsh-workspace-changes-*. A crash may leave copies behind, but age does not establish ownership. Another DSH instance can write below objects without changing the snapshot root timestamp.

**The current 0.4.5 host scans and previews; it does not delete snapshots.** Upstream exposes no authoritative registry of live snapshot owners, and production routes do not manufacture permission to delete. The existing sweep preference now means automatic scanning ten seconds after startup, off by default; a manual scan is also available.

A candidate must be a real directory with the exact prefix, predate this host, be at least twenty-four hours old, and have no post-start writes anywhere in its tree. Symlinks, junctions, unreadable entries and incomplete inspection cause conservative skipping. Results show scanned and candidate counts, estimated candidate size, and the reason nothing was removed. Candidate bytes are not reported as reclaimed disk space.

The internal library retains a deletion path only for a trusted owner check that explicitly confirms no other active host. HTTP parameters cannot supply that check. The current host has no such proof and therefore never enables deletion, whether scanning automatically or manually. Deletion can be integrated once upstream provides reliable ownership information.

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

## Request and countdown API (0.4.5 batch 4A)

The plugin settings section saves an integer countdown of 0–60 seconds (default 0). Failed saves restore the confirmed value and display the error. A change only affects the next request.

`GET /dsh-desktop-restart/api/status` adds `restartRequest`: `state` (idle / waiting / countdown / paused / executing / terminal), `countdownRemainingMs` (milliseconds only during countdown), `countdownUntil` (absolute end time only during countdown), `deadlineAt` (absolute request deadline), `pausedReason` and `ask` (non-null only while paused). Legacy `waiting` remains present across waiting, countdown and pause; `restartOp` and `restartBusy` retain their operation semantics.

`POST /dsh-desktop-restart/api/restart?choice=wait|now|cancel` applies only while paused. New clients also send `ask`; a stale identifier returns 409. Other pre-execution stages retain `cancelWait=1`; immediate execution retains `force=1&now=1`. `cancelled` truthfully states whether cancellation occurred. Executing is irrevocable. `POST /dsh-desktop-restart/api/prefs?countdown=<integer>` saves the next countdown; invalid or out-of-range values return 400 without changing the saved value.

The client mirrors host state through one shared two-second network poll. A shared one-second display clock derives remaining time from the host countdownUntil and never triggers execution. Pre-execution states display the absolute auto-cancel deadline. Suspended windows or a busy event loop may delay display or execution. Work shorter than the host sampling interval can be missed. Real Electron timing, long waits and concurrent interactions still need acceptance testing.

## Profile settings, unread diagnostics and scan cancellation (batch 4B)

Host settings use `desktop-restart/settings-<profileId>.json`, with the same profile-directory identity as receipts. If the new file is absent and legacy settings.json exists, an exclusive create copies the contents once. The legacy file is never changed or deleted; an existing profile file is never overwritten by migration. Migration errors are reported in status and reject settings writes.

Failures and unconfirmed outcomes each create one redacted diagnosis per operation ID and outcome category, then attempt a Windows toast. No central MessageBox is used. Unread reminders survive missing permission, suppression or unconfirmed delivery until explicitly marked read. Marking read writes a separate marker and retains restartOp without releasing mutual exclusion; read diagnoses follow the retention policy below. `POST /dsh-desktop-restart/api/prefs?readNotice=<id>` only handles a known diagnosis of the current profile. Public details include the human explanation, original reason code and numeric stage timings, without process paths, command lines or credentials.

The sender uses built-in Windows PowerShell / WinRT and an available PowerShell notification identity; it installs no modules. Clicking only opens a saved redacted diagnostic HTML document in the default viewer. It never restarts DSH or a model. The click bridge and toast expire after ten minutes. Notification Center presentation, Focus Assist and click activation still require real acceptance; submitted does not mean visible.

The scan row exposes Cancel scan via `POST /dsh-desktop-restart/api/prefs?cancelSweep=1`. Production passes shouldStop into recursive traversal; cancellation returns completed partial results with partial=true. An in-flight filesystem IO must finish before the response can settle. Restart requests capture settings and the original deadline on arrival, stop and await the active scan before their state transition, reject execution if unloaded during that wait, and their waiting/executing stages suppress new scans. Production remains preview-only with removed=0.

Cancellation, expiry and asynchronous execution results remain terminal until the next request replaces them. Status reads do not consume results, so multiple entries see the same outcome. Operation diagnoses and unknown-operation locks remain independent. Missing or non-integer countdown capability disables the editor and asks the user to restart an outdated host.

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
| Live installation/update process | `409` + `blocked:true`, including forced requests |

Disabled, non-desktop, mutual-exclusion, platform, installation and identity checks cannot be bypassed by immediate execution. Ordinary requests wait for verified idle; new work during countdown pauses the request.

**Why a missing `Origin` passes**: the desktop pages load over the `dsh-app://` protocol and the shell forwards in-page `fetch('/…')` to the host port, and such forwarded requests carry **no `Origin`**. Requiring one outright would make the button return 403 forever in the desktop app — one reason the market's `dsh-simple-restart` fails there. So with no `Origin`, every other condition must hold instead (loopback peer, loopback Host, no proxy traces, `Sec-Fetch-Site` absent or `same-origin`).

**The second gate is the platform's browser auth** (added 2026-10-15): the list above is only half of the fence. DSH guards its own `/api` in two steps — fence + **browser cookie auth** — and the platform opens both to plugin routes: `ctx.connection.requestRejection(request) -> 401 | 403 | undefined`. With only the fence, any local process **sending no headers at all** could give orders (measured: `curl` hit the restart/sweep routes freely while DSH's own `/` returned 401). The write routes now take that step too:

- a platform `401` / `403` is passed through, with two distinct messages (missing credentials vs. Host/Origin mismatch — different fixes, and mixing them sends people guessing at a 403);
- with no `connection` service in the composition, this degrades to "not applicable" and the self-checks above still apply — it's an optional dependency, and its absence must never keep the plugin from loading;
- if platform authentication throws, sensitive writes return 503 with an authentication-unavailable message; the diagnostic status route remains readable instead of treating an exception as permission;
- deployments that genuinely need the old behavior (a desktop-shell path without cookies) can set `config.platformAuth` to `false`.

`POST /dsh-desktop-restart/api/prefs` and the compatibility `/api/sweep` route share method, origin and platform-auth checks. Parameter enabled=0|1 controls automatic scanning and run=1 scans now. Scans currently preview only; clients cannot provide the internal owner authorization for deletion. Preference persistence failures return an explicit error.

**The status route only diagnoses, never blocks**: it must be able to explain why the button doesn't work even when auth fails, so it still answers `200` and reports `{ enforced, available, verdict, error }` in its `platformAuth` field — letting the UI explain instead of leaving people to guess at a 401.

## Known limitations

- **Electron desktop build only.** On `dsh web` the status route truthfully reports `desktop: false` and the button is disabled; that's by design, not a bug.
- **Ports are dynamic.** Readiness associates a loopback listener with the newly spawned main process and its verified host descendants, rather than accepting another instance with the same image name. Unverifiable readiness is reported as unknown.
- **Explicit immediate execution can interrupt tasks.** It skips task waiting after additional confirmation and does not roll back partially written files. Installation hard rejection remains in force.
- **The install guard judges liveness by pid.** If the recorded process already exited and the OS reused that pid for another process, it can be misjudged as "still installing". Rare in practice: `run.json` exists only during an operation or as crash residue, and the app cleans its own residue; when it happens, the misjudgment clears the moment that process ends. The app itself judges the same way.
- **The main process is hard-killed.** Its own cleanup (window state, tray) doesn't run. The session data that matters lives in the host process, which shuts down gracefully. That's the price of "one click" — the main process exposes no restart channel.
- **The fallback sweep may end the host, whose session logs may then be incomplete.** Only in one scenario: the main process is gone and the port still hasn't been released after 30 s — meaning the host is stuck, and without ending it the new instance can't bind. It is never swept up with the "leftover processes"; the log says so explicitly. Normally the port frees within a second and this path never runs.
- **Unavailable identity queries stop the restart.** The helper cross-checks the host-provided parent PID with executable path, ancestry and process creation identity. It does not kill blindly when the process table is unavailable. Use an ordinary manual quit and launch when policy blocks these queries.
- **Original launch arguments must be reliably recoverable.** Uncertain arguments cause `args-uncertain`; the helper does not silently relaunch without them.
- **No guard covers an app auto-update in progress.** The updater leaves no readable state behind; the only defense is not restarting mid-update.
- **DSH upgrades may change service contracts.** Unknown task state keeps waiting; unavailable identity queries stop execution. Pre-execution requests live only in the current host memory and are not restored after unload or exit.
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
npm test
```

The base offline smoke suite has 119 checks, four Windows-only. npm test also runs host, client and engine behavior regressions for one-time consumption, cancellation, failed-write rollback, retry, localization, instance isolation and preview safety. Components use React/fetch stubs and the helper uses isolated process/VM stubs. Tests do not connect to the real DSH host, send messages to real sessions, or remove real Temp snapshots. CI runs Ubuntu Node 20/22/24 and Windows Node 24. Exact counts and scope come from test output; source-text checks are not real interface acceptance.

## Language

UI copy goes through the official locale service (issue #1): the plugin registers a `{ zh, en }` dictionary and the **language follows the main DSH app's setting** — no manual toggle. Host-side error messages have no locale service available (true for official plugins too) and are returned in Chinese; the client substitutes its own translation when it has translatable information, and shows the original text otherwise. Without the locale service in the composition it falls back to the browser language, and never fails to load. The "hide Feedback" match strings (both Chinese and English) are **not translated** — they match the menu item's literal text.

## Releasing

Releases are automated via CI (`.github/workflows/ci.yml`) with **no npm credentials stored locally**:

1. Regular pushes → CI runs offline tests on Ubuntu Node 20/22/24 and Windows Node 24;
2. **Release gate (rule since 2026-10-20)**: before tagging `v*`, show the author what changed — the tag is pushed only after the author approves. Pushing the tag publishes automatically, so this human gate is the only checkpoint and may not be skipped;
3. Push a `v*` tag → after offline tests pass and the tag exactly matches the package version, the publish job publishes to npm via **OIDC Trusted Publishing** (npm ≥ 11.5.1, no tokens, no OTP), with automatic provenance attestation for public repositories.

One-time registration (done 2026-10-20): npmjs.com → this package → Settings → **Trusted Publisher** → GitHub Actions, with owner `luoshuizhiwei`, repo `dsh-desktop-restart`, workflow `ci.yml`, and **Allowed actions including `npm publish`** (the default allows only staged publish, and direct publishing would be refused without the checkbox). Two official-docs caveats: the first successful publish must happen **within 2 days** of registration or the configuration expires; npm does not validate the form on save — fields are case-sensitive and must match the repository exactly.

## License

MIT

Release tags must exactly equal v plus package.json version. The workflow enforces this before npm publication. Author approval remains required before pushing any release tag; external repository protection and environment approval settings must be verified separately.

## Diagnostic retention and one-time migration (batch 4C)

Unread diagnoses are never automatically removed. After a new diagnosis or mark-read operation, retain the newest 50 read records per profile by at, retiring their .json/.html/.delivery/.read siblings together. Status reads do not prune. Missing JSON is skipped, missing read markers mean unread, and missing delivery files mean visibility-unconfirmed. Multi-file removal is not transactional; IO failures are reported.

The directory index and immutable diagnosis JSON are cached for up to two seconds. Directory metadata changes and local create/read operations invalidate immediately. Delivery metadata is checked on every read, and returned objects cannot mutate the cache. External in-place JSON edits appear after TTL expiry; external file creation/removal invalidates through directory metadata.

Successful legacy migration writes settings-migrated-<profileId>. Existing profile settings without a marker are adopted without overwriting them. Once marked, deleting profile settings uses defaults instead of resurrecting legacy settings. Status settingsMigrated reflects migration/adoption at host activation; settingsMigrationError reports failures and prefs writes return 503. Legacy bytes and mtime remain unchanged. Manually deleting the marker makes migration eligible at the next activation.

Development uses `npm ci --ignore-scripts`, `npm run lint` and `npm test`. ESLint checks undefined names, unused variables and unreachable code; new test helpers also check two-space indentation. Existing source is not reformatted wholesale. Test output separates registered source-text checks, historical reproductions and skipped native SQLite suites from current behavior evidence.

Core restart supports Node >=20. Optional Cookie checks/backups require Node >=22.16.0 (node:sqlite and backup). The Node 20 CI entry explicitly skips the native SQLite suite; maintained Node 22/24 entries run it. Waiting for idle by default is intentional compatibility policy: shouldWaitForIdle is now the internal name, bare force still waits, and only explicit force+now executes immediately. Missing platform authentication makes write routes return 503.

New handoff files store only the executable basename. The full path travels in a helper-only environment variable, is omitted from launch logs and is not inherited by the relaunched app. Valid completed orphan op records without profileId become eligible after seven days; pending, unknown, damaged and unread-linked evidence remains protected.
