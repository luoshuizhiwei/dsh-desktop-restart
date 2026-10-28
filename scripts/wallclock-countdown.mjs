// 真实时钟实测（非 VM）：countdown=N + 空闲 → 发起请求后：
//   t0 读状态应为 countdown 且 remaining≈N*1000ms；
//   t0+(N-0.1)s 仍未 executing；
//   t0+Ns 才 executing —— 记录实测毫秒数。
// 默认 N=5（完整 5 秒）；DSHDR_WALLCLOCK_COUNTDOWN=<秒> 可调档（快档仅用于
// 本地快速迭代，CI/门禁走默认）。需要 --experimental-vm-modules；缺 flag 时
// 给出明确指引而非晦涩的 TypeError。
import assert from 'node:assert/strict'

if (typeof vm.SourceTextModule !== 'function') {
  console.error('wallclock-countdown: 需要 --experimental-vm-modules（vm.SourceTextModule 不可用）。')
  console.error('  用法: node --experimental-vm-modules scripts/wallclock-countdown.mjs')
  process.exit(1)
}

const COUNTDOWN = (() => {
  const raw = process.env.DSHDR_WALLCLOCK_COUNTDOWN
  const n = raw === undefined ? 5 : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    console.error('wallclock-countdown: DSHDR_WALLCLOCK_COUNTDOWN 必须是 1–60 的整数秒（默认 5，门禁用默认）。')
    process.exit(1)
  }
  return n
})()

const sourcePath = new URL('../lib/index.js', import.meta.url)
const code = readFileSync(sourcePath, 'utf8')
const home = 'E:\\virtual-dsh'
const profileDir = `${home}\\profiles\\desktop`
const profileId = createHash('sha256').update(profileDir.replaceAll('\\', '/').toLowerCase()).digest('hex')
const exe = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
const stateDir = `${home}\\desktop-restart`
const profileSettingsPath = `${stateDir}\\settings-${profileId}.json`
const files = new Map([[`${stateDir}\\settings.json`, JSON.stringify({})]])
const directories = new Set([profileDir, `${profileDir}\\node_modules`, stateDir])
files.set(`${profileDir}\\package.json`, '{}')
files.set(profileSettingsPath, JSON.stringify({ countdown: COUNTDOWN }))
files.delete(`${profileDir}\\.plugin-manager\\run.json`)

// 最小 VM boot（真实 Date + 真 setTimeout），只挂 status/restart 两条路由。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import * as vm from 'node:vm'
import { createHash } from 'node:crypto'
import { processIdentityState } from '../lib/helper.cjs'

const routes = new Map()
const disposers = []
let spawned = 0
let nextFd = 1
const descriptors = new Map()
const timers = []

const context = vm.createContext({
  console, URL, Date, Number, String, Object, Array, Promise, Buffer,
  process: {
    env: { DSH_HOME: home, DSH_PROFILE_DIR: profileDir, ELECTRON_RUN_AS_NODE: '1' },
    pid: 200, ppid: 100, execPath: exe, platform: 'win32', argv: [], uptime: () => 10,
    kill(_pid, signal) { if (signal !== 0) throw new Error('real clock fixture permits only liveness queries') },
  },
  // 真实时钟：setTimeout 直接转发宿主的（unref 保留），clearTimeout 同。
  setTimeout(fn, ms) { const t = setTimeout(() => { timers.splice(timers.indexOf(handle), 1); fn() }, ms); const handle = { unref() { t.unref?.() }, cancelled: false }; handle.raw = t; timers.push(handle); return handle },
  clearTimeout(handle) { handle.cancelled = true; clearTimeout(handle.raw) },
})

const fsFake = {
  readFileSync(file) {
    const key = String(file)
    if (key.endsWith('package.json')) return '{"version":"0.4.5"}'
    if (!files.has(key)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return files.get(key)
  },
  existsSync: (f) => directories.has(String(f)) || files.has(String(f)),
  mkdirSync() {},
  readdirSync: (dir) => [...files.keys()].filter((f) => path.win32.dirname(f) === String(dir)).map((f) => path.win32.basename(f)),
  statSync(f) { if (directories.has(String(f)) || String(f) === stateDir) return { isDirectory: () => true, mtimeMs: files.size, ctimeMs: files.size, size: 0 }; if (files.has(String(f))) return { isDirectory: () => false, mtimeMs: 0, size: 0 }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
  unlinkSync(f) { files.delete(String(f)) },
  openSync(f, flag) { if (flag === 'wx' && files.has(String(f))) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e } const fd = nextFd++; descriptors.set(fd, String(f)); files.set(String(f), ''); return fd },
  closeSync() {},
  writeFileSync(f, text, options) {
    if (options?.flag === 'wx' && files.has(String(f))) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
    const file = typeof f === 'number' ? descriptors.get(f) : String(f)
    files.set(file, String(text))
  },
  renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)) },
}

