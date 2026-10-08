'use strict'

/**
 * dsh-desktop-restart — 分离 helper。
 *
 * 由 host 半用「桌面应用本身 + ELECTRON_RUN_AS_NODE=1」启动，因此不依赖系统
 * Node，也不依赖 `dsh` 在 PATH 里。它是交接期间唯一能活过宿主的东西，所以
 * 整件事由它做完：
 *
 *   1. 等一小会儿，让 host 的 HTTP 响应先送达浏览器；
 *   2. 结束 Electron 主进程 —— 故意不带 /T：host 子进程必须活下来，才能在
 *      IPC 断开后走自己的优雅关闭（`application.shutdown`），把会话日志
 *      正常落盘。带 /T 会把 host 一起强杀，那才是真的会丢数据；
 *   3. 等主进程消失，再等监听端口释放（用「连接」探测，不用「绑定」——
 *      试探性绑定恰恰会占住替代进程要用的那个端口）；
 *   4. 端口迟迟不放时兜底：按映像名清掉残留的桌面进程（helper 自己排除在外）；
 *   5. 用干净的环境拉起新实例 —— 必须去掉 ELECTRON_RUN_AS_NODE，否则新的
 *      「应用」会以 Node 模式启动，变成一个没有窗口的进程。
 *
 * 用法：node helper.cjs <handoff.json>
 * 所有诊断写入 handoff 里指定的 logPath；这个进程的 stdio 是 ignore。
 */

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

/** 主进程消失的等待上限。 */
const MAIN_EXIT_TIMEOUT_MS = 15000
/** 端口释放的等待上限。 */
const PORT_FREE_TIMEOUT_MS = 30000
/** 默认的交接前等待。 */
const DEFAULT_DELAY_MS = 1500
/** 拉起新实例后，等多久确认它没有立刻退出。 */
const RELAUNCH_VERIFY_MS = 2500
/** 新实例接管端口的等待上限。 */
const PORT_RELISTEN_TIMEOUT_MS = 20000

const handoffPath = process.argv[2]
if (typeof handoffPath !== 'string' || handoffPath === '') {
  process.exit(1)
}

let handoff
try {
  handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))
} catch {
  process.exit(1)
}

const mainPid = Number(handoff.mainPid)
const exe = String(handoff.exe ?? '')
const hostPid = Number(handoff.hostPid)
const port = Number(handoff.port)
const logPath = String(handoff.logPath ?? '')
const delayMs = Number(handoff.delayMs) > 0 ? Number(handoff.delayMs) : DEFAULT_DELAY_MS

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 追加一行诊断。日志不可写时静默——诊断失败不该拖垮重启本身。 */
function note(line) {
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 没有日志也要继续 */
  }
}

/** 进程是否还活着（信号 0 只做存在性检查）。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 端口上是否有人监听。
 * @param {number} p - 端口。
 * @returns {Promise<boolean>} 有人应答时为 true。
 */
function listening(p) {
  return new Promise((resolve) => {
    let settled = false
    const probe = net.connect({ host: '127.0.0.1', port: p })
    const finish = (value) => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(value)
    }
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    probe.setTimeout(500, () => finish(false))
  })
}

/**
 * 强杀一个 pid。
 * @param {number} pid - 目标。
 * @returns {boolean} taskkill 是否成功。
 */
function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * 解析 tasklist 的 CSV 输出。只取 `"名字","pid"` 这种 ASCII 结构，
 * 因此中文系统上的提示行不会干扰解析。
 * @param {string} args - 传给 tasklist 的参数。
 * @returns {{ image: string, pid: number }[]} 进程列表。
 */
