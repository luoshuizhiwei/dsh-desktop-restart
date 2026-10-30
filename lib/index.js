/**
 * dsh-desktop-restart — Host half.
 *
 * 桌面版（Electron）的进程模型和 `dsh web` 完全不同：
 *
 *   DeepSeek Harness.exe            ← Electron 主进程：窗口、托盘、更新、spawn host
 *     └── DeepSeek Harness.exe      ← host 子进程：同一个 exe，ELECTRON_RUN_AS_NODE=1，
 *           （ELECTRON_RUN_AS_NODE=1）  跑 dsh-desktop-host，监听 127.0.0.1:19387
 *           └── 本插件就在这里
 *
 * 这带来两个后果，它们决定了本插件为什么长这样：
 *
 * 1. host 自己退出并不能重启应用。主进程会把子进程退出当成故障，弹出
 *    「启动失败」恢复框（默认按钮是「重启应用」）——能用，但每次都要人点一下。
 *
 * 2. 主进程没有暴露任何「重启」通道给插件。完整的 IPC 表只有
 *    shutdown / quit-inspection / update-tasks（主进程 → host），
 *    以及 ready / fatal / shutdown-complete / platform-session（host → 主进程）；
 *    渲染进程侧的 DESKTOP_IPC 里也没有 restart。内置的「重启应用与 Host」
 *    菜单项只在 development 下加入菜单，而 Windows 上应用菜单栏只有 devTools，
 *    托盘菜单只有「打开应用」和「退出」。
 *
 * 所以真正的一键重启只能由宿主之外的进程完成：本半只做校验、写一份交接描述，
 * 然后把工作交给一个分离的 helper（见 lib/helper.cjs），由它结束 Electron
 * 主进程 —— host 会因 IPC 断开而自行优雅关闭（会话日志正常落盘）—— 等端口
 * 释放后，用干净的启动环境拉起新的应用实例。
 *
 * ## 动手之前先看清楚状态（2026-10-08）
 *
 * 「能重启」不等于「该重启」。应用自己的退出流程会先问宿主
 * 「现在停掉会打断什么工作」（`hasDesktopActiveTasks`：正在生成或跑工具的
 * 智能体、排队中的消息、正在跑或正在停的后台任务），有就弹窗问用户；
 * 而本插件走的是直接结束主进程，绕过了那道检查。于是补上等价的两道守卫：
 *
 * - **有任务在跑**：复刻应用的判据（`agents` + `jobs` 两个服务），命中就先
 *   只回一份「会打断什么」，要调用方带 `force` 再来一次才真动手。这一类
 *   **只警告**：任务会自己结束，用户看完警告愿意承担就可以继续；
 * - **插件正在安装/更新**：`<profile>/.plugin-manager/run.json` 是应用自己
 *   记「有个 pnpm 运行正在写这个 profile」的凭据（见 @deepseek-ai/dsh-plugin-manager），
 *   记录里的进程**此刻还活着**就**硬拦**，`force` 也不放行 —— 腰斩 pnpm 会把
 *   profile 的依赖树弄成半新半旧，这不是「用户说知道就能继续」的那类风险。
 *
 * 硬拦为什么不会像 2026-10-06 那样把按钮锁死（2026-10-12 第三轮）：判据不是
 * 「记录文件在不在」，而是**记录里那个进程现在还在不在**，用的就是应用自己的
 * 存活判据（`treeAlive`：`process.kill(pid, 0)` 不抛就算活着）。崩溃残留的记录
 * 里进程已经退出，判定立刻是「没在装」，不拦；pnpm 一结束，下一次点击自然放行。
 * 所以这道硬拦的上界是那个进程的寿命，而不是一条会永久留存的记录。
 *
 * ## 顺手清掉别人漏下的临时快照（2026-10-09）
 *
 * DSH 内置的「改动快照」（`@deepseek-ai/dsh-workspace-changes`）每开一个会话就往
 * 系统 Temp 写一个 `dsh-workspace-changes-*` 目录，会话关闭或应用正常退出时删；
 * 被硬杀（任务管理器结束 host、崩溃、断电）就没人删，于是留下孤儿 —— 2026-10-09
 * 的 C 盘体检在 Temp 里清出 25 个这样的目录、共 10.9 GB。
 *
 * 本插件提供启动后预览和手动扫描入口。缺少可靠的活动实例归属凭据时只报告候选，
 * 不删除快照；判定规则与已知边界写在 `lib/sweep.js` 的文件头。
 * 扫描开关在插件设置页控制；自动扫描只预览候选，不删除快照。
 *
 * 安全模型：路由只接受同源 loopback 的 POST（带转发头一律拒绝），非桌面宿主
 * 直接拒绝并说明原因，同一时刻只允许一次重启交接。
 *
 * @module dsh-desktop-restart
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as noticeFs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNoticeStore, processIdentityState, queryApplicationProcesses } from './helper.cjs'

import { MIN_ORPHAN_AGE_MS, sweepOrphanSnapshots } from './sweep.js'

/** 没有 web carrier 就没有路由：这是唯一的硬依赖。 */
export const inject = ['webServer']

/** 本插件拥有的路由。 */
const ROUTE_RESTART = '/dsh-desktop-restart/api/restart'
const ROUTE_STATUS = '/dsh-desktop-restart/api/status'
const ROUTE_SWEEP = '/dsh-desktop-restart/api/sweep'
/**
 * 设置写路由（2026-10-21）：与 `/api/sweep` **共用同一个处理器**。
 * 早先只有扫描一个开关，路径就叫 sweep；现在还有倒计时和诊断操作。
 * 保留旧路径是为了已经装在用户机器上的
 * 客户端不会 404，新客户端直接走 prefs。
 */
const ROUTE_PREFS = '/dsh-desktop-restart/api/prefs'
/** 分离 helper 的绝对路径。 */
const HELPER_PATH = fileURLToPath(new URL('./helper.cjs', import.meta.url))

/** 交接描述与 helper 日志的落盘位置（与 DSH 自己的 home 保持一致）。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'desktop-restart')

/** 交接目录保留的组数：每次重启写一份 handoff + 一份 log，旧的要清掉。 */
const STATE_KEEP = 20

/**
 * 插件设置按 profile 身份隔离；旧 settings.json 仅用于首次迁移，永不改写。
 *
 * 只有**宿主半**需要的开关才写这里：客户端那几个入口的开关存在浏览器本地就够了，
 * 而「启动时扫描快照候选」必须在客户端连上来之前就生效，只能落在宿主这一侧。
 * `cordis.patch.yml` 里的 `config` 给默认值，这个文件放用户改过的值。
 */
const LEGACY_SETTINGS_FILE = join(STATE_DIR, 'settings.json')
const SETTINGS_FILE = join(STATE_DIR, `settings-${profileIdentity(resolveProfileDir())}.json`)

/**
 * 「上次重启」标记（2026-10-21）。
 *
 * 排程重启前写一次：本次交接 nonce、profile/实例标识、发起时间和当时
 * **哪些会话正在干活**。新宿主必须由 helper 带回同一 nonce 才能识别，于是可以
 * ① 给界面一份宿主恢复时间与交接耗时的回执；
 * ② 在插件界面展示 host 恢复回执；不向会话发消息、不恢复模型工作。
 *
 * 旧版仅用时间或 PID 的记录不能证明对应这次重启，故不自动迁移或唤醒。
 */
const RESTART_RECEIPT_WINDOW_MS = 5 * 60 * 1000

/**
 * 启动后多久再扫描快照候选。
 *
 * 让宿主先把启动 I/O（装配插件、读会话）做完；扫描是异步的。
 */
const SWEEP_START_DELAY_MS = 10_000

/**
 * 每个入口的开关名（config 里的同名布尔值，缺省 true）。
 *
 * 用户在插件的 config（`~/.dsh/profiles/<profile>/cordis.patch.yml` 里本插件那一行的
 * `config:`）里可以关掉任意入口；`enabled` 是总开关。客户端那四个入口还会被插件自己的
 * 设置页覆盖（那份存在浏览器本地），所以这里给的是**默认值**。
 */
const ENTRY_KEYS = ['panel', 'footer', 'header', 'command', 'settingsRow', 'accountMenu', 'headerRefresh']

/**
 * 从 config 里读出每个入口的开关。
 * @param {Record<string, unknown>} [config] - 本插件那一行的 config。
 * @returns {{ panel: boolean, footer: boolean, header: boolean, command: boolean, settingsRow: boolean }} 开关。
 */
function readEntries(config = {}) {
  const entries = {}
  for (const key of ENTRY_KEYS) entries[key] = key === 'headerRefresh' ? config[key] === true : config[key] !== false
  return entries
}

/**
 * 读插件自己的设置文件。
 *
 * 读不到、内容坏了、形状不对，一律回空对象 —— 于是全部走 config 给的默认值，
 * 绝不会因为一个坏文件把功能锁死。
 * @param {string} [file] - 设置文件路径（测试传临时路径）。
 * @returns {Record<string, unknown>} 设置。
 */
function readSettings(file = SETTINGS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * 合并写插件设置（临时文件 + 改名，读者要么见旧完整文件、要么见新完整文件）。
 *
 * 写不进去时静默返回「没改成」的结果：设置写失败不该让宿主出问题。
 * @param {Record<string, unknown>} patch - 要改的字段。
 * @param {string} [file] - 设置文件路径（测试传临时路径）。
 * @returns {Record<string, unknown>} 写入后的设置（失败时是写入前的值）。
 */
function writeSettingsChecked(patch, file = SETTINGS_FILE) {
  const next = { ...readSettings(file), ...patch }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, value: next }
  } catch (error) {
    return { ok: false, value: readSettings(file), error }
  }
}

function writeSettings(patch, file = SETTINGS_FILE) {
  return writeSettingsChecked(patch, file).value
}

/** helper 在动手前的等待时间，让 HTTP 响应先送达浏览器。 */
const HANDOFF_DELAY_MS = 1500

/**
 * 由「上次重启」标记判断这次启动是不是一次重启，并算出回执。
 * @param {unknown} marker - profile 专属 `last-restart-<profile>.json` 的内容。
 * @param {number} bootPid - 当前宿主 pid。
 * @param {number} nowMs - 当前时刻。
 * @returns {{ at: string, downtimeMs: number, sessions: string[] } | null} 回执；不是重启时为 null。
 */
function profileIdentity(profileDir) {
  const identity = typeof profileDir === 'string' ? profileDir.replaceAll('\\', '/').toLowerCase() : ''
  return createHash('sha256').update(identity).digest('hex')
}

