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
 *   4. 端口迟迟不放时只处理能由 PID、父子关系、路径与创建时间证明属于旧 host 树的进程；
 *      端口属于别的实例或归属无法确认时保留该进程并停止重拉；
 *   5. 用干净的环境拉起新实例 —— 必须去掉 ELECTRON_RUN_AS_NODE，否则新的
 *      「应用」会以 Node 模式启动，变成一个没有窗口的进程；
 *   6. 新实例立刻退出就再试，试完还不行记录诊断并尝试系统通知 —— 否则
 *      用户只会看到窗口再也没回来，而日志里写着「已拉起」。
 *
 * 还有一条贯穿全程的原则：**「问不出来」不等于「没有」**。系统进程表查不到时
 * 返回 null 而不是空列表，调用方据此区分「这个进程已经没了」与「进程表读不到」——
 * 后者若被当成前者，就会跳过结束主进程，随后在旧实例还活着时再拉起一个。
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

/**
 * 从 `netstat -ano` 的输出里挑出「回环（或通配）地址上正在 LISTEN 的 TCP 行」。
 *
 * 用来回答一个问题：**新拉起的实例到底接没接上界面**。0.2.1-rc.2 起桌面版不再
 * 固定用 19387 —— 每次启动挑一个空闲端口（实测 19387 → 14246 → 8418 → 10317），
 * 所以「等旧端口回来」这个判据已经失效，只能反过来找「谁在听」。
 *
 * 解析不出来返回 `null`，与 `tasklist` 那条同一条原则：**「问不出来」不等于
 * 「没有」**。调用方据此说「无法确认」，而不是报「没接回端口」。
 * @param {string} text - `netstat -ano` 的原始输出。
 * @returns {{ port: number, pid: number }[] | null} 监听条目，或 null 表示读不懂。
 */
function parseNetstatListeners(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/u.exec(line)
    if (match === null) continue
    if (!/^(?:127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|\[::\])$/u.test(match[1])) continue
    const port = Number(match[2])
    const pid = Number(match[3])
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue
    rows.push({ port, pid })
  }
  return rows
}

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
 * 拉起新实例时该带的环境：去掉「上一次进程的痕迹」，保留安装身份。
 *
 * 2026-10-21 借鉴 dsh-restart-desktop：除了 Node 模式那两项，还要清掉上一次
 * 宿主的会话 id、已经失效的旧端口地址、以及「我正跑在 DSH shell 里」的标记。
 * `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` 描述的是**安装身份**，必须留下，
 * 否则新实例会去用默认 profile。
 * @param {Record<string, string | undefined>} source - 当前进程的环境。
 * @returns {Record<string, string | undefined>} 清洗后的环境。
 */
function launchEnvFrom(source) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    // Node 模式下这两个变量会跟着继承；不清掉，新实例会变成一个没有窗口的进程。
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'DSH_DESKTOP_NODE_EXECUTABLE') delete env[key]
    // 上一次宿主的痕迹：会话 id 属于旧进程、旧端口已经没人听、shell 标记对新实例是假的。
    if (upper === 'DSH_SESSION_ID' || upper === 'DSH_WEB_URL' || upper === 'DSH_SHELL'
      || upper === 'DSH_DESKTOP_RESTART_ID' || upper === 'DSH_DESKTOP_RESTART_EXE') delete env[key]
  }
  return env
}

/**
 * 从主进程的命令行里取出「除可执行文件之外」的启动参数。
 *
 * 重启必须把原来的参数带上：否则一个用 `--user-data-dir` 或别的开关启动的
 * 实例，重启后会悄悄变成默认形态。拿不准返回 null；调用方拒绝停止旧实例，
 * 以免丢失启动参数或改用错误 profile。
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
  // 那不是「用户当初怎么启动这个应用」的答案，应拒绝继续。
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null
  }
  return args
}

/**
 * 兜底清理时应当结束哪些 pid。
 *
 * 只返回 rootPid 的可验证后代，并要求相同可执行文件路径与不早于父进程的创建时间。
 * 同路径也可能对应不同 profile，因此不以路径单独判断实例归属。
 *
 * @param {{ pid: number, parentPid: number, path: string | null, createdAt: string }[]} processes - 进程表。
 * @param {number} rootPid - 所属实例进程树根。
 * @param {string} exe - 期望的可执行文件。
 * @param {(number | undefined)[]} [skip] - 不参与批量清理的 pid。
 * @returns {number[]} 应当结束的 pid。
 */
function leftoverPids(processes, rootPid, exe, skip = []) {
  const skipSet = new Set((Array.isArray(skip) ? skip : []).filter((pid) => Number.isInteger(pid) && pid > 0))
  return descendantProcesses(processes, rootPid, exe)
    .map((entry) => entry.pid)
    .filter((pid) => !skipSet.has(pid))
}

/** CreationDate is required because a reused PID is not the same process. */
function processStartMs(entry) {
  const value = Date.parse(entry?.createdAt)
  return Number.isFinite(value) ? value : null
}

/** Return same-executable descendants with a provable parent chain and newer start time. */
function descendantProcesses(processes, rootPid, exe) {
  if (!Array.isArray(processes) || !Number.isInteger(rootPid) || rootPid <= 0) return []
  const root = processes.find((entry) => entry?.pid === rootPid)
  const rootStarted = processStartMs(root)
  if (rootStarted === null || normalizePath(root?.path) !== normalizePath(exe)) return []
  const included = new Map([[rootPid, rootStarted]])
  const descendants = []
  let changed = true
  while (changed) {
    changed = false
    for (const entry of processes) {
      if (!Number.isInteger(entry?.pid) || included.has(entry.pid)) continue
      const parentStarted = included.get(entry.parentPid)
      const started = processStartMs(entry)
      if (parentStarted === undefined || started === null || started < parentStarted) continue
      if (normalizePath(entry.path) !== normalizePath(exe)) continue
      included.set(entry.pid, started)
      descendants.push(entry)
      changed = true
    }
  }
  return descendants
}

