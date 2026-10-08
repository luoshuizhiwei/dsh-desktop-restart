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
 *   4. 端口迟迟不放时兜底：清掉残留的桌面进程（helper 自己排除在外）；
 *   5. 用干净的环境拉起新实例 —— 必须去掉 ELECTRON_RUN_AS_NODE，否则新的
 *      「应用」会以 Node 模式启动，变成一个没有窗口的进程；
 *   6. 新实例立刻退出就再试，试完还不行才认输并弹窗叫人手动打开 —— 否则
 *      用户只会看到窗口再也没回来，而日志里写着「已拉起」。
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
/** 默认的拉起尝试次数与每次的存活观察窗口。 */
const DEFAULT_RELAUNCH_ATTEMPTS = 3
const DEFAULT_RELAUNCH_VERIFY_MS = 2500
/** 两次拉起尝试之间的间隔。 */
const RELAUNCH_RETRY_GAP_MS = 1500
/** 新实例接管端口的等待上限。 */
const PORT_RELISTEN_TIMEOUT_MS = 20000
/** 查进程表的超时（PowerShell 冷启动约 1 秒，留足余量）。 */
const PROCESS_QUERY_TIMEOUT_MS = 8000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 比较路径时统一分隔符、大小写与尾部分隔符。 */
function normalizePath(value) {
  return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

/**
 * 按 Windows 的规则把命令行拆成参数。
 *
 * 只需要处理常见的两种写法：引号包裹、以及引号里的 `\"`。刻意不实现完整的
 * 反斜杠连写规则 —— 遇到 `\"` 时调用方会直接放弃复用原始参数（见
 * {@link relaunchArgsFrom}），所以这里不需要为罕见形态承担有损解析的风险。
 * @param {string} text - 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
function tokenizeCommandLine(text) {
  const tokens = []
  let current = ''
  let started = false
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '"') {
      current += '"'
      started = true
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * 从主进程的命令行里取出「除可执行文件之外」的启动参数。
 *
 * 重启必须把原来的参数带上：否则一个用 `--user-data-dir` 或别的开关启动的
 * 实例，重启后会悄悄变成默认形态。拿不准就返回 null —— 调用方退回「不带参数
 * 拉起」，也就是 0.1.x 的行为，绝不会因为解析而拉错东西。
 * @param {string | null | undefined} commandLine - 主进程命令行。
 * @param {string} exe - 期望的可执行文件绝对路径。
 * @returns {string[] | null} 参数数组（可能为空），或 null 表示放弃复用。
 */
function relaunchArgsFrom(commandLine, exe) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return null
  // 带转义引号的命令行不做有损解析，直接放弃。
  if (commandLine.includes('\\"')) return null
  const tokens = tokenizeCommandLine(commandLine)
  if (tokens.length === 0) return null
  if (normalizePath(tokens[0]) !== normalizePath(exe)) return null
  const args = tokens.slice(1)
  // 同一个可执行文件有好几种身份：主进程、host、渲染/GPU 子进程都用它。
  // 带上 `--type=` 或 `--expose-internals` 说明抓到的是 Chromium 子进程或宿主，
  // 那不是「用户当初怎么启动这个应用」的答案 —— 宁可退回不带参数。
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null
  }
  return args
}

/**
 * 进程表里哪些 pid 真的属于我们要拉起的那个可执行文件。
 *
 * 兜底强杀原先按映像名匹配，会连「同名但来自别的目录」的副本一起杀掉。
 * 有了可执行文件路径就只杀同一份程序；拿不到路径的条目一律不动。
 * @param {{ pid: number, path: string | null }[]} processes - 进程表。
 * @param {string} exe - 目标可执行文件。
 * @returns {number[]} 应当结束的 pid。
 */
function ownProcessPids(processes, exe) {
  const wanted = normalizePath(exe)
  const pids = []
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 0) continue
    if (typeof entry.path !== 'string' || entry.path === '') continue
    if (normalizePath(entry.path) !== wanted) continue
    pids.push(entry.pid)
  }
  return pids
}