function restartReceipt(marker, restartId, profileId, instanceId, nowMs) {
  if (marker === null || typeof marker !== 'object' || marker.schema !== 1) return null
  if (typeof restartId !== 'string' || restartId === '' || marker.restartId !== restartId) return null
  if (typeof profileId !== 'string' || marker.profileId !== profileId) return null
  if (typeof instanceId !== 'string' || marker.instanceId !== instanceId) return null
  if (marker.status !== 'pending') return null
  const at = typeof marker.requestedAt === 'string' ? marker.requestedAt : ''
  const atMs = Date.parse(at)
  if (!Number.isFinite(atMs) || nowMs < atMs || nowMs - atMs > RESTART_RECEIPT_WINDOW_MS) return null
  return { restartId, profileId, requestedAt: at, hostReadyAt: new Date(nowMs).toISOString(), downtimeMs: nowMs - atMs }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    return true
  } catch {
    try { unlinkSync(temporary) } catch { /* absent */ }
    return false
  }
}

/**
 * helper 探活的两轮等待（毫秒）：先短后长。
 *
 * 不用一个固定的长延时：负载高时 helper 可能启动得慢，一轮就判死会误伤；
 * 分两轮，它中途起来了也算活着。
 */
const HELPER_PROBE_WAITS_MS = [300, 700]

/**
 * 一次交接的总兜底时限。
 *
 * helper 正常情况下 1.5 秒后就结束主进程，应用随即重启，进程没了标志自然重置。
 * 但如果 helper 卡住、或主进程没被杀掉，应用并不会重启 —— 那时必须允许重试，
 * 否则标志会永久停在「已经有一次重启在交接中」，而解除它恰恰需要重启应用，
 * 形成死锁。
 */
// 一次交接的**结果未知**时限（不再用于强行放行）：helper 各阶段自身有上限
// （停止 15s / 端口 30s / 就绪 20s 等），这里给整体留足余量。
const HANDOFF_DEADLINE_MS = 240_000
// Cover one 2s UI poll without reusing identity evidence past the handoff budget.
const HELPER_IDENTITY_CACHE_MS = 3000

/**
 * 「等空闲再重启」的轮询间隔与最长等待（2026-10-20 B 项）。
 *
 * 守卫说「有任务在跑」时，用户可以选择等它们自然结束再重启：宿主半挂一个
 * 轮询，一旦守卫安静（任务与安装都结束）就按既定路径重启。间隔 5 秒足够
 * 及时（重启不是分秒必争的事）；上限 30 分钟防止无限挂起——超过就放弃并
 * 记日志，用户重新点就是。
 */
const WAIT_POLL_MS = 5_000
const WAIT_MAX_MS = 30 * 60 * 1000

/**
 * 本插件自己的版本号（`package.json` 的 `version`）。
 *
 * 状态路由把它带给界面：排查「装的哪一版」时一眼可见，不必翻 node_modules。
 * 读不到时是 null —— 状态路由照样工作，只是不带这个字段。
 */
const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    return null
  }
})()

/**
 * 当前平台是否不受支持（2026-10-20 C 项）。
 *
 * helper 结束/拉起进程依赖 Windows 的 `tasklist` / `taskkill`；在其他平台上
 * 与其让重启走到一半才以晦涩的方式失败，不如在入口就说明白。dsh web 上
 * 原本就有「不是桌面版」的拒绝，这里补的是「是桌面版但平台不对」的那一句。
 * @param {string} [platform] - 平台标识（可注入，便于测试）。
 * @returns {string | null} 不支持时的说明；支持时为 null。
 */
function platformUnsupported(platform = process.platform) {
  if (platform === 'win32') return null
  return `本插件的重启助手依赖 Windows 的 PowerShell/CIM 与 taskkill，当前平台是 ${platform}；这一版只在 Windows 桌面版上验证过`
}

/**
 * 「等空闲」的一轮判定（纯函数，单测直接打）。
 * @param {{ active: boolean }} guard - 守卫快照。
 * @param {number} sinceMs - 挂起等待的时刻。
 * @param {number} nowMs - 当前时刻。
 * @param {number} [maxMs] - 最长等待。
 * @returns {'restart' | 'keep' | 'timeout'} 该重启 / 继续等 / 放弃。
 */
function waitingDecision(guard, sinceMs, nowMs, maxMs = WAIT_MAX_MS) {
  // F3（2026-10-23）：总期限优先于“当前是否空闲”，否则等满 30 分钟后
  // 任务恰好结束时会照样重启，违背界面“到期取消、明确没有执行”的承诺。
  if (Number.isFinite(sinceMs) && Number.isFinite(nowMs) && nowMs - sinceMs >= maxMs) return 'timeout'
  if (guard?.active !== true) return 'restart'
  return 'keep'
}

/**
 * 交接 helper 是否还活着。
 *
 * `spawn` 只表示「创建进程的请求发出去了」：helper 立刻崩掉（例如可执行文件
 * 不可运行）同样是成功返回。所以按 {@link HELPER_PROBE_WAITS_MS} 探两轮，
 * 信号 0 能送到就说明它挺过了启动；两轮都不在，这次交接根本没开始，调用方
 * 应当如实报错并允许重试。
 * @param {number | undefined} pid - helper 的 pid。
 * @returns {Promise<boolean>} 还活着时为 true。
 */
async function helperAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  for (const wait of HELPER_PROBE_WAITS_MS) {
    await new Promise((resolve) => { setTimeout(resolve, wait) })
    try {
      process.kill(pid, 0)
      return true
    } catch {
      /* 还没起来，或已经死了：进入下一轮 */
    }
  }
  return false
}

/**
 * 判断当前 host 是否跑在 Electron 桌面壳下，并取出重启所需的目标。
 *
 * 判据全部来自进程本身，不依赖任何环境变量约定：
 * - `ELECTRON_RUN_AS_NODE=1`：说明这个「node」其实是一个 Electron 可执行文件；
 * - `process.execPath` 的 basename 不是 node：排除普通的 Node 宿主；
 * - `process.ppid` 是主进程：桌面壳 spawn host 时就是父子关系。
 *
 * 任何一条不成立都返回 null，插件于是只注册状态路由、拒绝重启，绝不误杀进程。
 * @returns {{ mainPid: number, exe: string, hostPid: number } | null} 重启目标，或 null。
 */
function desktopTarget() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null
  const exe = process.execPath
  if (typeof exe !== 'string' || exe === '') return null
  const name = basename(exe).toLowerCase()
  if (name === 'node' || name === 'node.exe') return null
  const mainPid = process.ppid
  if (!Number.isInteger(mainPid) || mainPid <= 1) return null
  return { mainPid, exe, hostPid: process.pid }
}

/** Host 头是否指向回环地址（含 IPv6 字面量写法）。 */
function isLoopbackHost(host) {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** TCP 对端是否就是本机。 */
function loopbackPeer(req) {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 桌面壳转发过来的请求是否可以信任。
 *
 * 桌面版的页面是以 `dsh-app://` 协议装载的，页面里的 `fetch('/…')` 由壳层
 * 转发到 host 的 HTTP 端口 —— 这种转发的请求**没有 Origin 头**。所以无
 * Origin 不能直接判为不可信，而是要求其余每一条都成立：没有代理痕迹、
 * Host 是回环名字、TCP 对端是回环地址，且 `Sec-Fetch-Site` 缺省或就是
 * same-origin（跨站请求会被浏览器标成 cross-site，据此挡掉）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 可信任时为 true。
 */
function desktopForwarded(req) {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const host = req.headers.host
  if (host === undefined || !isLoopbackHost(host)) return false
  return loopbackPeer(req)
}

/**
 * 请求是否来自可信的调用方。
 *
 * 两种可信形态：浏览器直接发来的同源请求（Origin 正好是本次请求的
 * authority），或桌面壳转发来的请求（见 {@link desktopForwarded}）。
 * 两者都要求 TCP 对端是回环地址。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 可信时为 true。
 */
function trustedRequest(req) {
  if (!loopbackPeer(req)) return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return desktopForwarded(req)
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * 平台的浏览器信任栅栏 + 浏览器鉴权（本插件的第二道门，2026-10-15 补）。
 *
 * DSH 自己用 `@deepseek-ai/dsh-client-connection` 的 `api-request-trust` 挡 `/api`：
 * Host 必须是回环（或部署声明的受信主机）、带 Origin 时必须与 Host 相等、
 * `sec-fetch-site: cross-site` 直接拒；过了栅栏但**没带浏览器 cookie** 的请求回 401。
 * 平台把这两步原样开放给插件路由：
 * `ctx.connection.requestRejection(request) -> 401 | 403 | undefined`。
 *
 * 本插件原先只做了栅栏那一半（{@link trustedRequest}），而且为了兼容桌面壳
 * 转发的「无 Origin」请求把口子开大 —— 于是一个普通本机进程不带任何头就能发号
 * 施令（2026-10-15 实测：`curl` 打到只读的 status 路由回 200）。这里补上缺失的
 * 浏览器鉴权那一半：不带头、不带会话 cookie 的本机进程会被挡在 401。
 *
 * 取不到 `connection`（组合里没有它）时回 `available: false`，调用方退回原先
 * 那套自检 —— 这条依赖是**可选**的，绝不让插件在缺它的组合里起不来。
 * @param {{ get?: (name: string) => unknown }} ctx - host 上下文。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {{ available: boolean, verdict: 401 | 403 | null, error: string | null }} 判定。
 */
function platformFence(ctx, req) {
  let connection
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  } catch (error) {
    return { available: false, verdict: null, error: String((error && error.message) || error) }
  }
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
    return { available: false, verdict: null, error: '本组合缺少平台鉴权服务，重启功能已禁用' }
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch (error) {
    return { available: true, verdict: null, error: String((error && error.message) || error) }
  }
  if (rejection === 401 || rejection === 403) return { available: true, verdict: rejection, error: null }
  return { available: true, verdict: null, error: null }
}

/**
 * 把平台的拒绝判定翻成一句人话（区分 401 与 403，两者的修法不同）。
 * @param {{ verdict: 401 | 403 | null }} fence - {@link platformFence} 的判定。
 * @param {string} what - 被拒的操作名。
 * @returns {string} 给界面显示的说明。
 */
function describeFenceRefusal(fence, what) {
  return fence.verdict === 401
    ? `${what}需要浏览器的会话凭据，而这个请求没有带上 —— 不带 cookie 的本机进程会被挡在这里。请从 DeepSeek Harness 的页面里操作。`
    : `${what}被平台的信任栅栏拒绝：Host / Origin 或跨站标记不符。`
}

/**
 * 请求是否显式要求「我知道有东西在跑，照样重启」。
 *
 * 用查询参数而不是请求体：桌面壳转发页面 fetch 时只保证 URL 与头部到达，
 * 走 body 会平白多一种失败形态，而这里需要的东西只有一个布尔值。
 * @param {string | undefined} url - `req.url`。
 * @returns {boolean} 带 `?force=1` 时为 true。
 */
function forceRequested(url) {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('force') === '1'
  } catch {
    return false
  }
}

/**
 * 请求是否要求「等空闲再重启」（挂起等待，守卫安静后自动执行）。
 * @param {string | undefined} url - `req.url`。
 * @returns {boolean} 默认 true：这是兼容既有“默认等空闲”的策略，不是参数是否出现的检测。
 */
function shouldWaitForIdle(url) {
  // 2026-10-22 用户决定：**默认先等空闲**再重启，避免把正在生成的回合拦腰砍断。
  // 显式跳过用 `?now=1`（界面上「仍要立即重启」会带上），`?wait=0` 等价；
  // `?wait=1` 仍然表示「明确要求等待」。
  try {
    const params = new URL(url ?? '/', 'http://127.0.0.1').searchParams
    if (params.get('now') === '1') return false
    if (params.get('wait') === '0') return false
    return true
  } catch {
    return true
  }
}

/**
 * 请求是否要求取消挂起的「等空闲再重启」。
 * @param {string | undefined} url - `req.url`。
 * @returns {boolean} 带 `?cancelWait=1` 时为 true。
 */
function cancelWaitRequested(url) {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('cancelWait') === '1'
  } catch {
    return false
  }
}