function tasklist(args) {
  try {
    const out = execFileSync('tasklist', args, { encoding: 'utf8', windowsHide: true })
    return [...out.matchAll(/"([^"]*)","(\d+)"/gu)]
      .map((match) => ({ image: match[1], pid: Number(match[2]) }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return []
  }
}

/**
 * 目标 pid 当前的映像名，用于确认它确实是我们要结束的那个进程。
 * @param {number} pid - 目标。
 * @returns {string | null} 映像名，或 null。
 */
function imageNameOf(pid) {
  const found = tasklist(['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'])
    .find((entry) => entry.pid === pid)
  return found === undefined ? null : found.image
}

/** 当前所有桌面应用进程（含 helper 自己）。 */
function applicationPids() {
  if (exe === '') return []
  return tasklist(['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/FO', 'CSV', '/NH'])
    .map((entry) => entry.pid)
}

/**
 * 交接并重启。
 * @returns {Promise<void>} 完成（无论成功或已记录失败）。
 */
async function main() {
  note(`helper started: helper=${process.pid} host=${hostPid} main=${mainPid} port=${port} exe=${exe}`)

  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    note('refusing: the handoff carries no usable main process id')
    return
  }
  if (exe === '') {
    note('refusing: the handoff carries no application executable')
    return
  }

  // 1. 先让浏览器拿到「已排程重启」的响应。
  await sleep(delayMs)

  // 2. 确认目标身份，然后结束主进程（不带 /T）。
  const expected = path.basename(exe).toLowerCase()
  const image = imageNameOf(mainPid)
  if (image !== null && image.toLowerCase() !== expected) {
    note(`refusing: pid ${mainPid} is "${image}", not "${expected}"`)
    return
  }
  if (image === null) {
    note(`main process ${mainPid} is already gone; skipping the kill`)
  } else {
    note(`ending the Electron main process ${mainPid} ("${image}") without /T, so the host can close gracefully`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  }

  // 3. 等主进程消失。
  const goneBy = Date.now() + MAIN_EXIT_TIMEOUT_MS
  while (Date.now() < goneBy && alive(mainPid)) await sleep(200)
  note(alive(mainPid) ? `main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms` : 'main process exited')

  // 4. 等端口释放；迟迟不放就兜底清理残留进程。
  if (Number.isInteger(port) && port > 0) {
    const freeBy = Date.now() + PORT_FREE_TIMEOUT_MS
    while (Date.now() < freeBy && await listening(port)) await sleep(300)
    if (await listening(port)) {
      note(`port ${port} is still held; terminating leftover application processes`)
      for (const pid of applicationPids()) {
        if (pid === process.pid || pid === mainPid) continue
        note(`killing leftover pid ${pid}`)
        killPid(pid)
      }
      await sleep(1500)
    } else {
      note(`port ${port} released`)
    }
  }

  // 5. 给文件系统和端口一点收尾时间，然后拉起新实例。
  await sleep(800)

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    // Node 模式下这两个变量会跟着继承；不清掉，新实例会变成一个没有窗口的进程。
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'DSH_DESKTOP_NODE_EXECUTABLE') delete env[key]
  }

  let childPid
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(exe),
      env,
    })
    child.on('error', (error) => note(`relaunch failed: ${String((error && error.message) || error)}`))
    childPid = child.pid
    child.unref()
    note(`relaunched "${exe}" as pid ${String(childPid)}`)
  } catch (error) {
    note(`relaunch threw: ${String((error && error.stack) || error)}`)
    return
  }

  // spawn 成功只表示「创建进程的请求发出去了」—— 与交接那一头是同一类问题，
  // 只不过这次在链路的末端。等几秒确认新实例真的还在：它若立刻退出（端口没真正
  // 释放、单实例锁还没放），用户只会看到页面永远不回来，而日志里却写着成功。
  await sleep(RELAUNCH_VERIFY_MS)
  if (!Number.isInteger(childPid) || !alive(childPid)) {
    note(`the relaunched process (pid ${String(childPid)}) is already gone — the restart did not take`)
    return
  }
  note(`relaunched process (pid ${String(childPid)}) is still alive after ${RELAUNCH_VERIFY_MS}ms`)

  // 再确认它把端口接了过去 —— 那才是「应用真的回来了」。
  if (Number.isInteger(port) && port > 0) {
    const listenBy = Date.now() + PORT_RELISTEN_TIMEOUT_MS
    while (Date.now() < listenBy && !(await listening(port))) await sleep(300)
    note(await listening(port)
      ? `the new instance is listening on port ${port} — restart complete`
      : `the new instance is alive but has not taken port ${port} within ${PORT_RELISTEN_TIMEOUT_MS}ms`)
  }
}

main().catch((error) => {
  note(`helper failed: ${String((error && error.stack) || error)}`)
})