function sameProcessIdentity(expected, actual) {
  return expected != null && actual != null
    && expected.pid === actual.pid
    && expected.parentPid === actual.parentPid
    && normalizePath(expected.path) === normalizePath(actual.path)
    && processStartMs(expected) !== null
    && processStartMs(expected) === processStartMs(actual)
}

function processIdentityComplete(entry) {
  return Number.isInteger(entry?.pid) && entry.pid > 0
    && Number.isInteger(entry.parentPid) && entry.parentPid >= 0
    && typeof entry.path === 'string' && entry.path !== ''
    && processStartMs(entry) !== null
}

function processIdentityState(processes, expected) {
  if (!Array.isArray(processes)) return 'unknown'
  if (!processIdentityComplete(expected)) return 'unknown'
  const actual = processOf(processes, expected?.pid)
  if (actual === null) return 'absent'
  if (!processIdentityComplete(actual)) return 'unknown'
  return sameProcessIdentity(expected, actual) ? 'same' : 'different'
}

function processOf(processes, pid) {
  return Array.isArray(processes) ? processes.find((entry) => entry.pid === pid) ?? null : null
}

function hostTreeOf(processes, mainPid, exe, minStartMs = null) {
  const main = processOf(processes, mainPid)
  if (main === null || processStartMs(main) === null || normalizePath(main.path) !== normalizePath(exe)) return null
  if (minStartMs !== null && processStartMs(main) < minStartMs) return null
  const descendants = descendantProcesses(processes, mainPid, exe)
  const host = descendants.find((entry) => entry.commandLine !== null
    && entry.parentPid === mainPid
    && tokenizeCommandLine(entry.commandLine).includes('--expose-internals'))
  return host === undefined ? null : { main, host, descendants }
}

/**
 * 查同名进程的 pid、父 pid、可执行文件路径、命令行与创建时间。
 *
 * 用 `-EncodedCommand` 送脚本：Windows 上把带引号的 PowerShell 脚本塞进
 * `-Command` 的转义规则很容易出错，base64 完全绕开它。任何失败都返回 null，
 * 身份查询失败时调用方保留进程并报告无法确认，不按映像名扩大操作范围。
 * @param {string} exeName - 映像名（含扩展名）。
 * @returns {{ pid: number, parentPid: number, path: string | null, commandLine: string | null, createdAt: string | null }[] | null} 进程表，或 null。
 */