/**
 * 一个目录是不是可用的 profile 目录。
 *
 * 只认同时具备 `package.json` 与 `node_modules` 的目录：桌面宿主把它当
 * argv 传进来，`dsh web` 下同样的位置是别的东西，猜错就会去读错文件。
 * @param {unknown} candidate - 待检查的路径。
 * @returns {string | null} 可用时返回该路径，否则 null。
 */
function validProfileDir(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return null
  try {
    if (!statSync(candidate).isDirectory()) return null
    if (!existsSync(join(candidate, 'package.json'))) return null
    if (!existsSync(join(candidate, 'node_modules'))) return null
    return candidate
  } catch {
    return null
  }
}

/**
 * 定位当前 profile 目录（用于查「有没有安装正在进行」）。
 * @returns {string | null} 目录，或 null（定位不到时守卫静默跳过）。
 */
function resolveProfileDir() {
  return validProfileDir(process.env.DSH_PROFILE_DIR)
    ?? validProfileDir(process.argv[3])
    ?? validProfileDir(join(DSH_HOME, 'profiles', 'desktop'))
}

/**
 * 记录里的那次运行，现在还活着吗。
 *
 * 判据照抄应用自己（@deepseek-ai/dsh-plugin-manager 的 `treeAlive`）：
 * `process.kill(pid, 0)` 不抛就算活着。Windows 上记录里的 `grouped` 一直是
 * false（不另起进程组），那个 pid 就是 pnpm 本身；POSIX 上 grouped 为真时
 * 要探测整个进程组，用负号。
 *
 * 抛异常一律按「已经没了」处理 —— 与上游一致（它也把 ESRCH/EPERM 当成不在），
 * 免得两边的判断打架。
 * @param {{ pid?: number | null, grouped?: boolean }} run - 记录内容。
 * @returns {boolean} 还活着返回 true。
 */
function runAlive(run) {
  const pid = run?.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  const target = run.grouped === true && process.platform !== 'win32' ? -pid : pid
  try {
    process.kill(target, 0)
    return true
  } catch {
    return false
  }
}

/**
 * profile 上是否有一个 pnpm 运行**正在**写它。
 *
 * 凭据是应用自己的 `.plugin-manager/run.json`：每次包操作开始时写下、结束时
 * 删除（见 @deepseek-ai/dsh-plugin-manager 的 recordRun），内容是
 * `{ pid, grouped }`。但「记录还在」不等于「还在装」—— 应用被硬杀或崩溃时
 * 记录会留存（应用自己发现后会等 5 秒，然后删掉它）。所以这里再问一句：
 * **记录里的那个进程现在还在不在**。
 *
 * - 进程活着 → 真在装，`blocked: true`，调用方应当硬拦；
 * - 进程已退出 → 崩溃残留，`active: false`，不该拿它拦人；
 * - 读不出 pid（文件半截、格式变了）→ 判不了，`active: true` 但
 *   `blocked: false`，只警告、可 force，宁可多问一次。
 *
 * 只读不写：本插件不删别人的记录（应用自己会清）。定位不到 profile 时返回
 * `known: false`，调用方静默跳过守卫。
 * @param {string | null} dir - profile 目录。
 * @returns {{ known: boolean, active: boolean, blocked: boolean, running: boolean, pid: number | null, record: string | null }} 状态。
 */
function installInProgress(dir) {
  const absent = { known: true, active: false, blocked: false, running: false, pid: null, record: null }
  if (dir === null) return { ...absent, known: false }
  const record = join(dir, '.plugin-manager', 'run.json')
  if (!existsSync(record)) return absent
  let pid = null
  let grouped = false
  try {
    const parsed = JSON.parse(readFileSync(record, 'utf8'))
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pid = parsed.pid
    grouped = parsed?.grouped === true
  } catch {
    /* 读不动或内容坏了：判不了，按「有记录」处理，只警告 */
  }
  if (pid === null) return { known: true, active: true, blocked: false, running: false, pid: null, record }
  if (!runAlive({ pid, grouped })) {
    // 进程已经退出：这是崩溃/硬杀留下的残留记录，不该拿它拦人。
    return { known: true, active: false, blocked: false, running: false, pid, record }
  }
  return { known: true, active: true, blocked: true, running: true, pid, record }
}

/**
 * 现在停掉宿主会打断什么工作。
 *
 * 判据复刻应用自己的 `hasDesktopActiveTasks`：有正在生成/跑工具的智能体、
 * 有排队消息、或有正在跑/正在停的后台任务。`agents` 与 `jobs` 都是可选
 * 服务，取不到或列表不可判读就回 `known: false`；普通请求继续等待，
 * 显式强制仍须经过安装和实例身份硬守卫。
 * @param {{ get?: (name: string) => unknown }} ctx - host 上下文。
 * @returns {{ known: boolean, active: boolean, turns: number, queued: number, jobs: number, sessions: number }} 快照。
 */
function taskSnapshot(ctx) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined
    if (agents === undefined || jobs === undefined) return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    if (typeof agents?.list !== 'function' || typeof jobs?.list !== 'function') return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    const live = agents.list()
    if (!Array.isArray(live)) return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    let turns = 0
    let queued = 0
    for (const agent of live) {
      if (agent?.status === 'running') turns += 1
      const inbox = agent?.inbox
      const nextTurn = Array.isArray(inbox?.nextTurn) ? inbox.nextTurn.length : 0
      const nextStep = Array.isArray(inbox?.nextStep) ? inbox.nextStep.length : 0
      if (nextTurn > 0 || nextStep > 0) queued += 1
    }
    let running = 0
    // 第一个 undefined 是全局花名册，后面每个是各会话自己的任务 —— 与应用的写法一致。
    for (const agent of [undefined, ...live]) {
      const list = jobs.list(agent?.id)
      if (!Array.isArray(list)) return { known: false, active: turns > 0 || queued > 0 || running > 0, turns, queued, jobs: running, sessions: live.length }
      for (const job of list) if (job?.status === 'running' || job?.status === 'stopping') running += 1
    }
    return { known: true, active: turns > 0 || queued > 0 || running > 0, turns, queued, jobs: running, sessions: live.length }
  } catch {
    return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
  }
}

/**
 * 把「会打断什么」写成一句人话。
 * @param {ReturnType<typeof taskSnapshot>} tasks - 任务快照。
 * @param {ReturnType<typeof installInProgress>} installs - 安装状态。
 * @returns {string[]} 逐条原因；没有则空数组。
 */
function guardReasons(tasks, installs) {
  const reasons = []
  if (tasks.known && tasks.active) {
    const parts = []
    if (tasks.turns > 0) parts.push(`${String(tasks.turns)} 项正在生成或运行工具`)
    if (tasks.queued > 0) parts.push(`${String(tasks.queued)} 个会话有排队消息`)
    if (tasks.jobs > 0) parts.push(`${String(tasks.jobs)} 个后台任务在跑`)
    reasons.push(`有任务在跑（${parts.join('、')}）`)
  }
  if (installs.active) {
    reasons.push(installs.running === true
      ? '插件正在安装或更新（记录里的进程还在跑）'
      : '插件目录上留着一条安装记录，但读不出是哪个进程（无法确认是否还在装）')
  }
  return reasons
}

/**
 * 一次守卫检查。
 * @param {{ get?: (name: string) => unknown }} ctx - host 上下文。
 * @param {string | null} dir - profile 目录。
 * @returns {{ active: boolean, reasons: string[], tasks: object, installs: object }} 守卫结果。
 */
function guardSnapshot(ctx, dir) {
  const tasks = taskSnapshot(ctx)
  const installs = installInProgress(dir)
  const reasons = guardReasons(tasks, installs)
  return { active: reasons.length > 0, reasons, tasks, installs }
}

/**
 * 交接目录只保留最近 {@link STATE_KEEP} 组。
 *
 * 每次重启写一份 handoff 与一份 log，从来不清就是无限增长。按文件名里的
 * 时间戳分组（同一组的两个文件同名不同后缀），旧的整组删掉。
 * @param {string} dir - 交接目录。
 */
function pruneState(dir) {
  try {
    const stamps = new Set()
    for (const name of readdirSync(dir)) {
      const match = /^(?:handoff|restart)-(.+)\.(?:json|log)$/u.exec(name)
      if (match !== null) stamps.add(match[1])
    }
    for (const stamp of [...stamps].sort().reverse().slice(STATE_KEEP)) {
      for (const name of [`handoff-${stamp}.json`, `restart-${stamp}.log`]) {
        try {
          unlinkSync(join(dir, name))
        } catch {
          /* 已经被删掉或本来就没有 */
        }
      }
    }
    // Retire only completed records, per profile. Pending/unknown operations and
    // records referenced by unread diagnostics are evidence, not cleanup targets.
    const names = readdirSync(dir)
    const profiles = new Map()
    for (const name of names) {
      if (!/^op-[a-zA-Z0-9-]+\.json$/u.test(name)) continue
      const op = readSettings(join(dir, name))
      if (op.schema !== 1 || name !== `op-${op.id}.json`
        || !['ok', 'failed'].includes(op.result) || !Number.isFinite(Date.parse(op.updatedAt))) continue
      const unread = names.some(notice => notice.startsWith('notice-')
        && (notice.endsWith(`-${op.id}-failed.json`) || notice.endsWith(`-${op.id}-unknown.json`))
        && !existsSync(join(dir, notice.slice(0, -5) + '.read')))
      if (unread) continue
      if (typeof op.profileId !== 'string') {
        if (Date.now() - Date.parse(op.updatedAt) > 7 * 86400000) unlinkSync(join(dir,name))
        continue
      }
      if (!profiles.has(op.profileId)) profiles.set(op.profileId, [])
      profiles.get(op.profileId).push({ name, at: Date.parse(op.updatedAt) })
    }
    for (const records of profiles.values()) {
      records.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
      for (const record of records.slice(STATE_KEEP)) unlinkSync(join(dir, record.name))
    }
  } catch {
    /* 清理失败不该拖累重启 */
  }
}