/**
 * 查同名进程的 pid、可执行文件路径与命令行。
 *
 * 用 `-EncodedCommand` 送脚本：Windows 上把带引号的 PowerShell 脚本塞进
 * `-Command` 的转义规则很容易出错，base64 完全绕开它。任何失败都返回 null，
 * 调用方各自退回保守行为（不复用参数、按映像名兜底）。
 * @param {string} exeName - 映像名（含扩展名）。
 * @returns {{ pid: number, path: string | null, commandLine: string | null }[] | null} 进程表，或 null。
 */
function queryApplicationProcesses(exeName) {
  const safeName = String(exeName).replace(/'/gu, "''")
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    `Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  let out = ''
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      break
    } catch (error) {
      out = ''
      if (error && error.code !== 'ENOENT') return null
    }
  }
  const text = out.trim()
  if (text === '') return []
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((entry) => ({
      pid: Number(entry?.ProcessId),
      path: typeof entry?.ExecutablePath === 'string' ? entry.ExecutablePath : null,
      commandLine: typeof entry?.CommandLine === 'string' ? entry.CommandLine : null,
    })).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return null
  }
}

/**
 * 重启没成功时叫人手动打开应用。
 *
 * 只在「主进程已经结束、新实例又起不来」这条路上出现 —— 那时窗口再也不会
 * 回来，日志没人看，弹窗是唯一能把话说到用户眼前的办法。尽力而为：弹不出来
 * 就算了，绝不因此影响别的流程。
 * @param {string} text - 提示内容。
 * @returns {boolean} 是否已把请求发出去。
 */
function alertUser(text) {
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, 'DeepSeek Harness') | Out-Null`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch {
      /* 换下一个 shell */
    }
  }
  return false
}

/**
 * 交接并重启。
 * @param {object} handoff - 交接描述。
 * @param {(line: string) => void} note - 诊断写入。
 * @returns {Promise<void>} 完成（无论成功或已记录失败）。
 */