const nodeModules = {
  'node:child_process': { spawn() { spawned += 1; return { pid: 901, unref() {} } } },
  'node:crypto': { createHash, randomUUID: () => 'wallclock-' + Math.random() },
  'node:fs': fsFake,
  'node:os': { homedir: () => home, tmpdir: () => `${home}\\Temp` },
  'node:path': Object.fromEntries(['basename', 'dirname', 'join'].map((n) => [n, path.win32[n]])),
  'node:url': { fileURLToPath: url.fileURLToPath },
  './sweep.js': { MIN_ORPHAN_AGE_MS: 86400000, sweepOrphanSnapshots: () => Promise.resolve({ scanned: 0, candidates: [], preview: { bytes: 0, files: 0 }, removed: [], failed: [], skipped: [], partial: false }) },
  './helper.cjs': { queryApplicationProcesses: () => [], processIdentityState, createNoticeStore: () => ({ ensure() {}, list: () => [], markRead: () => true }) },
}

const module = new vm.SourceTextModule(code, { context, identifier: sourcePath.href, initializeImportMeta(meta) { meta.url = sourcePath.href } })
await module.link(async (specifier) => {
  const stub = nodeModules[specifier]
  const mod = new vm.SyntheticModule(Object.keys(stub), function () { for (const [k, v] of Object.entries(stub)) this.setExport(k, v) }, { context })
  await mod.link(() => {}); await mod.evaluate(); return mod
})
await module.evaluate()
const ctx = {
  get(name) {
    if (name === 'agents') return { get: () => ({}), list: () => [] }
    if (name === 'jobs') return { list: () => [] }
    return undefined
  },
  effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
  inject() {},
  logger: () => ({ info() {}, warn() {}, error() {} }),
  webServer: { port: 19387, register(spec) { routes.set(spec.path, spec); return () => routes.delete(spec.path) } },
}
module.namespace.apply(ctx, { sweep: false, command: false })

const request = async (route, method, urlPath) => {
  let body
  const req = { method, url: urlPath, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }
  const res = { writeHead(status) { this.status = status }, end(v) { if (v) body = JSON.parse(v) } }
  await routes.get(route).handler(req, res)
  return { status: res.status, body }
}
const status = () => request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
const post = (q) => request('/dsh-desktop-restart/api/restart', 'POST', '/dsh-desktop-restart/api/restart' + (q ? '?' + q : ''))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 实测开始 ──
const budget = COUNTDOWN * 1000
const t0 = Date.now()
const accepted = post('')
await sleep(30)
let s = (await status()).body.restartRequest
assert.equal(s.state, 'countdown', 't0+30ms 状态应为 countdown，实际 ' + s.state)
const remainingAtStart = s.countdownRemainingMs
assert.ok(remainingAtStart > budget - 100 && remainingAtStart <= budget, `t0 剩余应≈${budget}ms，实际 ` + remainingAtStart)

await sleep(budget - 100 - 30)  // 到 t0+(N-0.1)s
s = (await status()).body.restartRequest
assert.notEqual(s.state, 'executing', `t0+${COUNTDOWN - 0.1}s 不应 executing，实际 ` + s.state)
assert.equal(spawned, 0, `t0+${COUNTDOWN - 0.1}s 不应 spawn，实际 ` + spawned)

await sleep(100)  // 到 t0+Ns
s = (await status()).body.restartRequest
assert.equal(s.state, 'executing', `t0+${COUNTDOWN}s 应 executing，实际 ` + s.state)
assert.equal(spawned, 1, `t0+${COUNTDOWN}s 应恰好 spawn 一次，实际 ` + spawned)
const executedAtMs = Date.now() - t0
await accepted
for (const dispose of disposers) dispose()

const withinBudget = executedAtMs >= budget && executedAtMs < budget + 400
if (!withinBudget) process.exitCode = 1
console.log(JSON.stringify({
  kind: 'real-clock VM; host Date + host setTimeout; fake fs/spawn/agents; no real process or network',
  countdownSeconds: COUNTDOWN,
  remainingAtStartMs: remainingAtStart,
  observedExecutingAtMs: executedAtMs,
  withinBudget,
}, null, 2))
if (!withinBudget) {
  console.error(`wallclock-countdown: 实测 ${executedAtMs}ms 超出预算 [${budget}, ${budget + 400})ms。`)
}
