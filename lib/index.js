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
 *   只回一份「会打断什么」，要调用方带 `force` 再来一次才真动手；
 * - **插件正在安装/更新**：`<profile>/.plugin-manager/run.json` 是应用自己
 *   记「有个 pnpm 运行正在写这个 profile」的凭据（见 @deepseek-ai/dsh-plugin-manager），
 *   存在就同样只警告不硬来 —— 腰斩 pnpm 有可能把 profile 的依赖树弄坏。
 *
 * 两者都**只警告、不硬拦**：run.json 在崩溃后会残留（应用自己也只等 5 秒就
 * 放弃），硬拦会把重启按钮永久锁死，那正是 2026-10-06 修过的死锁类型。
 *
 * 安全模型：路由只接受同源 loopback 的 POST（带转发头一律拒绝），非桌面宿主
 * 直接拒绝并说明原因，同一时刻只允许一次重启交接。
 *
 * @module dsh-desktop-restart
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 没有 web carrier 就没有路由：这是唯一的硬依赖。 */
export const inject = ['webServer']

/** 本插件拥有的两个路由。 */
const ROUTE_RESTART = '/dsh-desktop-restart/api/restart'
const ROUTE_STATUS = '/dsh-desktop-restart/api/status'

/** 分离 helper 的绝对路径。 */
const HELPER_PATH = fileURLToPath(new URL('./helper.cjs', import.meta.url))

/** 交接描述与 helper 日志的落盘位置（与 DSH 自己的 home 保持一致）。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'desktop-restart')

/** 交接目录保留的组数：每次重启写一份 handoff + 一份 log，旧的要清掉。 */
const STATE_KEEP = 20

/** helper 在动手前的等待时间，让 HTTP 响应先送达浏览器。 */
const HANDOFF_DELAY_MS = 1500

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
const HANDOFF_DEADLINE_MS = 60_000

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
 * profile 上是否有一个 pnpm 运行正在写它。
 *
 * 凭据是应用自己的 `.plugin-manager/run.json`：每次包操作开始时写下、结束时
 * 删除（见 @deepseek-ai/dsh-plugin-manager 的 recordRun）。它存在就说明有
 * 一次安装/更新没走完 —— 此时结束主进程会把 pnpm 腰斩，依赖树可能半新半旧。
 *
 * 只读不写：判断不了就返回 `known: false`，绝不因为读不到而拦住用户。
 * @param {string | null} dir - profile 目录。
 * @returns {{ known: boolean, active: boolean, pid: number | null, record: string | null }} 状态。
 */
function installInProgress(dir) {
  if (dir === null) return { known: false, active: false, pid: null, record: null }
  const record = join(dir, '.plugin-manager', 'run.json')
  if (!existsSync(record)) return { known: true, active: false, pid: null, record: null }
  let pid = null
  try {
    const parsed = JSON.parse(readFileSync(record, 'utf8'))
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pid = parsed.pid
  } catch {
    /* 读不动或内容坏了：照样按「有」处理，宁可多问一次 */
  }
  return { known: true, active: true, pid, record }
}

/**
 * 现在停掉宿主会打断什么工作。
 *
 * 判据复刻应用自己的 `hasDesktopActiveTasks`：有正在生成/跑工具的智能体、
 * 有排队消息、或有正在跑/正在停的后台任务。`agents` 与 `jobs` 都是可选
 * 服务，取不到就如实回 `known: false`（于是守卫静默跳过），
 * 绝不因为服务形状变了就把重启按钮拦死。
 * @param {{ get?: (name: string) => unknown }} ctx - host 上下文。
 * @returns {{ known: boolean, active: boolean, turns: number, queued: number, jobs: number, sessions: number }} 快照。
 */