async function performRestart(handoff, note) {
  const mainPid = Number(handoff.mainPid)
  const exe = String(handoff.exe ?? '')
  const hostPid = Number(handoff.hostPid)
  const port = Number(handoff.port)
  const delayMs = Number(handoff.delayMs) > 0 ? Number(handoff.delayMs) : DEFAULT_DELAY_MS
  const attempts = Number(handoff.relaunchAttempts) > 0 ? Number(handoff.relaunchAttempts) : DEFAULT_RELAUNCH_ATTEMPTS
  const verifyMs = Number(handoff.relaunchVerifyMs) > 0 ? Number(handoff.relaunchVerifyMs) : DEFAULT_RELAUNCH_VERIFY_MS
  const alertOnFailure = handoff.alertOnFailure !== false

  /** 进程是否还活着（信号 0 只做存在性检查）。 */
  const alive = (pid) => {
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
  const listening = (p) => new Promise((resolve) => {
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

  /**
   * 强杀一个 pid。
   * @param {number} pid - 目标。
   * @returns {boolean} taskkill 是否成功。
   */
  const killPid = (pid) => {
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
   * @param {string[]} args - 传给 tasklist 的参数。
   * @returns {{ image: string, pid: number }[]} 进程列表。
   */
  const tasklist = (args) => {
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
  const imageNameOf = (pid) => {
    const found = tasklist(['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'])
      .find((entry) => entry.pid === pid)
    return found === undefined ? null : found.image
  }

  /** 当前所有同名桌面应用进程（含 helper 自己）。 */
  const applicationPids = () => {
    if (exe === '') return []
    return tasklist(['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/FO', 'CSV', '/NH'])
      .map((entry) => entry.pid)
  }

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

  // 1b. 趁主进程还活着，问一次它的命令行与可执行文件路径：重启要带上原参数，
  //     兜底强杀也要按路径认人。查不到就走老路，不影响重启本身。
  const processes = queryApplicationProcesses(path.basename(exe))
  const mainEntry = Array.isArray(processes) ? processes.find((entry) => entry.pid === mainPid) ?? null : null
  const relaunchArgs = relaunchArgsFrom(mainEntry?.commandLine, exe)
  note(relaunchArgs === null
    ? 'launch arguments unavailable; relaunching with no arguments'
    : `preserving ${String(relaunchArgs.length)} launch argument(s): ${JSON.stringify(relaunchArgs)}`)

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
      // 优先只杀「同一份可执行文件」的进程（同名但来自别的目录的副本不动）；
      // 一条路径都拿不到时才退回按映像名匹配 —— 那是唯一还能把应用救回来的办法。
      const own = Array.isArray(processes) ? ownProcessPids(processes, exe) : null
      let candidates
      if (own !== null && own.length > 0) {
        candidates = own
      } else {
        note(own === null ? 'process paths unavailable; falling back to image-name matching' : 'no matching executable path; falling back to image-name matching')
        candidates = applicationPids()
      }
      for (const pid of candidates) {
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

  let childPid = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      note(`relaunch attempt ${attempt}/${attempts} in ${RELAUNCH_RETRY_GAP_MS}ms`)
      await sleep(RELAUNCH_RETRY_GAP_MS)
    }
    let spawned = null
    try {
      const child = spawn(exe, relaunchArgs ?? [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.dirname(exe),
        env,
      })
      child.on('error', (error) => note(`relaunch failed: ${String((error && error.message) || error)}`))
      spawned = child.pid
      child.unref()
      note(`relaunched "${exe}" as pid ${String(spawned)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    } catch (error) {
      note(`relaunch threw: ${String((error && error.stack) || error)}`)
      continue
    }

    // spawn 成功只表示「创建进程的请求发出去了」—— 与交接那一头是同一类问题，
    // 只不过这次在链路的末端。等几秒确认新实例真的还在：它若立刻退出（端口没真正
    // 释放、单实例锁还没放），用户只会看到页面永远不回来，而日志里却写着成功。
    await sleep(verifyMs)
    if (Number.isInteger(spawned) && alive(spawned)) {
      note(`relaunched process (pid ${String(spawned)}) is still alive after ${verifyMs}ms`)
      childPid = spawned
      break
    }
    note(`the relaunched process (pid ${String(spawned)}) is already gone — attempt ${attempt} did not take`)
  }

  if (childPid === null) {
    note(`the restart did not take after ${attempts} attempt(s); the application is not running`)
    if (alertOnFailure) {
      note(alertUser(`重启失败：应用没能自动打开。\n\n请手动启动 DeepSeek Harness（日志：${String(handoff.logPath ?? '')}）。`)
        ? 'failure notice dispatched to the user'
        : 'could not dispatch the failure notice')
    }
    return
  }

  // 再确认它把端口接了过去 —— 那才是「应用真的回来了」。
  if (Number.isInteger(port) && port > 0) {
    const listenBy = Date.now() + PORT_RELISTEN_TIMEOUT_MS
    while (Date.now() < listenBy && !(await listening(port))) await sleep(300)
    note(await listening(port)
      ? `the new instance is listening on port ${port} — restart complete`
      : `the new instance is alive but has not taken port ${port} within ${PORT_RELISTEN_TIMEOUT_MS}ms`)
  }
}

/**
 * 脚本入口：读交接描述，然后动手。
 * @returns {Promise<void>} 完成。
 */
async function start() {
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

  const logPath = String(handoff.logPath ?? '')
  /**
   * 追加一行诊断。日志不可写时静默——诊断失败不该拖垮重启本身。
   * @param {string} line - 内容。
   */
  const note = (line) => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 没有日志也要继续 */
    }
  }

  try {
    await performRestart(handoff, note)
  } catch (error) {
    note(`helper failed: ${String((error && error.stack) || error)}`)
  }
}

if (require.main === module) {
  start().catch(() => { process.exitCode = 0 })
}

module.exports = {
  normalizePath,
  tokenizeCommandLine,
  relaunchArgsFrom,
  ownProcessPids,
  queryApplicationProcesses,
  performRestart,
}