function queryApplicationProcesses(exeName) {
  const safeName = String(exeName).replace(/'/gu, "''")
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    `Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | ForEach-Object { [PSCustomObject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; ExecutablePath=$_.ExecutablePath; CommandLine=$_.CommandLine; CreatedAt=$_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress`,
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
    const rows = list.map((entry) => ({
      pid: Number(entry?.ProcessId),
      parentPid: Number(entry?.ParentProcessId),
      path: typeof entry?.ExecutablePath === 'string' ? entry.ExecutablePath : null,
      commandLine: typeof entry?.CommandLine === 'string' ? entry.CommandLine : null,
      createdAt: typeof entry?.CreatedAt === 'string' ? entry.CreatedAt : null,
    }))
    return rows.every(processIdentityComplete) ? rows : null
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
/** Public notification content uses a fixed reason vocabulary, never raw logs. */
const NOTICE_REASONS = {
  'bad-handoff': '交接信息不完整，未执行重启',
  'identity-changed': '执行前进程身份已变化，已停止操作',
  'port-held': '旧实例端口尚未释放，已停止操作',
  'identity-unproven': '无法证明进程属于本实例，已停止操作',
  'args-uncertain': '无法可靠恢复启动参数，未继续重启',
  'stop-failed': '旧实例未能关闭，请手动核对',
  'host-kill-failed': '旧宿主未能结束，请手动核对',
  'port-foreign': '端口属于其他实例，已停止操作',
  'port-unowned': '无法证明端口归属，已停止操作',
  'relaunch-failed': '应用未能自动打开，请手动启动',
  'ready-port-missing': '新进程已启动，但未能确认界面服务就绪',
  'ready-unverifiable': '无法查询监听状态，重启结果尚未确认',
  'ready-unconfirmed': '宿主或重启客户端尚未确认恢复，请手动核对应用',
  'helper-exited': '辅助进程已退出，结果尚未确认',
  'record-missing': '操作记录缺失，结果尚未确认',
  'timeout': '交接超过预算，结果尚未确认',
  'helper-spawn-failed': '辅助进程未能启动',
  'helper-died': '辅助进程提前退出',
  'state-write-failed': '操作记录保存失败',
  'helper-error': '辅助进程出现异常，请查看诊断',
}
function toastScript(record, documentPath, deliveryPath) {
  const ps = value => "'" + String(value).replaceAll("'", "''") + "'"
  const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
  const payload = '<toast duration="long"><visual><binding template="ToastGeneric"><text>DSH 重启诊断</text><text>' + xml(record.summary) + '</text><text>点击只查看诊断；不会重新启动应用或模型。</text></binding></visual></toast>'
  return `
$ErrorActionPreference = 'Stop'
function Delivery([string]$status, [string]$code) {
  $json = @{status=$status;code=$code} | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText(${ps(deliveryPath)}, $json)
}
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
public static class DshRestartDiagnosticClick {
  public static string Document;
  public static readonly ManualResetEvent Done = new ManualResetEvent(false);
  public static void Activated(object sender, object args) {
    try { Process.Start(new ProcessStartInfo { FileName = Document, UseShellExecute = true }); }
    finally { Done.Set(); }
  }
}
'@
  [DshRestartDiagnosticClick]::Document = ${ps(documentPath)}
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml(${ps(payload)})
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $type = [Windows.Foundation.TypedEventHandler[Windows.UI.Notifications.ToastNotification,Object]]
  $handler = [Delegate]::CreateDelegate($type, [DshRestartDiagnosticClick].GetMethod('Activated'))
  $toast.add_Activated($handler) | Out-Null
  $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(10)
  $app = Get-StartApps | Where-Object { $_.AppID -like '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}*WindowsPowerShell*powershell.exe' } | Select-Object -First 1
  if ($null -eq $app) { throw 'notification-identity-unavailable' }
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app.AppID)
  if ($null -ne $notifier.Setting -and [int]$notifier.Setting -ne 0) { Delivery 'failed' 'notifications-disabled'; exit }
  $notifier.Show($toast)
  Delivery 'submitted' 'visibility-unconfirmed'
  [DshRestartDiagnosticClick]::Done.WaitOne(600000) | Out-Null
} catch { Delivery 'failed' 'toast-unavailable' }
`
}
function sendWindowsNotice(record, paths) {
  const encoded = Buffer.from(toastScript(record, paths.document, paths.delivery), 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {
    try { fs.writeFileSync(paths.delivery, JSON.stringify({ status: 'failed', code: 'toast-process-failed' }), 'utf8') }
    catch { /* Unread record already exists; the host treats missing delivery status as unconfirmed. */ }
  })
  child.unref()
  return { status: 'pending', code: 'visibility-unconfirmed' }
}
function createNoticeStore({ dir, profileId, io = fs, send = sendWindowsNotice }) {
  const prefix = 'notice-' + profileId + '-'
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/u.test(value)
  const location = id => ({ record:path.join(dir,id+'.json'), document:path.join(dir,id+'.html'), delivery:path.join(dir,id+'.delivery'), read:path.join(dir,id+'.read') })
  const parse = file => JSON.parse(io.readFileSync(file,'utf8'))
  let index = null
  let indexAt = 0
  let directoryKey = null
  let entries = []
  const parsedRecords = new Map()
  const parsedDeliveries = new Map()
  function invalidate() { index = null }
  function metadata(file) {
    try {
      const info=io.statSync(file)
      return String(info.mtimeMs)+':'+String(info.ctimeMs)+':'+String(info.size)
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  function list() {
    const now=Date.now(), key=metadata(dir)
    let refreshed=false
    if (index === null || key !== directoryKey || now < indexAt || now-indexAt >= 2000) {
      try { index=new Set(io.readdirSync(dir)) }
      catch (error) { if (error.code === 'ENOENT') {index=new Set();return []}; throw error }
      indexAt=now
      directoryKey=key
      entries=[...index].filter(name=>name.startsWith(prefix) && name.endsWith('.json'))
        .map(name=>({id:name.slice(0,-5),paths:location(name.slice(0,-5))}))
      refreshed=true
    }
    const records = []
    for (const {id,paths} of entries) {
      let cached=parsedRecords.get(id)
      // Records are immutable after creation. Revalidate them with the directory index
      // or after its two-second TTL; delivery files remain live on every read.
      if (refreshed || !cached) {
        const recordKey=metadata(paths.record)
        if (recordKey === null) {parsedRecords.delete(id);parsedDeliveries.delete(id);continue}
        if (cached?.key !== recordKey) {
          let record
          try { record=parse(paths.record) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
          cached={key:recordKey,value:record}
          parsedRecords.set(id,cached)
        }
      }
      const record=cached.value
      if (record.profileId !== profileId || record.id !== id) continue
      let delivery={status:'pending',code:'visibility-unconfirmed'}
      const deliveryKey=metadata(paths.delivery)
      if (deliveryKey !== null) {
        let saved=parsedDeliveries.get(id)
        if (saved?.key !== deliveryKey) {
          try {
            const raw=parse(paths.delivery)
            saved={key:deliveryKey,value:['pending','submitted','failed'].includes(raw.status)?{status:raw.status,code:['notifications-disabled','toast-unavailable','toast-process-failed','visibility-unconfirmed','diagnostic-write-failed'].includes(raw.code)?raw.code:'toast-unavailable'}:delivery}
          } catch (error) { saved={key:deliveryKey,value:error.code === 'ENOENT'?delivery:{status:'failed',code:'toast-unavailable'}} }
          parsedDeliveries.set(id,saved)
        }
        delivery=saved.value
      } else parsedDeliveries.delete(id)
      records.push({id,result:record.result,reason:record.reason,summary:record.summary,at:record.at,
        details:{...record.details,stages:{...record.details?.stages}},unread:!index.has(id+'.read'),delivery:{...delivery}})
    }
    return records.sort((a,b)=>b.at.localeCompare(a.at))
  }
  function pruneRead() {
    const retired=list().filter(record=>!record.unread).slice(50).reverse()
    for (const record of retired) {
      const paths=location(record.id)
      // Recheck the read marker at the deletion boundary; never retire unread records.
      if (!io.existsSync(paths.read)) continue
      for (const kind of ['document','delivery','record','read']) {
        try { io.unlinkSync(paths[kind]) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      parsedRecords.delete(record.id)
      parsedDeliveries.delete(record.id)
      invalidate()
    }
  }
  function ensure(op) {
    if (!safeId(op?.id) || !['failed','unknown'].includes(op.result)) return null
    const id=prefix+op.id+'-'+op.result, paths=location(id)
    const reason=Object.hasOwn(NOTICE_REASONS,op.reason)?op.reason:'unknown-reason'
    const summary=(NOTICE_REASONS[reason] || '重启结果异常，请手动查看诊断')+'（'+reason+'）'
    const stages={}
    for (const stage of ['verify','stop','portWait','launch','ready']) if (Number.isFinite(op.stages?.[stage]) && op.stages[stage]>=0) stages[stage]=op.stages[stage]
    const record={schema:1,id,profileId,result:op.result,reason,summary,at:new Date().toISOString(),details:{result:op.result,reason,stages}}
    try {
      io.mkdirSync(dir,{recursive:true})
      io.writeFileSync(paths.record,JSON.stringify(record),{encoding:'utf8',flag:'wx'})
    } catch (error) {
      if (error.code === 'EEXIST') { if (!parsedRecords.has(id)) invalidate(); return null }
      return {code:'notice-write-failed'}
    }
    invalidate()
    let deliveryError = null
    try {
      const details=JSON.stringify(record.details,null,2).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      io.writeFileSync(paths.document,'<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>DSH 重启诊断</title><body><h1>'+summary+'</h1><p>此页只展示脱敏诊断，不执行重启或模型动作。已读请在插件中明确标记。</p><details open><summary>诊断详情</summary><pre>'+details+'</pre></details></body></html>','utf8')
      const status=send(record,paths)
      // The asynchronous sender owns delivery updates; never overwrite them after spawn.
      if (status?.status === 'failed') io.writeFileSync(paths.delivery,JSON.stringify(status),'utf8')
    } catch {
      try { io.writeFileSync(paths.delivery,JSON.stringify({status:'failed',code:'diagnostic-write-failed'}),'utf8') } catch { deliveryError = {code:'notice-delivery-write-failed'} }
    }
    try { pruneRead() } catch { return {code:'notice-prune-failed'} }
    return deliveryError
  }
  function markRead(id) {
    const record=list().find(item=>item.id===id)
    if (!record) return false
    io.writeFileSync(location(id).read,JSON.stringify({at:new Date().toISOString()}),'utf8')
    invalidate()
    pruneRead()
    return true
  }
  return {ensure,list,markRead}
}


/** Conservative loopback Cookie header estimate; encrypted storage is never decrypted. */
function authCookieSample(db) {
  const row = db.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(name AS BLOB)) + 1 + max(length(CAST(value AS BLOB)), length(encrypted_value))),0) AS bytes, coalesce(sum(CASE WHEN name LIKE 'dsh-auth-%' AND substr(name,1,9)='dsh-auth-' THEN 1 ELSE 0 END),0) AS authCount FROM cookies WHERE host_key='127.0.0.1'").get()
  const estimatedBytes = Number(row.bytes) + Math.max(0, Number(row.count) - 1) * 2 + 350
  return { cookieCount: Number(row.count), authCount: Number(row.authCount), estimatedBytes,
    status: estimatedBytes > 16384 ? 'exceeded' : estimatedBytes >= 16384 * 0.8 ? 'near' : 'normal' }
}

/** Only called in the verified downtime window; failures are optional-feature results. */
async function checkAuthCookies(options, note = () => {}, loadSqlite = () => require('node:sqlite')) {
  const checkedAt = new Date().toISOString()
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(options.statePath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') note(`auth-cookie: previous record unreadable (${error.code ?? error.name})`) }
  const result = { schema: 1, checkedAt, status: 'unavailable', reason: null, errorCode: null,
    limitBytes: 16384, sample: previous?.sample ?? null, backup: { enabled: options.backup === true, performed: false }, cleanup: { enabled: false, performed: false, removed: 0 } }
  let db
  let stage = 'sqlite-unavailable'
  try {
    if (options.blocked) { stage = 'old-instance-running'; throw new Error(stage) }
    if (!options.databasePath || !fs.existsSync(options.databasePath)) { stage = 'database-missing'; throw new Error(stage) }
    const { DatabaseSync, backup } = loadSqlite()
    stage = 'database-unavailable'
    db = new DatabaseSync(options.databasePath, { readOnly: true })
    result.sample = { ...authCookieSample(db), checkedAt }
    result.status = result.sample.status
    if (options.backup === true) {
      stage = 'backup-failed'
      fs.mkdirSync(options.backupDir, { recursive: true })
      const backupFile = `auth-cookie-${Date.now()}-${process.pid}.sqlite`
      await backup(db, path.join(options.backupDir, backupFile))
      result.backup.backupFile = backupFile
      stage = 'backup-retention-failed'
      const backups = fs.readdirSync(options.backupDir).filter(name => /^auth-cookie-\d+-\d+\.sqlite$/u.test(name))
        .sort((a,b) => Number(b.split('-')[2]) - Number(a.split('-')[2]) || b.localeCompare(a))
      for (const file of backups.slice(3)) fs.unlinkSync(path.join(options.backupDir, file))
      result.backup.performed = true
    }
  } catch (error) {
    result.status = 'unavailable'; result.reason = stage; result.errorCode = String(error.code ?? error.name)
    note(`auth-cookie: ${stage} (${result.errorCode}): ${error.message}; restart continues`)
  } finally {
    if (db) {
      try { db.close() }
      catch (error) {
        result.closeErrorCode = String(error.code ?? error.name)
        if (result.status !== 'unavailable') { result.status = 'unavailable'; result.reason = 'database-close-failed'; result.errorCode = result.closeErrorCode }
        note(`auth-cookie: close failed (${result.closeErrorCode})`)
      }
    }
  }
  try {
    fs.mkdirSync(path.dirname(options.statePath), { recursive: true })
    const temporary = options.statePath + '.tmp-' + String(process.pid)
    fs.writeFileSync(temporary, JSON.stringify(result), 'utf8'); fs.renameSync(temporary, options.statePath)
  } catch (error) { note(`auth-cookie: record write failed (${error.code ?? error.name}); restart continues`) }
  return result
}

/**
 * 交接并重启。
 * @param {object} handoff - 交接描述。
 * @param {(line: string) => void} note - 诊断写入。
 * @returns {Promise<void>} 完成（无论成功或已记录失败）。
 */
async function performRestart(handoff, note) {
  const lock = handoff.restartLock
  try {
  if (lock) {
    try {
      const record = JSON.parse(fs.readFileSync(lock.path, 'utf8'))
      if (record.token !== lock.token) { note('refusing: restart lock ownership changed; no process stopped'); return }
      // The helper owns the lock before the old host can exit.
      const temporary = lock.path + '.' + process.pid + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify({...record,pid:process.pid}), 'utf8')
      fs.renameSync(temporary, lock.path)
    } catch (error) { note(`refusing: restart lock transfer failed (${error.code ?? error.name}); no process stopped`); return }
  }
  return await performRestartCore(handoff, note)
  }
  finally {
    if (lock) {
      try {
        const record = JSON.parse(fs.readFileSync(lock.path, 'utf8'))
        if (record.token === lock.token) fs.unlinkSync(lock.path)
      } catch (error) { if (error.code !== 'ENOENT') note(`restart lock release failed (${error.code ?? error.name})`) }
    }
  }
}

async function performRestartCore(handoff, note) {
  const mainPid = Number(handoff.mainPid)
  const exe = String(handoff.exeFromEnv === true ? process.env.DSH_DESKTOP_RESTART_EXE ?? '' : handoff.exe ?? '')
  const hostPid = Number(handoff.hostPid)
  const port = Number(handoff.port)
  const delayMs = Number(handoff.delayMs) > 0 ? Number(handoff.delayMs) : DEFAULT_DELAY_MS
  const attempts = Number(handoff.relaunchAttempts) > 0 ? Number(handoff.relaunchAttempts) : DEFAULT_RELAUNCH_ATTEMPTS
  const verifyMs = Number(handoff.relaunchVerifyMs) > 0 ? Number(handoff.relaunchVerifyMs) : DEFAULT_RELAUNCH_VERIFY_MS
  // 三个等待上限同样可以被交接描述覆盖：冒烟测试要靠它把「端口迟迟不放」那条
  // 兜底路径在几百毫秒内跑完，而不是真的等满 30 秒。缺省仍是正式的那三个值。
  const mainExitTimeoutMs = Number(handoff.mainExitTimeoutMs) > 0 ? Number(handoff.mainExitTimeoutMs) : MAIN_EXIT_TIMEOUT_MS
  const portFreeTimeoutMs = Number(handoff.portFreeTimeoutMs) > 0 ? Number(handoff.portFreeTimeoutMs) : PORT_FREE_TIMEOUT_MS
  const portRelistenTimeoutMs = Number(handoff.portRelistenTimeoutMs) > 0 ? Number(handoff.portRelistenTimeoutMs) : PORT_RELISTEN_TIMEOUT_MS
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

  /** Re-read identity immediately before a PID-based force kill. */
  const killVerified = (expected) => {
    const identity = processIdentityState(queryApplicationProcesses(path.basename(exe)), expected)
    if (identity === 'absent') return true
    if (identity !== 'same') return false
    try {
      execFileSync('taskkill', ['/PID', String(expected.pid), '/F'], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 当前所有「在回环地址上 LISTEN 的端口」及其归属进程；netstat 不可用时回 null。
   * @returns {{ port: number, pid: number }[] | null} 条目，或 null 表示问不出来。
   */
  const listListening = () => {
    try {
      const out = execFileSync('netstat', ['-ano'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
      })
      return parseNetstatListeners(out)
    } catch {
      return null
    }
  }

  note(`helper started: helper=${process.pid} host=${hostPid} main=${mainPid} port=${port} exe=${path.basename(exe)}`)

  // ── 操作记录（DR-OPT-02 第 1 项）────────────────────────────────────
  // 宿主在 202 之后靠这份文件知道「核验/关闭/拉起/就绪」走到哪、成没成。
  // 只写阶段、结果、原因码与耗时：不写命令行、不写凭据、不写私有路径。
  const opPath = typeof handoff.opPath === 'string' ? handoff.opPath : ''
  // 兼容旧宿主（2026-10-22 真机发现）：升级到带操作记录的版本时，**正在跑的旧宿主**
  // 不知道 opPath，交接里没有这个字段。上一版把「没有路径」当成「写失败」然后拒绝
  // 执行 —— 结果是升级后第一次重启永远失败（应用没重启，新宿主也就上不来），
  // 形成死锁。正确语义：
  //   opPath 为空   → 旧宿主，记录能力不存在：不要求持久化，只记一条日志；
  //   opPath 有值但写失败 → 新宿主，必须在动进程前停下（保持原样）。
  let legacyNoOpState = opPath === ''
  const notices = createNoticeStore({ dir: path.dirname(opPath || handoff.logPath || '.'), profileId: String(handoff.profileId ?? 'legacy') })
  const writeOp = (patch) => {
    if (opPath === '') {
      if (legacyNoOpState) {
        legacyNoOpState = false
        note('legacy handoff: no operation-state path was provided by the host; continuing without state records')
      }
      return true
    }
    try {
      let previous = {}
      try { previous = JSON.parse(fs.readFileSync(opPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') { note(`operation record read failed: ${error.code ?? error.name}; original record preserved`); return false } }
      const merged = {
        ...previous,
        ...patch,
        id: typeof handoff.restartId === 'string' ? handoff.restartId : String(previous.id ?? ''),
        schema: 1,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        stages: { ...(previous.stages ?? {}), ...(patch.stages ?? {}) },
      }
      const temporary = `${opPath}.${String(process.pid)}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(merged), 'utf8')
      fs.renameSync(temporary, opPath)
      if (alertOnFailure && ['failed','unknown'].includes(patch.result)) {
        const error=notices.ensure(merged)
        if (error) note('notification persistence failed: '+error.code)
      }
      return true
    } catch (error) {
      note(`operation record write failed: ${error.code ?? error.name}`)
      return false
    }
  }
  /** 记一个阶段的耗时（毫秒）并落盘。 */
  const markStage = (name, sinceMs) => {
    if (!writeOp({ stages: { [name]: Math.max(0, Date.now() - sinceMs) } })) note(`stage ${name}: timing could not be persisted`)
  }
  /** 以明确原因失败：界面据此显示可读原因，而不是停在「已排程」。 */
  const fail = (reason, phase = 'failed') => {
    const saved = writeOp({ phase, result: 'failed', reason })
    if (!saved) note(`result could not be persisted: failed/${reason}`)
    return saved
  }

  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    note('refusing: the handoff carries no usable main process id')
    fail('bad-handoff')
    return
  }
  if (exe === '') {
    note('refusing: the handoff carries no application executable')
    fail('bad-handoff')
    return
  }
  if (!writeOp({ phase: 'verify', result: 'pending', reason: null, pid: process.pid, helperVerified: false })) {
    note('refusing: operation state could not be persisted; no process was stopped')
    return
  }
  const verifyStartedAt = Date.now()

  // 1. 先让浏览器拿到「已排程重启」的响应。
  await sleep(delayMs)

  // 1b. 只在 WMI 能证明 main -> host -> helper 的 PID、路径、父子关系和创建时间时继续。
  //     进程表读不全时不按 PID、映像名或同路径猜实例。
  const processes = queryApplicationProcesses(path.basename(exe))
  const tree = hostTreeOf(processes, mainPid, exe)
  const helperEntry = processOf(processes, process.pid)
  if (tree === null || tree.host.pid !== hostPid || helperEntry === null
    || helperEntry.parentPid !== hostPid || normalizePath(helperEntry.path) !== normalizePath(exe)
    || processStartMs(helperEntry) < processStartMs(tree.host)) {
    note('refusing: process ancestry, executable path, or creation time could not prove this handoff belongs to the target instance')
    fail('identity-unproven')
    return
  }
  if (!writeOp({
    pid: process.pid,
    helperIdentity: {
      pid: helperEntry.pid,
      parentPid: helperEntry.parentPid,
      path: helperEntry.path,
      createdAt: helperEntry.createdAt,
    },
    helperVerified: true,
    phase: 'verify',
    result: 'pending',
  })) {
    note('refusing: verified helper identity could not be persisted; no process was stopped')
    return
  }
  markStage('verify', verifyStartedAt)
  const { main: mainEntry, host: hostEntry } = tree
  const relaunchArgs = relaunchArgsFrom(mainEntry.commandLine, exe)
  if (relaunchArgs === null) {
    // 原命令行读不出来 = 无法证明重启后仍是同一个启动形态（--user-data-dir 之类的
    // 参数可能丢）。这时**不结束旧实例**，明确告诉用户「没有执行」及原因。
    note('refusing: launch arguments could not be recovered; not stopping the instance')
    if (!writeOp({ argsPreserved: false })) note('argument preservation result could not be persisted')
    fail('args-uncertain')
    return
  }
  if (!writeOp({ argsPreserved: relaunchArgs !== null })) {
    note('refusing: launch argument status could not be persisted; no process was stopped')
    return
  }
  note(relaunchArgs === null
    ? 'launch arguments unavailable; relaunching with no arguments (explicitly allowed)'
    : `preserving ${String(relaunchArgs.length)} launch argument(s); values redacted`)

  // 2. 重查 PID 身份后结束 main（不带 /T），让 host 自己优雅关闭。
  if (!writeOp({ phase: 'stop' })) {
    note('refusing: stop phase could not be persisted; no process was stopped')
    return
  }
  const stopStartedAt = Date.now()
  const mainState = processIdentityState(queryApplicationProcesses(path.basename(exe)), mainEntry)
  if (mainState === 'same') {
    note(`ending verified Electron main ${mainPid} without /T, so its host can close gracefully`)
    note(killVerified(mainEntry) ? `taskkill /PID ${mainPid} /F ok` : `verified main ${mainPid} could not be ended`)
  } else if (mainState === 'absent' && !alive(mainPid)) {
    note(`verified main ${mainPid} is already gone; skipping the kill`)
  } else {
    note(`refusing: main process identity is ${mainState}; no process was killed`)
    fail('identity-changed')
    return
  }

  // 3. 等主进程消失。
  const goneBy = Date.now() + mainExitTimeoutMs
  while (Date.now() < goneBy && alive(mainPid)) await sleep(200)
  note(alive(mainPid) ? `main process still alive after ${mainExitTimeoutMs}ms` : 'main process exited')
  if (alive(mainPid)) {
    note('restart aborted: verified main process did not exit')
    fail('stop-failed')
    return
  }
  markStage('stop', stopStartedAt)

  // 4. 等端口释放；迟迟不放就兜底清理残留进程。
  if (!writeOp({ phase: 'port-wait' })) {
    note('restart interrupted: port-wait phase could not be persisted')
    return
  }
  const portWaitStartedAt = Date.now()
  if (Number.isInteger(port) && port > 0) {
    const freeBy = Date.now() + portFreeTimeoutMs
    while (Date.now() < freeBy && await listening(port)) await sleep(300)
    if (await listening(port)) {
      note(`port ${port} is still held; checking only descendants of verified host ${hostEntry.pid}`)
      const descendants = leftoverPids(processes, hostEntry.pid, exe, [process.pid])
      for (const pid of descendants) {
        const expectedProcess = processOf(processes, pid)
        if (expectedProcess === null) continue
        note(`ending verified host descendant ${pid}`)
        if (!killVerified(expectedProcess)) note(`skipped pid ${pid}: current process identity no longer matches the snapshot`)
      }
      await sleep(1500)
      if (await listening(port)) {
        const held = listListening()
        const owners = held === null ? null : held.filter((entry) => entry.port === port)
        const hostStillVerified = processIdentityState(queryApplicationProcesses(path.basename(exe)), hostEntry) === 'same'
        if (owners !== null && owners.length > 0 && owners.every((entry) => entry.pid === hostPid)
          && hostStillVerified && alive(hostPid)) {
          note(`verified host ${hostPid} still owns port ${port}; ending as a last resort — session logs may be incomplete`)
          if (!killVerified(hostEntry)) {
            note(`restart aborted: host ${hostPid} identity changed before the last-resort kill`)
            // F5 返修：兜底结束失败也必须落终态，不能让记录停在 port-wait/pending。
            fail('host-kill-failed')
            return
          }
          note(`taskkill /PID ${hostPid} /F ok`)
          await sleep(1500)
          if (await listening(port)) {
            note(`restart aborted: port ${port} remains occupied after the verified host exited`)
            fail('port-held')
            return
          }
        } else {
          note(`restart aborted: port ${port} remains occupied, but ownership by this instance could not be proved`)
          fail('port-foreign')
          return
        }
      } else {
        note(`port ${port} released by verified instance descendants`)
      }
    } else {
      note(`port ${port} released`)
    }
  }

  markStage('portWait', portWaitStartedAt)

  // 5. 给文件系统和端口一点收尾时间，然后拉起新实例。
  await sleep(800)
  if (handoff.authCookie) {
    const options = { ...handoff.authCookie }
    const userDataAt = relaunchArgs.findIndex(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
    if (userDataAt !== -1) {
      const arg = relaunchArgs[userDataAt]
      const userData = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : relaunchArgs[userDataAt + 1]
      // Relative or absent custom roots are not a safe database target.
      options.databasePath = typeof userData === 'string' && path.isAbsolute(userData) ? path.join(userData, 'Network', 'Cookies') : null
    }
    const remaining = queryApplicationProcesses(path.basename(exe))
    // main has already exited. Its absence cannot prove that its old host/GPU/
    // network children exited: use the identities captured BEFORE stopping it.
    const oldInstance = [mainEntry, ...tree.descendants].filter(entry => entry.pid !== process.pid)
    options.blocked = remaining === null || oldInstance.some(expected => {
      const identity = processIdentityState(remaining, expected)
      return identity === 'same' || identity === 'unknown'
    }) || remaining.some(entry => entry.pid !== process.pid
      && oldInstance.some(parent => entry.parentPid === parent.pid
        && processStartMs(entry) >= processStartMs(parent)))
    await checkAuthCookies(options, note)
  }
  if (!writeOp({ phase: 'launch' })) {
    note('restart interrupted: launch phase could not be persisted')
    return
  }
  const launchPhaseStartedAt = Date.now()

  const env = launchEnvFrom(process.env)
  if (typeof handoff.restartId === 'string' && handoff.restartId !== '') {
    env.DSH_DESKTOP_RESTART_ID = handoff.restartId
  }

  let childPid = null
  let childStartAt = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      note(`relaunch attempt ${attempt}/${attempts} in ${RELAUNCH_RETRY_GAP_MS}ms`)
      await sleep(RELAUNCH_RETRY_GAP_MS)
    }
    let spawned = null
    const launchStartedAt = Date.now()
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
      note(`relaunched "${path.basename(exe)}" as pid ${String(spawned)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    } catch (error) {
      note(`relaunch threw: ${error.code ?? error.name ?? "unknown-error"}; details redacted`)
      continue
    }

    // spawn 成功只表示「创建进程的请求发出去了」—— 与交接那一头是同一类问题，
    // 只不过这次在链路的末端。等几秒确认新实例真的还在：它若立刻退出（端口没真正
    // 释放、单实例锁还没放），用户只会看到页面永远不回来，而日志里却写着成功。
    await sleep(verifyMs)
    if (Number.isInteger(spawned) && alive(spawned)) {
      note(`relaunched process (pid ${String(spawned)}) is still alive after ${verifyMs}ms`)
      childPid = spawned
      childStartAt = launchStartedAt
      break
    }
    note(`the relaunched process (pid ${String(spawned)}) is already gone — attempt ${attempt} did not take`)
  }

  if (childPid === null) {
    note(`the restart did not take after ${attempts} attempt(s); the application is not running`)
    markStage('launch', launchPhaseStartedAt)
    fail('relaunch-failed')
    return
  }

  // A listener proves transport only. Require the nonce-bound host receipt and
  // this restart client's acknowledgement before reporting recovery.
  const listenBy = Date.now() + portRelistenTimeoutMs
  let readyPort = null
  let tableReadable = false
  let receiptReadError = null
  while (Date.now() < listenBy) {
    const entries = listListening()
    if (entries !== null) {
      tableReadable = true
      const freshProcesses = queryApplicationProcesses(path.basename(exe))
      const newTree = hostTreeOf(freshProcesses, childPid, exe, childStartAt - 2000)
      if (newTree !== null) {
        const servingPids = new Set([
          newTree.host.pid,
          ...descendantProcesses(freshProcesses, newTree.host.pid, exe).map((entry) => entry.pid),
        ])
        const candidates = entries.filter((entry) => servingPids.has(entry.pid) && entry.pid !== childPid)
        let receipt = null
        if (opPath !== '') {
          try { receipt = JSON.parse(fs.readFileSync(opPath, 'utf8')); receiptReadError = null }
          catch (error) {
            const code = String(error.code ?? error.name)
            if (receiptReadError !== code) note(`readiness receipt unavailable (${code})`)
            receiptReadError = code
          }
        }
        if (candidates.length > 0 && receipt?.id === handoff.restartId
          && receipt.profileId === handoff.profileId && receipt.readyHostPid === newTree.host.pid
          && Date.parse(receipt.hostReadyAt) >= childStartAt
          && Date.parse(receipt.hostReadyAt) >= processStartMs(newTree.host)
          && Date.parse(receipt.clientReadyAt) >= Date.parse(receipt.hostReadyAt)) {
          readyPort = candidates[0].port
          break
        }
      }
    }
    // 每轮查询 netstat 和 CIM 进程身份，间隔 500ms，避免高频启动查询进程。
    // 进程，而应用就绪通常要几秒 —— 降一半进程创建，几乎不损失及时性。
    await sleep(500)
  }
  markStage('launch', launchPhaseStartedAt)
  if (!writeOp({ phase: 'ready' })) note('stage ready could not be persisted')
  const readyStartedAt = Date.now()
  if (readyPort !== null) {
    note(`the new instance host and restart client acknowledged recovery on port ${readyPort} — restart complete`)
    markStage('ready', readyStartedAt)
    if (!writeOp({ phase: 'done', result: 'ok', reason: null, readyPort })) note('result could not be persisted: ok; restart itself completed')
  } else if (tableReadable) {
    note(`the new instance is alive but verified host/client recovery was not acknowledged within ${portRelistenTimeoutMs}ms`)
    markStage('ready', readyStartedAt)
    // 进程活着但界面没接上：不能报成功，也不能报失败 —— 结果未知。
    if (!writeOp({ phase: 'unknown', result: 'unknown', reason: 'ready-unconfirmed' })) note('result could not be persisted: unknown/ready-unconfirmed')
  } else {
    note('the new instance is alive; the listening port table could not be read, so readiness is unknown')
    markStage('ready', readyStartedAt)
    if (!writeOp({ phase: 'unknown', result: 'unknown', reason: 'ready-unverifiable' })) note('result could not be persisted: unknown/ready-unverifiable')
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
   * 追加一行诊断。日志不可写时输出 stderr；诊断失败不改变重启结果。
   * @param {string} line - 内容。
   */
  const note = (line) => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch (error) {
      console.error(`restart log unavailable (${error.code ?? error.name}): ${line}`)
    }
  }

  try {
    await performRestart(handoff, note)
  } catch (error) {
    note(`helper failed: ${error.code ?? error.name ?? "unknown-error"}; details redacted`)
    process.exitCode = 1
    if (typeof handoff.opPath === 'string' && handoff.opPath !== '') {
      try {
        const previous = JSON.parse(fs.readFileSync(handoff.opPath, 'utf8'))
        const failed = {...previous, phase:'unknown', result:'unknown', reason:'helper-error', updatedAt:new Date().toISOString()}
        const temporary = `${handoff.opPath}.${process.pid}.tmp`
        fs.writeFileSync(temporary, JSON.stringify(failed), 'utf8')
        fs.renameSync(temporary, handoff.opPath)
        const notices = createNoticeStore({dir:path.dirname(handoff.opPath),profileId:String(handoff.profileId ?? 'legacy')})
        const notificationError = notices.ensure(failed)
        if (notificationError) note('helper error notification failed: ' + notificationError.code)
      } catch (recordError) { note(`helper error record failed: ${recordError.code ?? recordError.name ?? "unknown-error"}`) }
    }
  }
}

if (require.main === module) {
  start().catch(error => { console.error(error); process.exitCode = 1 })
}

module.exports = {
  normalizePath,
  tokenizeCommandLine,
  relaunchArgsFrom,
  launchEnvFrom,
  leftoverPids,
  descendantProcesses,
  hostTreeOf,
  sameProcessIdentity,
  processIdentityState,
  parseNetstatListeners,
  queryApplicationProcesses,
  performRestart,
  authCookieSample,
  checkAuthCookies,
  createNoticeStore,
  toastScript,
}