/**
 * 写交接描述，并拉起分离的 helper。
 *
 * helper 用 `process.execPath`（就是桌面应用本身）加 `ELECTRON_RUN_AS_NODE=1`
 * 启动，因此不依赖系统 Node、也不依赖 `dsh` 在 PATH 里。
 * @param {{ mainPid: number, exe: string, hostPid: number }} target - 重启目标。
 * @param {number | null} port - host 正在监听的端口，helper 会等它释放。
 * @param {string} restartId - 由新 Host 回传的单次重启 nonce。
 * @returns {{ hostPid: number, mainPid: number, helperPid: number | undefined, logPath: string }} 交接结果。
 */
/**
 * 一次重启的操作记录（2026-10-21 DR-OPT-02 第 1 项）。
 *
 * 一份最小状态机，**helper 推进、宿主与界面读同一份** —— 202 之后 helper 若
 * 拒绝或失败，界面能拿到结论，而不是停在「已排程」。
 * 阶段：scheduled → verify → stop → port-wait → launch → ready → done
 * 结果：pending | ok | failed | unknown（unknown = 结果未知，需人工核对）
 * 只放脱敏信息：不回写命令行、凭据、完整私有路径。
 */
const OP_SCHEMA = 1
/** 各阶段允许出现在摘要里的键名。 */
const OP_STAGES = ['verify', 'stop', 'portWait', 'launch', 'ready']

function opFileOf(restartId) {
  return join(STATE_DIR, `op-${String(restartId)}.json`)
}

/** 读操作记录；形状不对就当作没有（不猜）。 */
function readOp(restartId) {
  const value = readSettings(opFileOf(restartId))
  if (value === null || typeof value !== 'object' || value.id !== restartId) return null
  return value
}

/** 合并写操作记录（原子改名），并盖上更新时间。 */
function patchOp(restartId, patch) {
  const previous = readOp(restartId) ?? {}
  // stages 逐次合并：阶段的耗时是一条条追加进来的，整块覆盖会把先前的值吃掉。
  const stages = { ...(previous.stages ?? {}), ...(patch.stages ?? {}) }
  const next = { ...previous, ...patch, stages, id: restartId, schema: OP_SCHEMA, updatedAt: new Date().toISOString() }
  return writeJsonAtomic(opFileOf(restartId), next) ? next : null
}

/**
 * 脱敏摘要：只给阶段、结果、原因码与阶段耗时。
 * @param {Record<string, unknown> | null} op - 操作记录。
 * @param {number} nowMs - 当前时刻。
 * @returns {Record<string, unknown> | null} 摘要。
 */
function opSummary(op, nowMs) {
  if (op === null) return null
  const startedAtMs = Date.parse(String(op.startedAt ?? ''))
  const rawStages = op.stages !== null && typeof op.stages === 'object' ? op.stages : {}
  const stages = {}
  for (const key of OP_STAGES) {
    const value = Number(rawStages[key])
    if (Number.isFinite(value) && value >= 0) stages[key] = Math.round(value)
  }
  const result = op.result === 'ok' || op.result === 'failed' || op.result === 'unknown' ? op.result : 'pending'
  return {
    id: String(op.id),
    phase: typeof op.phase === 'string' ? op.phase.slice(0, 32) : 'unknown',
    result,
    reason: typeof op.reason === 'string' ? op.reason.slice(0, 64) : null,
    stages,
    ageMs: Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null,
    argsPreserved: op.argsPreserved === true,
    // 是否用进程身份（而不只是 PID 存活）确认过 helper；查询做不到时保持 false，
    // 界面据此不说「已退出」这种没证据的话。
    helperVerified: op.helperVerified === true,
    // 记录缺失/损坏等需要人工核对的情形
    needsManualCheck: op.needsManualCheck === true,
  }
}

/**
 * 把扫描模块的结果折成宿主摘要（DR-OPT-02-v3 问题 2）。
 *
 * 这里**必须**保留 error / partial / prefiltered：上一版把它们丢了，导致
 * 「读不到 Temp」在 API 上长得像「扫描 0 项、一切正常」。
 * @param {Record<string, unknown>} result - sweepOrphanSnapshots 的返回。
 * @returns {Record<string, unknown>} 给 API 与界面用的摘要。
 */
function sweepSummaryOf(result) {
  const failed = Array.isArray(result.failed) ? result.failed : []
  const candidates = Array.isArray(result.candidates) ? result.candidates : []
  const skipped = Array.isArray(result.skipped) ? result.skipped : []
  const error = result.error !== null && typeof result.error === 'object'
    ? { code: String(result.error.code ?? 'scan-failed') }
    : null
  return {
    at: new Date().toISOString(),
    scanned: Number(result.scanned) || 0,
    removed: Array.isArray(result.removed) ? result.removed.length : 0,
    failed: failed.length,
    bytes: Number(result.bytes) || 0,
    candidateCount: candidates.length,
    candidateBytes: Number(result.preview?.bytes) || 0,
    skippedCount: skipped.length,
    skipReason: typeof result.skipReason === 'string' ? result.skipReason : null,
    // 下面三个是这一轮补的：错误、部分完成、早筛计数
    error,
    partial: result.partial === true,
    prefiltered: Number(result.prefiltered) || 0,
  }
}

// One lock per DSH_HOME, shared by all profiles. Unknown liveness stays locked.
const RESTART_LOCK = join(STATE_DIR, 'restart.lock')
function releaseRestartLock(token) {
  try {
    const record = JSON.parse(readFileSync(RESTART_LOCK, 'utf8'))
    if (record.token === token) unlinkSync(RESTART_LOCK)
  } catch (error) { if (error.code !== 'ENOENT') console.error('restart lock release failed:', error) }
}
function acquireRestartLock(token) {
  mkdirSync(STATE_DIR, {recursive:true})
  const record = {pid:process.pid, at:new Date().toISOString(), token}
  const create = () => writeFileSync(RESTART_LOCK, JSON.stringify(record), {flag:'wx'})
  try { create(); return {ok:true} }
  catch (error) { if (error.code !== 'EEXIST') return {ok:false,status:500,error:'无法保存跨实例重启锁'} }
  const recovery = RESTART_LOCK + '.recovery'
  try { writeFileSync(recovery, String(process.pid), {flag:'wx'}) }
  catch (error) { return {ok:false,status:error.code === 'EEXIST' ? 409 : 500,error:'另一实例正在重启或检查重启锁'} }
  try {
    const old = JSON.parse(readFileSync(RESTART_LOCK, 'utf8'))
    if (!Number.isInteger(old.pid) || old.pid <= 1) return {ok:false,status:409,error:'重启锁身份无法核实，请人工检查'}
    try { process.kill(old.pid, 0); return {ok:false,status:409,error:'另一实例正在重启'} }
    catch (error) { if (error.code !== 'ESRCH') return {ok:false,status:409,error:'另一实例重启锁的进程状态无法核实'} }
    unlinkSync(RESTART_LOCK)
    create()
    console.warn('stale restart lock taken over:', old.pid, old.at)
    return {ok:true,stale:true}
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { create(); return {ok:true} } catch (cause) { return {ok:false,status:cause.code === 'EEXIST' ? 409 : 500,error:'另一实例正在重启，或无法写入重启锁'} }
    }
    return {ok:false,status:error.code === 'EEXIST' ? 409 : 500,error:'无法安全接管重启锁'}
  } finally { unlinkSync(recovery) }
}

