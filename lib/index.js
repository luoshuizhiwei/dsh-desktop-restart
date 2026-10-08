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
 * 安全模型：路由只接受同源 loopback 的 POST（带转发头一律拒绝），非桌面宿主
 * 直接拒绝并说明原因，同一时刻只允许一次重启交接。
 *
 * @module dsh-desktop-restart
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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
  let scheduled = false

  /**
   * 排程一次重启。路由与斜杠命令共用这一条路径，因此守卫只需要维护一份。
   * @returns {Promise<{ status: number, body: Record<string, unknown> }>} 给调用方的结果。
   */
  async function scheduleOnce() {
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
      send(200, { desktop: target !== null, enabled })
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
      const { status, body } = await scheduleOnce()
      send(status, body)
    },
  }), 'dsh-desktop-restart: restart route')

  // 斜杠命令：在输入框里打 /restart-desktop 就能重启，不必翻到设置页。
  // commands 是可选的 —— 没有它时插件照常提供上面两条路由。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'restart-desktop',
      description: '重启整个 DeepSeek Harness 桌面应用（Electron 应用与它的 host 进程）',
      handler: async () => {
        const { status, body } = await scheduleOnce()
        if (body.ok === true) {
          return {
            kind: 'success',
            text: `已排程重启：宿主 pid ${String(body.hostPid)}，主进程 pid ${String(body.mainPid)}。窗口会关闭，随后自动打开。`,
          }
        }
        return { kind: 'error', text: String(body.error ?? `重启被拒绝（HTTP ${String(status)}）`) }
      },
    }), 'dsh-desktop-restart: /restart-desktop command')
  })
}