function taskSnapshot(ctx) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined
    if (agents === undefined || jobs === undefined) return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    if (typeof agents.list !== 'function' || typeof jobs.list !== 'function') return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
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
      if (!Array.isArray(list)) continue
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
    if (tasks.turns > 0) parts.push(`${String(tasks.turns)} 个回合正在生成或跑工具`)
    if (tasks.queued > 0) parts.push(`${String(tasks.queued)} 个会话有排队消息`)
    if (tasks.jobs > 0) parts.push(`${String(tasks.jobs)} 个后台任务在跑`)
    reasons.push(`有任务在跑（${parts.join('、')}）`)
  }
  if (installs.active) {
    reasons.push(installs.pid === null
      ? '插件目录上留着一条安装记录（进程已退出，可能是残留）'
      : '插件正在安装或更新')
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
 * @returns {{ hostPid: number, mainPid: number, helperPid: number | undefined, logPath: string }} 交接结果。
 */
function scheduleRestart(target, port) {
  mkdirSync(STATE_DIR, { recursive: true })
  pruneState(STATE_DIR)
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const logPath = join(STATE_DIR, `restart-${stamp}.log`)
  const handoffPath = join(STATE_DIR, `handoff-${stamp}.json`)
  writeFileSync(handoffPath, JSON.stringify({
    mainPid: target.mainPid,
    exe: target.exe,
    hostPid: target.hostPid,
    port: port ?? null,
    logPath,
    handoffPath,
    delayMs: HANDOFF_DELAY_MS,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8')

  const helper = spawn(process.execPath, [HELPER_PATH, handoffPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(HELPER_PATH),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  helper.unref()
  return {
    hostPid: target.hostPid,
    mainPid: target.mainPid,
    helperPid: helper.pid,
    logPath,
  }
}

/**
 * 挂载插件：一条状态路由 + 一条受守卫的重启路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host 上下文。
 * @param {{ enabled?: boolean }} [config] - 本插件那一行的 config。
 */
export function apply(ctx, config = {}) {
  const target = desktopTarget()
  const enabled = config.enabled !== false
  const profileDir = resolveProfileDir()
  let scheduled = false

  /**
   * 排程一次重启。路由与斜杠命令共用这一条路径，因此守卫只需要维护一份。
   * @param {{ force?: boolean }} [options] - `force` 表示调用方已看过警告仍要继续。
   * @returns {Promise<{ status: number, body: Record<string, unknown> }>} 给调用方的结果。
   */
  async function scheduleOnce(options = {}) {
    if (!enabled) {
      return { status: 403, body: { ok: false, error: '本插件那一行的 config.enabled 为 false，重启已停用' } }
    }
    if (target === null) {
      return {
        status: 409,
        body: { ok: false, error: '当前宿主不是 Electron 桌面版；本插件只负责重启桌面应用，dsh web 请用别的重启方式' },
      }
    }
    if (scheduled) {
      return { status: 409, body: { ok: false, error: '已经有一次重启在交接中' } }
    }
    // 守卫排在「已经在交接中」之后：那一条是状态冲突，不是「要不要继续」的问题，
    // 不该被 force 绕过去。这里只警告，不硬拦 —— 见文件头关于死锁的说明。
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
    scheduled = true

    let result
    try {
      result = scheduleRestart(target, ctx.webServer.port ?? null)
    } catch (error) {
      scheduled = false
      return { status: 500, body: { ok: false, error: String((error && error.message) || error) } }
    }

    // spawn 成功不等于 helper 活着：等它挺过启动再确认。它已经死了就说明这次
    // 交接根本没开始，必须复位标志，否则用户会被永久锁在「交接中」。
    if (!await helperAlive(result.helperPid)) {
      scheduled = false
      return {
        status: 500,
        body: { ok: false, error: `交接 helper（pid ${String(result.helperPid)}）没能存活，重启未开始；可以重试` },
      }
    }

    // 兜底：helper 活着却迟迟没让应用重启（卡住、主进程杀不掉）时，放行重试。
    // 正常路径下应用已经重启，这个定时器随旧进程一起消失。
    const deadline = setTimeout(() => { scheduled = false }, HANDOFF_DEADLINE_MS)
    deadline.unref?.()

    try {
      ctx.logger('dsh-desktop-restart').info(
        'restart scheduled: host pid %d, main pid %d, helper pid %s',
        result.hostPid, result.mainPid, String(result.helperPid),
      )
    } catch {
      /* 日志不可用不影响交接 */
    }
    return { status: 202, body: { ok: true, ...result } }
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
        send(403, { ok: false, error: '状态查询只接受同源 loopback 请求' })
        return
      }
      const guard = guardSnapshot(ctx, profileDir)
      send(200, {
        desktop: target !== null,
        enabled,
        // 让两个入口在按之前就能提示「现在有多少活在跑」，只给计数与人话，
        // 不含任何路径。
        guard: { active: guard.active, reasons: guard.reasons },
      })
    },
  }), 'dsh-desktop-restart: status route')

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
        send(403, { ok: false, error: '重启只接受同源 loopback 请求' })
        return
      }
      const { status, body } = await scheduleOnce({ force: forceRequested(req.url) })
      send(status, body)
    },
  }), 'dsh-desktop-restart: restart route')

  // 斜杠命令：在输入框里打 /restart-desktop 就能重启，不必翻到设置页。
  // commands 是可选的 —— 没有它时插件照常提供上面两条路由。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'restart-desktop',
      description: '重启整个 DeepSeek Harness 桌面应用（Electron 应用与它的 host 进程）',
      handler: async (invocation) => {
        // 有任务在跑时先只回警告，`/restart-desktop --force` 才是「我看过了」。
        // rawInput 取不到（不同版本形状不同）就退化成必须用按钮确认，不会误动手。
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
        const force = /(?:^|\s)--force(?:\s|$)/u.test(rawInput.trim())
        const { status, body } = await scheduleOnce({ force })
        if (body.ok === true) {
          return {
            kind: 'success',
            text: `已排程重启：宿主 pid ${String(body.hostPid)}，主进程 pid ${String(body.mainPid)}。窗口会关闭，随后自动打开。`,
          }
        }
        const hint = body.guard === undefined
          ? ''
          : '。确认要继续就再执行一次：/restart-desktop --force'
        return { kind: 'error', text: String(body.error ?? `重启被拒绝（HTTP ${String(status)}）`) + hint }
      },
    }), 'dsh-desktop-restart: /restart-desktop command')
  })
}

/**
 * 给离线冒烟测试用的内部函数（不参与运行时行为）。
 * @internal
 */
export const __test = {
  taskSnapshot,
  installInProgress,
  guardReasons,
  guardSnapshot,
  forceRequested,
  validProfileDir,
  pruneState,
  desktopTarget,
  trustedRequest,
}