function scheduleRestart(target, port, restartId, authCookie) {
  mkdirSync(STATE_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const logPath = join(STATE_DIR, `restart-${stamp}.log`)
  const handoffPath = join(STATE_DIR, `handoff-${stamp}.json`)
  writeFileSync(handoffPath, JSON.stringify({
    authCookie,
    restartLock: {path:RESTART_LOCK, token:restartId},
    mainPid: target.mainPid,
    exe: basename(target.exe),
    exeFromEnv: true,
    hostPid: target.hostPid,
    port: port ?? null,
    logPath,
    handoffPath,
    restartId,
    profileId: profileIdentity(resolveProfileDir()),
    opPath: opFileOf(restartId),
    delayMs: HANDOFF_DELAY_MS,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  // 裁剪必须在写入之后：新写下的这一组也要占一个保留名额，目录才会稳定在
  // STATE_KEEP 组。旧的顺序是先裁后写，于是每次都多留一组（实测 21 而不是 20）。
  pruneState(STATE_DIR)

  const helper = spawn(process.execPath, [HELPER_PATH, handoffPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(HELPER_PATH),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_RESTART_EXE: target.exe },
  })
  // Bind the lock to the child immediately, including a child that dies before
  // it reaches performRestart. Its dead PID can then be recovered by another host.
  if (Number.isInteger(helper.pid)) {
    try {
      const record = JSON.parse(readFileSync(RESTART_LOCK, 'utf8'))
      if (record.token === restartId && !writeJsonAtomic(RESTART_LOCK, {...record,pid:helper.pid})) {
        console.error('restart lock child PID could not be persisted; helper will verify ownership before stopping the app')
      }
    } catch (error) { if (error.code !== 'ENOENT') console.error('restart lock child PID update failed:', error) }
  }
  helper.unref()
  return {
    hostPid: target.hostPid,
    mainPid: target.mainPid,
    helperPid: helper.pid,
    logPath,
  }
}

/**
 * 挂载插件：状态、重启、预览设置三条路由，外加斜杠命令。
 *
 * 启动时（`config.sweep` 启用、且用户没在设置里关掉）还会异步预览快照候选，
 * 见 lib/sweep.js。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host 上下文。
 * @param {{ enabled?: boolean, sweep?: boolean }} [config] - 本插件那一行的 config。
 */
export function apply(ctx, config = {}) {
  const target = desktopTarget()
  const enabled = config.enabled !== false
  const profileDir = resolveProfileDir()
  const profileId = profileIdentity(profileDir)
  const instanceId = target === null ? null : createHash('sha256')
    .update(`${profileId}\0${target.exe.replaceAll('\\', '/').toLowerCase()}`)
    .digest('hex')
  const settingsFile = join(STATE_DIR, `settings-${profileId}.json`)
  const settingsMigrationMarker = join(STATE_DIR, `settings-migrated-${profileId}`)
  let settingsMigrated = existsSync(settingsMigrationMarker)
  let settingsMigrationError = null
  if (!settingsMigrated && (existsSync(settingsFile) || existsSync(LEGACY_SETTINGS_FILE))) {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      if (!existsSync(settingsFile)) {
        try { writeFileSync(settingsFile, readFileSync(LEGACY_SETTINGS_FILE, 'utf8'), { encoding: 'utf8', flag: 'wx' }) }
        catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      // Adopt an existing profile file without rewriting it; persist the one-time decision.
      try { writeFileSync(settingsMigrationMarker, '1\n', { encoding: 'utf8', flag: 'wx' }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      settingsMigrated = true
    } catch (error) {
      settingsMigrationError = typeof error.code === 'string' ? error.code : 'migration-failed'
    }
  }
  const notices = createNoticeStore({ dir: STATE_DIR, profileId, io: noticeFs })
  const restartMarkerFile = join(STATE_DIR, `last-restart-${profileId}.json`)
  const restartId = process.env.DSH_DESKTOP_RESTART_ID
  // 是否把平台的「浏览器鉴权」也当作门（见 {@link platformFence}）。缺省强制：
  // 只做信任栅栏不做鉴权，等于对本机任意进程敞开。组合里没有 connection 服务时
  // 这条自动退化成「不适用」，仍走下面的自检。
  const platformAuth = config.platformAuth !== false
  // 当前占着互斥的 restartId（null = 没有进行中的重启）。互斥是否释放由
  // helper 生命周期与操作记录决定，不再靠一个固定时间到的布尔值。
  //
  // 恢复（F2 返修）：同一进程内 reapply/HMR 必须记得仍在跑的 helper，所以互斥
  // 记在进程级登记表里（按 profile 分键）；新宿主则用启动环境里的 restartId
  // 找回磁盘记录 —— 两者都只认本 profile 自己的记录。
  const opRegistry = (globalThis.__dshDesktopRestartOps ??= new Map())
  const helperStateCache = new Map()
  // 初值在读到 restartId 之后设置（它声明在下面），避免暂时性死区。
  let currentOp = opRegistry.get(profileId) ?? null
  // F2：新宿主用启动环境里的 restartId 找回磁盘操作；HMR 复用进程级登记表。
  if (currentOp === null && typeof restartId === 'string' && restartId !== '') currentOp = restartId
  if (currentOp !== null) opRegistry.set(profileId, currentOp)
  // 最近一次操作摘要：释放后仍保留，界面据此显示失败/未知结果或可重试。
  let lastOp = null

  /** PID existence alone is insufficient: compare the helper's CIM creation identity. */
  function helperProcessState(op) {
    const identity = op?.helperIdentity
    if (target === null || !Number.isInteger(op?.pid) || op.pid <= 0
      || !Number.isInteger(op.hostPid) || op.hostPid <= 1
      || identity?.pid !== op.pid || identity.parentPid !== op.hostPid
      || !Number.isInteger(identity.parentPid) || identity.parentPid <= 1
      || typeof identity.createdAt !== 'string' || !Number.isFinite(Date.parse(identity.createdAt))
      || typeof identity.path !== 'string'
      || identity.path.replaceAll('/', '\\').toLowerCase() !== target.exe.replaceAll('/', '\\').toLowerCase()) {
      return { alive: null, verified: false }
    }
    const cacheKey = `${identity.pid}:${identity.createdAt}`
    const cached = helperStateCache.get(cacheKey)
    const now = Date.now()
    const operationDeadline = Date.parse(op.startedAt) + HANDOFF_DEADLINE_MS
    if (cached !== undefined && now >= cached.at && now - cached.at < HELPER_IDENTITY_CACHE_MS
      && now < operationDeadline) return cached.state
    const processes = queryApplicationProcesses(basename(target.exe))
    if (processes === null) {
      const state = { alive: null, verified: false }
      helperStateCache.set(cacheKey, { at: Date.now(), state })
      return state
    }
    const identityState = processIdentityState(processes, identity)
    const state = identityState === 'unknown'
      ? { alive: null, verified: false }
      : { alive: identityState === 'same', verified: true }
    helperStateCache.set(cacheKey, { at: Date.now(), state })
    return state
  }

  // ── 「等空闲再重启」（2026-10-20 B 项）────────────────────────────────────
  // 守卫说「有任务在跑」时，用户可以选等它们自然结束：这里挂一个轮询，
  // 守卫安静（任务与安装都结束）后按既定路径重启。`waiting` 为 null 表示
  // 没有挂起的等待。应用一旦退出（含本插件触发的重启），这份状态随之消失 ——
  // 等待只属于当前进程，重启后自然无需延续。
  let restartRequest = null
  let requestTimer = null

  /**
   * 读当前操作状态，并顺带处理「超预算」与「可以释放」。
   *
   * 释放规则（DR-OPT-02 第 2 项）：只有结果终态、或结果未知但 helper **已确认退出**
   * 时才释放。helper 还活着就继续占着 —— 不能因为固定时间到了就允许另一个 helper
   * 同时操作同一个实例。
   * @returns {Record<string, unknown> | null} 脱敏摘要（含 helperAlive）；没有进行中的操作时为 null。
   */
  function restartState() {
    if (currentOp === null) return lastOp
    const op = readOp(currentOp)
    if (op === null) {
      // Missing/corrupt/unreadable records provide no evidence that the helper exited.
      // Keep the profile locked until an operator verifies/restarts DSH manually.
      lastOp = {
        id: currentOp,
        phase: 'unknown',
        result: 'unknown',
        reason: 'record-missing',
        stages: {},
        ageMs: null,
        argsPreserved: false,
        helperAlive: null,
        helperVerified: false,
        needsManualCheck: true,
        busy: true,
      }
      return lastOp
    }
    const summary = opSummary(op, Date.now())
    if (summary.result === 'ok' || summary.result === 'failed') {
      lastOp = {
        ...summary,
        helperAlive: null,
        helperVerified: op.helperVerified === true,
        needsManualCheck: false,
        busy: false,
      }
      currentOp = null
      opRegistry.delete(profileId)
      return lastOp
    }
    const helper = helperProcessState(op)
    const state = {
      ...summary,
      helperAlive: helper.alive,
      helperVerified: helper.verified,
      needsManualCheck: summary.result === 'unknown',
      busy: true,
    }
    if (summary.result === 'pending' && helper.verified && helper.alive === false) {
      lastOp = { ...state, phase: 'unknown', result: 'unknown', reason: 'helper-exited', needsManualCheck: true, busy: false }
      currentOp = null
      opRegistry.delete(profileId)
      return lastOp
    }
    if (summary.result === 'unknown') {
      if (helper.alive !== false || !helper.verified) return state
      lastOp = state
      lastOp.busy = false
      currentOp = null
      opRegistry.delete(profileId)
      return lastOp
    }
    // pending：超过预算就明确标成「结果未知」，不谎称失败、也不悄悄放行。
    if (Number.isFinite(summary.ageMs) && summary.ageMs > HANDOFF_DEADLINE_MS) {
      const markedState = { ...state, result: 'unknown', phase: 'unknown', reason: 'timeout', needsManualCheck: true }
      if (helper.alive !== false || !helper.verified) return markedState
      lastOp = markedState
      lastOp.busy = false
      currentOp = null
      opRegistry.delete(profileId)
      return lastOp
    }
    return state
  }

  /** The state object's busy field is the single source of truth for request gating. */
  function restartBusy() {
    const state = restartState()
    return state?.busy === true ? state : null
  }

  const preparing = () => restartRequest !== null && ['waiting', 'countdown', 'paused'].includes(restartRequest.state)
  const countdownSeconds = () => {
    const value = readSettings(settingsFile).countdown ?? 0
    return Number.isInteger(value) && value >= 0 && value <= 60 ? value : 0
  }

  /**
   * 警告态（有任务在跑、主按钮已进入「仍要重启？」）的有效秒数。
   * 2026-10-29：客户端 warn 态此前永不过期（无 expireLater），用户离开后
   * 误碰一击即强制重启。过期时长存插件设置，默认 15 秒，范围 5–60；
   * 非法值一律回落 15（宁可短不可永不过期）。
   */
  const warnExpireSeconds = () => {
    const value = readSettings(settingsFile).warnExpire ?? 15
    return Number.isInteger(value) && value >= 5 && value <= 60 ? value : 15
  }

  const authCookieStatePath = join(STATE_DIR, `auth-cookie-${profileId}.json`)
  const authCookieHealth = () => {
    const settings = readSettings(settingsFile)
    const last = readSettings(authCookieStatePath)
    return { backup: settings.authCookieBackup === true, warn: settings.authCookieWarn !== false, limitBytes: 16384,
      checkPending: typeof settings.authCookieCheckAt === 'string' && (!last.checkedAt || settings.authCookieCheckAt > last.checkedAt),
      last: last.schema === 1 ? last : null }
  }

  /** 请求只存在当前 Host 内存；卸载或退出不恢复未执行请求。 */
  function clearWaiting() {
    if (requestTimer !== null) clearTimeout(requestTimer)
    requestTimer = null
  }

  function finishRequest(reason, message) {
    clearWaiting()
    Object.assign(restartRequest, { state: 'terminal', reason, message, ask: null, pausedReason: null, countdownUntil: null })
  }

  function expireRequest() {
    if (!preparing() || Date.now() < restartRequest.deadline) return false
    finishRequest('deadline-expired', '等待请求已到 30 分钟总期限，已取消；没有执行重启。')
    return true
  }

  function requestSnapshot(op = null) {
    expireRequest()
    if (restartRequest === null) return { state: 'idle', countdownUntil: null, countdownRemainingMs: null, deadlineAt: null, pausedReason: null, ask: null }
    if (restartRequest.state === 'executing' && op !== null && op.id === restartRequest.opId && ['ok', 'failed', 'unknown'].includes(op.result)) {
      finishRequest(op.reason ?? op.result, op.result === 'ok' ? '重启完成。' : '重启结果：' + op.result)
    }
    const request = restartRequest
    return {
      id: request.id, state: request.state,
      countdownUntil: request.state === 'countdown' ? new Date(request.countdownUntil).toISOString() : null,
      countdownRemainingMs: request.state === 'countdown' ? Math.max(0, request.countdownUntil - Date.now()) : null,
      deadlineAt: new Date(request.deadline).toISOString(),
      pausedReason: request.state === 'paused' ? request.pausedReason : null,
      ask: request.state === 'paused' ? request.ask : null,
      countdownSeconds: request.countdown, reason: request.reason, message: request.message, executed: request.executed,
    }
  }

  function armRequest() {
    clearWaiting()
    if (!preparing()) return
    const request = restartRequest
    const untilDeadline = request.deadline - Date.now()
    const delay = request.state === 'paused' ? untilDeadline
      : request.state === 'countdown' ? Math.min(1000, request.countdownUntil - Date.now(), untilDeadline)
      : Math.min(WAIT_POLL_MS, untilDeadline)
    requestTimer = setTimeout(() => { requestTimer = null; void advanceRequest(request.id) }, Math.max(0, delay))
    requestTimer.unref?.()
  }

  function acceptedRequest() {
    return { status: 202, body: { ok: true, waiting: true, since: new Date(restartRequest.since).toISOString(), pollMs: WAIT_POLL_MS, maxMs: WAIT_MAX_MS, restartRequest: requestSnapshot() } }
  }

  async function executeRequest() {
    // Execute-time hard checks remain in the original pipeline as well.
    const refusal = executionRefusal()
    if (refusal !== null) {
      if (restartRequest.state !== 'paused') {
        Object.assign(restartRequest, { state: 'paused', ask: randomUUID(), pausedReason: String(refusal.body.error), countdownUntil: null })
      }
      armRequest()
      return { ...refusal, body: { ...refusal.body, restartRequest: requestSnapshot() } }
    }
    clearWaiting()
    const request = restartRequest
    Object.assign(request, { state: 'executing', executed: true, ask: null, pausedReason: null, countdownUntil: null })
    const pending = scheduleExecution({ force: true })
    request.opId = currentOp ?? lastOp?.id
    const response = await pending
    if (!response.body.ok) finishRequest('execution-refused', String(response.body.error))
    return { ...response, body: { ...response.body, restartRequest: requestSnapshot() } }
  }

  async function advanceRequest(id) {
    if (disposed || restartRequest?.id !== id || !preparing()) return
    if (expireRequest()) return { status: 409, body: { ok: false, error: restartRequest.message, restartRequest: requestSnapshot() } }
    if (restartRequest.state === 'paused') { armRequest(); return acceptedRequest() }
    const guard = guardSnapshot(ctx, profileDir)
    const busy = guard.active || guard.tasks.known !== true
    if (restartRequest.state === 'countdown' && busy) {
      Object.assign(restartRequest, { state: 'paused', ask: randomUUID(), pausedReason: guard.reasons.join('；') || '无法核实任务忙闲状态', countdownUntil: null })
    } else if (waitingDecision({active:busy}, restartRequest.since, Date.now()) === 'restart') {
      if (restartRequest.state === 'waiting') Object.assign(restartRequest, { state: 'countdown', countdownUntil: Date.now() + restartRequest.countdown * 1000 })
      if (Date.now() >= restartRequest.countdownUntil) return executeRequest()
    }
    armRequest()
    return acceptedRequest()
  }

  let restartPriority = 0
  async function scheduleOnce(options = {}) {
    const snapshot = {since:Date.now(),countdown:countdownSeconds()}
    const expired = () => options.expiresAt !== undefined && Date.now() >= options.expiresAt
    const expiredResponse = () => ({status:408,body:{ok:false,error:'提交已过有效期，没有接受本次重启请求。'}})
    if (expired()) return expiredResponse()
    restartPriority += 1
    try {
      if (sweeping !== null) { sweepControl.cancelled = true; await sweeping }
      if (disposed) return {status:409,body:{ok:false,error:'插件已卸载；没有执行重启。'}}
      if (expired()) return expiredResponse()
      return await scheduleRequest(options, snapshot)
    } finally { restartPriority -= 1 }
  }

  /**
   * 「立即执行」的判定：只有 force 与 now（wait=false）**同时**显式出现才算。
   *
   * 2026-10-26 缺陷 1 修复：此前 `force === true` 单独就能跳过等待与倒计时。
   * 客户端 warn 态（宿主回 409 + guard 之后）的第二次点击只带 force=1 ——
   * 用户本意只是「确认」，结果成了「立即重启」，倒计时形同虚设。现在：
   * - 普通请求（含裸 force、裸 now、wait）一律走 waiting → countdown → executing；
   * - 只有「仍要重启 / 立即重启」这类显式动作同时带 force=1&now=1 才跳过，
   *   warn 两击直接发送这两个标志；暂停询问的立即执行另有确认框。
   * @param {{ force?: boolean, wait?: boolean }} options - 请求参数。
   * @returns {boolean} 是否立即执行。
   */
  function immediateRequested(options) {
    return options.force === true && options.wait === false
  }

  async function scheduleRequest(options, snapshot) {
    expireRequest()
    if (options.choice !== undefined) {
      if (!['wait', 'now', 'cancel'].includes(options.choice)) return { status: 400, body: { ok: false, error: '无效的请求选择' } }
      if (restartRequest?.state !== 'paused' || (options.ask !== undefined && options.ask !== restartRequest.ask)) return { status: 409, body: { ok: false, error: '该询问已失效，未执行选择', restartRequest: requestSnapshot() } }
      if (options.choice === 'cancel') return cancelRequest()
      if (options.choice === 'now') return executeRequest()
      Object.assign(restartRequest, { state: 'waiting', ask: null, pausedReason: null, countdownUntil: null })
      armRequest()
      return acceptedRequest()
    }
    const refusal = executionRefusal()
    if (refusal !== null) return refusal
    if (preparing()) return immediateRequested(options) ? executeRequest() : acceptedRequest()
    const since = snapshot.since
    restartRequest = { id: randomUUID(), state: 'waiting', since, deadline: since + WAIT_MAX_MS, countdown: snapshot.countdown, countdownUntil: null, ask: null, pausedReason: null, reason: null, message: '', executed: false }
    if (expireRequest()) return {status:409,body:{ok:false,error:restartRequest.message,restartRequest:requestSnapshot()}}
    return immediateRequested(options) ? executeRequest() : advanceRequest(restartRequest.id)
  }

  function cancelRequest() {
    expireRequest()
    const cancelled = preparing()
    if (cancelled) finishRequest('cancelled', '已取消请求；没有执行重启。')
    return { status: 200, body: { ok: true, cancelled, restartRequest: requestSnapshot() } }
  }

  // ── 快照候选扫描（见 lib/sweep.js）───────────────────────────────────────
  // 没有可靠的活动 owner 凭据时只预览，不删除。开关存插件自己的 settings.json。
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000)
  let sweepLast = null
  let sweeping = null
  let sweepControl = null

  /**
   * 当前是否开启「启动时自动扫描」：用户改过的值优先，否则看 config。
   *
   * 配置或用户设置开启时启动自动扫描；扫描不删除文件。用户设置优先于 config。
   */
  function sweepEnabled() {
    const stored = readSettings(settingsFile).sweep
    if (typeof stored === 'boolean') return stored
    return config.sweep === true
  }

  /** 把扫描模块给的一行诊断写进插件日志。 */
  const sweepLog = (line) => {
    try {
      ctx.logger('dsh-desktop-restart').info('%s', line)
    } catch {
      /* 日志不可用不影响扫描 */
    }
  }

  /**
   * 跑一次扫描；同一时刻只允许一次，并发调用共享同一个结果。
   * @returns {Promise<Record<string, unknown>>} 摘要（也会记进 {@link sweepLast}）。
   */
  function runSweep() {
    if (sweeping !== null) return sweeping
    if (restartPriority > 0 || preparing() || restartRequest?.state === 'executing') return Promise.resolve(sweepSummaryOf({partial:true,error:{code:'restart-priority'},removed:[],failed:[],candidates:[]}))
    const control = {cancelled:false}
    sweepControl = control
    sweeping = sweepOrphanSnapshots({
      tempRoot: tmpdir(),
      startedAtMs,
      minAgeMs: MIN_ORPHAN_AGE_MS,
      log: sweepLog,
      shouldStop: () => control.cancelled,
    }).then((result) => {
      if (control.cancelled) result.partial = true
      sweepLast = sweepSummaryOf(result)
      if (result.candidates?.length > 0 || result.failed.length > 0) {
        sweepLog(`snapshot preview: ${String(result.candidates?.length ?? 0)} candidate(s), ${String(result.failed.length)} failed`)
      }
      return sweepLast
    }).catch((error) => {
      sweepLog(`snapshot preview failed: ${String((error && error.message) || error)}`)
      sweepLast = {
        at: new Date().toISOString(),
        scanned: 0,
        removed: 0,
        failed: 0,
        bytes: 0,
        candidateCount: 0,
        candidateBytes: 0,
        skippedCount: 0,
        skipReason: null,
        partial: false,
        prefiltered: 0,
        // 结构化原因码，界面按码给文案；不把异常对象/字符串直接塞给界面。
        error: { code: typeof error?.code === 'string' ? error.code : 'sweep-crashed' },
      }
      return sweepLast
    }).finally(() => { sweeping = null; sweepControl = null })
    return sweeping
  }

  if (sweepEnabled()) {
    const timer = setTimeout(() => { void runSweep() }, SWEEP_START_DELAY_MS)
    timer.unref?.()
  }

  // 标记由上一个宿主在排程重启前写下；helper 将 nonce 放入新 Host 环境，
  // 用它确认该启动确实对应这次交接。
  const restartMark = restartReceipt(readSettings(restartMarkerFile), restartId, profileId, instanceId, Date.now())
  let disposed = false
  if (restartMark !== null) {
    try {
      ctx.logger('dsh-desktop-restart').info(
        'restart detected: previous boot %s, downtime ~%ds',
        restartMark.requestedAt, Math.round(restartMark.downtimeMs / 1000),
      )
    } catch { /* 日志不可用不影响 */ }
  }

  /**
   * 排程一次重启。路由与斜杠命令共用这一条路径，因此守卫只需要维护一份。
   * @param {{ force?: boolean }} [options] - `force` 表示调用方已看过警告仍要继续。
   * @returns {Promise<{ status: number, body: Record<string, unknown> }>} 给调用方的结果。
   */
  function executionRefusal() {
    if (!enabled) {
      return { status: 403, body: { ok: false, error: '插件配置里把 enabled 设成了 false，重启功能已停用' } }
    }
    if (target === null) {
      return {
        status: 409,
        body: { ok: false, error: '当前不是 DeepSeek Harness 桌面版；本插件只负责重启桌面应用' },
      }
    }
    const busy = restartBusy()
    if (busy !== null) {
      return {
        status: 409,
        body: {
          ok: false,
          error: busy.result === 'unknown'
            ? '上一次重启结果无法核实，插件已阻止重复操作；请手动核对或重启桌面应用后再试'
            : '已经有一次重启正在进行中',
          restartOp: busy,
        },
      }
    }
    try {
      const owner = JSON.parse(readFileSync(RESTART_LOCK, 'utf8'))
      if (!Number.isInteger(owner.pid) || owner.pid <= 1) return {status:409,body:{ok:false,error:'跨实例重启锁身份无法核实'}}
      try { process.kill(owner.pid, 0); return {status:409,body:{ok:false,error:'另一实例正在重启'}} }
      catch (error) { if (error.code !== 'ESRCH') return {status:409,body:{ok:false,error:'跨实例重启锁进程状态无法核实'}} }
    } catch (error) {
      if (error.code !== 'ENOENT') return {status:409,body:{ok:false,error:'无法读取跨实例重启锁'}}
    }
    // 平台（2026-10-20 C 项）：排在「不是桌面版」之后 —— dsh web 上那句更准确；
    // 真到了桌面宿主但平台不对（假想的 Linux 桌面版），就把话说在入口，
    // 别让重启走到一半才以晦涩的方式失败。
    const unsupported = platformUnsupported()
    if (unsupported !== null) {
      return { status: 409, body: { ok: false, error: unsupported } }
    }
    // 硬拦：插件正在安装/更新，而且记录里的那个进程**此刻还活着**。
    // 这一条 force 也绕不过去 —— 腰斩 pnpm 会把 profile 的依赖树弄成半新半旧，
    // 不属于「用户看清楚了就可以继续」的风险。它不会锁死按钮：进程一停，
    // 判断立刻变成「没在装」（见 installInProgress）。
    const installing = installInProgress(profileDir)
    if (installing.blocked) {
      return {
        status: 409,
        body: {
          ok: false,
          blocked: true,
          guard: {
            active: true,
            reasons: guardReasons({ known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }, installing),
            blocked: true,
          },
          error: `插件正在安装或更新（进程 ${String(installing.pid)} 还在跑）。这时候重启会让它半途中断，依赖可能只装一半；等它装完再重启，通常一两分钟。`,
        },
      }
    }
    return null
  }

  async function scheduleExecution(options = {}) {
    const refusal = executionRefusal()
    if (refusal !== null) return refusal
    // 其余守卫排在「已经在交接中」之后：那一条是状态冲突，不是「要不要继续」的问题，
    // 不该被 force 绕过去。这里只警告，不硬拦 —— 见文件头。
    if (options.force !== true) {
      const guard = guardSnapshot(ctx, profileDir)
      if (guard.active) {
        return {
          status: 409,
          body: {
            ok: false,
            guard,
            error: `${guard.reasons.join('；')}。继续重启会打断它们（正在写的文件可能停在半路），确认要继续吗？`,
          },
        }
      }
    }
    // 新 Host 必须通过 helper 传回的 nonce 命中本次交接，并且 profile 完全一致。
    const restartNonce = randomUUID()
    const lock = acquireRestartLock(restartNonce)
    if (!lock.ok) return {status:lock.status,body:{ok:false,error:lock.error}}
    let handedOff = false
    try {
    const requestedAt = new Date().toISOString()
    const restartInstanceId = createHash('sha256')
      .update(`${profileId}\0${target.exe.replaceAll('\\', '/').toLowerCase()}`)
      .digest('hex')
    const marker = {
      schema: 1,
      status: 'pending',
      profileId,
      instanceId: restartInstanceId,
      restartId: restartNonce,
      requestedAt,
    }
    if (!writeJsonAtomic(restartMarkerFile, marker)) {
      return { status: 500, body: { ok: false, error: '无法保存本次重启凭据，重启未执行' } }
    }

    currentOp = restartNonce
    opRegistry.set(profileId, restartNonce)
    const initialOp = patchOp(restartNonce, {
      phase: 'scheduled',
      result: 'pending',
      reason: null,
      startedAt: requestedAt,
      hostPid: process.pid,
      profileId,
      pid: null,
      stages: {},
    })
    if (initialOp === null) {
      currentOp = null
      opRegistry.delete(profileId)
      lastOp = {
        id: restartNonce,
        phase: 'failed',
        result: 'failed',
        reason: 'state-write-failed',
        stages: {},
        ageMs: 0,
        argsPreserved: false,
        helperAlive: false,
        helperVerified: false,
        needsManualCheck: false,
        busy: false,
      }
      writeJsonAtomic(restartMarkerFile, { ...marker, status: 'failed' })
      return { status: 500, body: { ok: false, error: '无法保存重启操作记录，未启动辅助进程' } }
    }

    let result
    try {
      result = scheduleRestart(target, ctx.webServer.port ?? null, restartNonce, {
        databasePath: process.env.APPDATA ? join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies') : null,
        statePath: authCookieStatePath, backupDir: join(STATE_DIR, `auth-cookie-backups-${profileId}`), backup: authCookieHealth().backup,
      })
    } catch (error) {
      const failedOp = patchOp(restartNonce, { result: 'failed', phase: 'failed', reason: 'helper-spawn-failed' })
      currentOp = null
      opRegistry.delete(profileId)
      lastOp = {
        ...opSummary(failedOp ?? {
          id: restartNonce, phase: 'failed', result: 'failed', reason: 'helper-spawn-failed',
          startedAt: requestedAt, stages: {}, argsPreserved: false,
        }, Date.now()),
        helperAlive: false,
        helperVerified: false,
        needsManualCheck: false,
        busy: false,
      }
      writeJsonAtomic(restartMarkerFile, { ...marker, status: 'failed' })
      return { status: 500, body: { ok: false, error: String((error && error.message) || error) } }
    }

    handedOff = true
    // spawn 成功不等于 helper 活着：等它挺过启动再确认。它已经死了就说明这次
    // 交接根本没开始，必须复位标志，否则用户会被永久锁在「交接中」。
    if (!await helperAlive(result.helperPid)) {
      handedOff = false
      const failedOp = patchOp(restartNonce, { result: 'failed', phase: 'failed', reason: 'helper-died' })
      currentOp = null
      opRegistry.delete(profileId)
      lastOp = {
        ...opSummary(failedOp ?? {
          id: restartNonce, phase: 'failed', result: 'failed', reason: 'helper-died',
          startedAt: requestedAt, stages: {}, argsPreserved: false,
        }, Date.now()),
        helperAlive: false,
        helperVerified: false,
        needsManualCheck: false,
        busy: false,
      }
      writeJsonAtomic(restartMarkerFile, { ...marker, status: 'failed' })
      return {
        status: 500,
        body: { ok: false, error: '负责重启的辅助进程没能启动，这次重启没有开始；可以再试一次' },
      }
    }

    // 兜底：helper 活着却迟迟没让应用重启（卡住、主进程杀不掉）时，放行重试。
    // 正常路径下应用已经重启，这个定时器随旧进程一起消失。
    // 超预算的处置已移到 restartState()：标 unknown，但**不**无条件放行 ——
    // helper 还活着就继续占着互斥（DR-OPT-02 第 2 项）。这里不再设盲复位定时器。

    try {
      ctx.logger('dsh-desktop-restart').info(
        'restart scheduled: host pid %d, main pid %d, helper pid %s',
        result.hostPid, result.mainPid, String(result.helperPid),
      )
    } catch {
      /* 日志不可用不影响交接 */
    }
    return { status: 202, body: { ok: true, ...result } }
    } finally { if (!handedOff) releaseRestartLock(restartNonce) }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      // 状态里不再返回 pid 与可执行文件路径：客户端只需要知道「是不是桌面版」，
      // 而那些字段会把本机路径（含用户名）交给任何能访问到这个端口的人。
      if (!trustedRequest(req)) {
        send(403, { ok: false, error: '状态查询只接受来自本机页面的请求' })
        return
      }
      const guard = guardSnapshot(ctx, profileDir)
      // 只诊断、不拦：状态路由必须能在鉴权失败时也把原因说出来，所以真正的门
      // 在下面两条写路由上；这里只报「本次请求的鉴权判定是什么」，好让界面能
      // 解释为什么按钮不能用，而不是让人对着一个 401 猜。
      const fence = platformAuth ? platformFence(ctx, req) : { available: false, verdict: null, error: null }
      const restartOp = restartState()
      const request = requestSnapshot(restartOp)
      let notifications
      const noticeError = notices.ensure(restartOp)
      try { notifications = { items: notices.list(), error: noticeError } }
      catch { notifications = { items: [], error: { code: 'notice-read-failed' } } }
      send(200, {
        // 自己的版本号（C 项）：排查「装的哪一版」一眼可见，不必翻 node_modules。
        version: PLUGIN_VERSION,
        serverNow: Date.now(),
        requestExpiry: true,
        recoveryId: restartMark !== null && restartOp?.id === restartMark.restartId
          && restartOp.result === 'pending' ? restartMark.restartId : null,
        desktop: target !== null,
        enabled: enabled && (!platformAuth || (fence.available && fence.error === null)),
        platformAuth: { enforced: platformAuth, available: fence.available, verdict: fence.verdict, error: fence.error },
        // 挂起的「等空闲再重启」：界面据此显示/取消。只给时间与节奏，不给内部句柄。
        waiting: preparing() ? { since: new Date(restartRequest.since).toISOString(), pollMs: WAIT_POLL_MS, maxMs: WAIT_MAX_MS } : null,
        restartRequest: request,
        notifications,
        settingsMigrationError,
        settingsMigrated,
        countdownSeconds: countdownSeconds(),
        warnExpireSeconds: warnExpireSeconds(),
        authCookie: authCookieHealth(),
        // 本次启动是否由一次重启而来（2026-10-21）：界面据此显示回执。
        // sessions 只给**个数**，不把会话 id 交给界面。
        // 本次重启的操作状态（DR-OPT-02 第 1 项）：阶段、结果、原因码、阶段耗时。
        // 202 只表示「已接受排程」；后续成功/失败/未知都由这里如实给出。
        restartOp,
        restartBusy: restartOp?.busy === true,
        lastRestart: restartMark === null
          ? null
          : { at: restartMark.requestedAt, requestedAt: restartMark.requestedAt, hostReadyAt: restartMark.hostReadyAt, downtimeMs: restartMark.downtimeMs },
        // 让两个入口在按之前就能提示「现在有多少活在跑」。reasons 仍是宿主拼好的
        // 中文整句（斜杠命令直接用）；tasks / installs 是**结构化计数**（2026-10-20
        // E 项）—— 客户端拿它按界面语言自己组句，英文界面不再夹中文。
        guard: {
          active: guard.active,
          reasons: guard.reasons,
          blocked: guard.installs.running === true,
          tasks: {
            known: guard.tasks.known,
            active: guard.tasks.active,
            turns: guard.tasks.turns,
            queued: guard.tasks.queued,
            jobs: guard.tasks.jobs,
          },
          installs: { active: guard.installs.active, running: guard.installs.running },
        },
        // 每个入口的**默认**开关（config 里配的）；客户端那份还会被它自己的设置页覆盖。
        entries: readEntries(config),
        // 孤儿快照预览：开关状态 + 本次进程里最后一次扫描的结果（没有就是 null）。
        sweep: {
          running: sweeping !== null, enabled: sweepEnabled(), last: sweepLast, minAgeHours: MIN_ORPHAN_AGE_MS / 3_600_000 },
      })
    },
  }), 'dsh-desktop-restart: status route')

  // 用查询参数而不是请求体：与重启路由同一个理由 —— 桌面壳转发页面 fetch 时
  // 只保证 URL 与头部到达，少一种失败形态。
  //   POST /api/prefs?enabled=1|0              自动预览开关（=1 时顺手立刻扫描）
  //   POST /api/prefs?run=1                    不改开关，只立刻预览候选
  // `/api/sweep` 是同一个处理器的旧路径，留给已经装在用户机器上的老客户端。
  const settingsHandler = async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!trustedRequest(req)) {
      send(403, { ok: false, error: '设置只接受来自本机页面的请求' })
      return
    }
    // 写路由走完整的平台门（栅栏 + 浏览器鉴权）：这里会改设置，不能只靠
    // 「不带 Origin 就算自己人」。
    const fence = platformAuth ? platformFence(ctx, req) : { available: false, verdict: null, error: null }
    if (fence.verdict !== null) {
      send(fence.verdict, { ok: false, error: describeFenceRefusal(fence, '设置') })
      return
    }
    if (platformAuth && (!fence.available || fence.error !== null)) {
      send(503, { ok: false, error: !fence.available ? '本组合缺少平台鉴权服务，重启及设置写入已禁用' : '平台浏览器鉴权暂时不可用，设置未保存' })
      return
    }
    let params
    try {
      params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    } catch {
      send(400, { ok: false, error: '请求地址无法解析' })
      return
    }
    if (settingsMigrationError !== null) { send(503, { ok: false, error: 'profile 设置迁移失败：' + settingsMigrationError }); return }
    if (params.has('clientReady')) {
      const id = params.get('clientReady')
      if (restartMark === null || id !== restartMark.restartId) {
        send(409, {ok:false,error:'本次客户端恢复凭据不匹配'})
        return
      }
      const op = readOp(id)
      if (op === null || op.profileId !== profileId || op.readyHostPid !== process.pid) {
        send(409, {ok:false,error:'本次宿主恢复尚未确认'})
        return
      }
      const saved = op.result === 'ok' || patchOp(id, {clientReadyAt:new Date().toISOString()}) !== null
      send(saved ? 200 : 500, {ok:saved})
      return
    }
    if (params.get('cancelSweep') === '1') {
      const cancelled = sweeping !== null
      if (cancelled) { sweepControl.cancelled = true; await sweeping }
      send(200, {ok:true,cancelled,enabled:sweepEnabled(),last:sweepLast,countdownSeconds:countdownSeconds(),warnExpireSeconds:warnExpireSeconds()})
      return
    }
    if (params.has('readNotice')) {
      try {
        const read = notices.markRead(params.get('readNotice'))
        send(read ? 200 : 404, {ok:read, read})
      } catch { send(500, {ok:false, error:'诊断已读状态保存失败'}) }
      return
    }
    const wanted = params.get('enabled')
    const countdown = params.get('countdown')
    if (countdown !== null && (!/^\d+$/u.test(countdown) || Number(countdown) > 60)) {
      send(400, { ok: false, error: 'countdown 必须为 0–60 的整数秒', countdownSeconds: countdownSeconds() })
      return
    }
    const warnExpire = params.get('warnExpire')
    if (warnExpire !== null && (!/^\d+$/u.test(warnExpire) || Number(warnExpire) < 5 || Number(warnExpire) > 60)) {
      send(400, { ok: false, error: 'warnExpire 必须为 5–60 的整数秒', warnExpireSeconds: warnExpireSeconds() })
      return
    }
    // Only dismiss a completed, non-busy summary. Unknown identity is not proof of exit.
    if (params.get('clearOp') === '1') {
      const state = currentOp === null ? lastOp : restartState()
      if (currentOp !== null || state?.busy === true) {
        send(409, {
          ok: false,
          error: state?.helperAlive === false && state.helperVerified === true
            ? '重启操作仍未到可清除状态'
            : '无法确认辅助进程已退出；请先手动核对或重启桌面应用',
          cleared: false,
          restartOp: state,
        })
        return
      }
      const cleared = lastOp !== null
      lastOp = null
      send(200, { ok: true, cleared })
      return
    }
    const patch = {}
    for (const key of ['authCookieBackup', 'authCookieWarn']) {
      const value = params.get(key)
      if (value !== null && value !== '0' && value !== '1') { send(400, {ok:false,error:'Cookie preference must be 0 or 1'}); return }
      if (value !== null) patch[key] = value === '1'
    }
    if (params.get('checkAuthCookie') === '1') patch.authCookieCheckAt = new Date().toISOString()
    if (countdown !== null) patch.countdown = Number(countdown)
    if (warnExpire !== null) patch.warnExpire = Number(warnExpire)
    if (wanted === '0' || wanted === '1') patch.sweep = wanted === '1'
    if (Object.keys(patch).length > 0) {
      const saved = writeSettingsChecked(patch, settingsFile)
      if (!saved.ok) {
        send(500, { ok: false, error: '设置写入失败', enabled: sweepEnabled() })
        return
      }
    }
    const shouldRun = params.get('run') === '1' || wanted === '1'
    const last = shouldRun ? await runSweep() : sweepLast
    send(200, { ok: true, authCookie: authCookieHealth(), enabled: sweepEnabled(), last, countdownSeconds: countdownSeconds(), warnExpireSeconds: warnExpireSeconds() })
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_SWEEP,
    handler: settingsHandler,
  }), 'dsh-desktop-restart: sweep route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFS,
    handler: settingsHandler,
  }), 'dsh-desktop-restart: prefs route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_RESTART,
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (!trustedRequest(req)) {
        send(403, { ok: false, error: '重启只接受来自本机页面的请求' })
        return
      }
      // 写路由走完整的平台门（栅栏 + 浏览器鉴权）。这是本插件最敏感的一条：
      // 过了它就能结束整个应用，所以「不带 cookie 的本机进程」也必须被挡下。
      const fence = platformAuth ? platformFence(ctx, req) : { available: false, verdict: null, error: null }
      if (fence.verdict !== null) {
        send(fence.verdict, { ok: false, error: describeFenceRefusal(fence, '重启') })
        return
      }
      if (platformAuth && (!fence.available || fence.error !== null)) {
        send(503, { ok: false, error: !fence.available ? '本组合缺少平台鉴权服务，重启功能已禁用' : '平台浏览器鉴权暂时不可用，重启请求未执行' })
        return
      }
      let params
      try { params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams }
      catch { send(400, { ok: false, error: '请求地址无法解析' }); return }
      const expiry = params.get('expiresAt')
      if (expiry !== null && (!/^\d{1,16}$/u.test(expiry) || !Number.isSafeInteger(Number(expiry)))) {
        send(400, {ok:false,error:'expiresAt 必须为毫秒时间戳'})
        return
      }
      if (expiry !== null && Date.now() >= Number(expiry)) {
        send(408, {ok:false,error:'提交已过有效期，没有接受本次重启请求。'})
        return
      }
      // Expired cancellation requests must not cancel a newer waiting request.
      if (cancelWaitRequested(req.url)) {
        const result = cancelRequest()
        send(result.status, result.body)
        return
      }
      const { status, body } = await scheduleOnce({ expiresAt:expiry === null ? undefined : Number(expiry), force: forceRequested(req.url), wait: shouldWaitForIdle(req.url), choice: params.has('choice') ? params.get('choice') : undefined, ask: params.has('ask') ? params.get('ask') : undefined })
      send(status, body)
    },
  }), 'dsh-desktop-restart: restart route')

  // 斜杠命令：在输入框里打 /restart-desktop 就能重启，不必翻到设置页。
  // commands 是可选的 —— 没有它时插件照常提供上面两条路由；config.command === false 时整个不注册。
  if (readEntries(config).command) ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'restart-desktop',
      description: '重启整个 DeepSeek Harness 桌面应用',
      handler: async (invocation) => {
        // 正常提交先等待已核实空闲；`/restart-desktop --force` 是显式的
        // 「我看过了，立即执行」（force+now 两个标志都置位才跳过等待与倒计时，
        // 与界面上「仍要重启 / 立即重启」按钮同一条路）；`--wait` 则是
        // 「等它们跑完再重启」。rawInput 取不到（不同版本形状不同）就退化成
        // 必须用按钮确认，不会误动手。
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
        const trimmed = rawInput.trim()
        const force = /(?:^|\s)--force(?:\s|$)/u.test(trimmed)
        const wait = !force && !/(?:^|\s)--now(?:\s|$)/u.test(trimmed)
        const { status, body } = await scheduleOnce({ force, wait })
        if (body.ok === true) {
          return {
            kind: 'success',
            text: body.waiting === true
              ? '已安排：等任务跑完后自动重启。重复请求不会延长等待期限；可在重启面板取消等待。'
              : '已排程重启：窗口会关闭，随后自动打开。',
          }
        }
        const hint = body.guard === undefined
          ? ''
          : (body.blocked === true
              ? '。等安装或更新结束后再提交重启请求。'
              : '。确认要继续就再执行一次：/restart-desktop --force；也可以 --wait 等它们跑完再重启。')
        return { kind: 'error', text: String(body.error ?? `重启被拒绝（HTTP ${String(status)}）`) + hint }
      },
    }), 'dsh-desktop-restart: /restart-desktop command')
  })

  // 宿主半卸载时撤掉挂起的等待，别留下一个还会触发重启的定时器。
  ctx.effect(() => () => {
    disposed = true
    if (sweepControl !== null) sweepControl.cancelled = true
    clearWaiting()
  })
  // The helper requires this nonce-bound host receipt AND a client acknowledgement.
  // A debug/inspector listener alone is never application readiness.
  if (restartMark !== null) {
    const op = readOp(restartMark.restartId)
    if (op?.profileId === profileId && op.result === 'pending') {
      patchOp(restartMark.restartId, {hostReadyAt:restartMark.hostReadyAt, readyHostPid:process.pid})
    }
  }
}

/**
 * 给离线冒烟测试用的内部函数（不参与运行时行为）。
 * @internal
 */
export const __test = {
  acquireRestartLock, releaseRestartLock, RESTART_LOCK,
  readEntries,
  readSettings,
  writeSettings,
  taskSnapshot,
  runAlive,
  installInProgress,
  guardReasons,
  guardSnapshot,
  forceRequested,
  shouldWaitForIdle,
  cancelWaitRequested,
  platformUnsupported,
  waitingDecision,
  restartReceipt,
  profileIdentity,
  writeSettingsChecked,
  writeJsonAtomic,
  opFileOf,
  readOp,
  patchOp,
  opSummary,
  sweepSummaryOf,
  validProfileDir,
  pruneState,
  desktopTarget,
  trustedRequest,
  platformFence,
  describeFenceRefusal,
}
