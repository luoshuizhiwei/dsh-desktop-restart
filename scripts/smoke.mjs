/**
 * dsh-desktop-restart 的离线冒烟测试。
 *
 * 刻意不重启任何东西：
 * - 宿主半用桩上下文加载，只验证路由的守卫与拒绝路径；
 * - helper 只走「映像名不匹配」「拉起来又立刻退出」「端口迟迟不放」三条路径；
 *   最后那条用**测试自己拉起的替身进程**当 host、用**测试自己占住的端口**当被占端口，
 *   绝不 taskkill 一个真应用，也不弹任何窗口（测试把 alertOnFailure 关掉）；
 * - 守卫的判据（任务快照、安装记录、路径过滤、命令行解析）是纯函数，直接
 *   单测，不依赖本机当前有没有活在跑。
 *
 * 测试自己建的临时目录一律走 `scratch()` 登记、退出时统一删掉：它自己造的东西
 * 自己收走，不在系统 Temp 里留垃圾（2026-10-09 之前每跑一次就留 5 个空目录）。
 *
 * 运行：node scripts/smoke.mjs
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { MIN_ORPHAN_AGE_MS, SNAPSHOT_PREFIX, orphanSnapshots, sweepOrphanSnapshots } from '../lib/sweep.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
const helperPath = join(libDir, 'helper.cjs')

const require = createRequire(import.meta.url)
const helper = require(helperPath)

let passed = 0
let skippedWindowsOnly = 0
/** 跑一个断言块并计数。 */
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log('  ok   ' + name)
}

/**
 * 只在 Windows 上跑的用例：helper 的 tasklist / taskkill / where.exe /
 * netstat **实测**依赖 Windows 命令，别的平台上那条代码路径本来就不同
 * （CI 首跑 Linux 时它们全红，2026-10-20）。跳过要如实计数 —— 文档数量
 * 校验（文件末尾那条）靠它对账，不能悄悄少跑。
 * @param {string} name - 用例名。
 * @param {() => unknown} fn - 断言块。
 */
async function okWindows(name, fn) {
  if (process.platform !== 'win32') {
    skippedWindowsOnly += 1
    console.log('  skip ' + name + '（仅 Windows）')
    return
  }
  await ok(name, fn)
}

/**
 * 本次测试建过的临时目录。
 *
 * 以前这里每跑一次就往系统 Temp 里留 5 个空目录、从不回收：2026-10-09 的
 * C 盘体检在 Temp 里数出 167 个 `dsh-desktop-restart-*`。测试自己造的东西
 * 测试自己收走，所以统一走 {@link scratch} 建、退出时统一删。
 */
const scratchDirs = []

/**
 * 建一个本次测试专用的临时目录，并登记进收尾清理清单。
 * @param {string} label - 用途标签（进目录名，便于出事时认人）。
 * @returns {string} 目录绝对路径。
 */
function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-desktop-restart-${label}-`))
  scratchDirs.push(dir)
  return dir
}

/** 收尾：删掉本次测试建过的全部临时目录（可重复调用）。 */
function cleanScratch() {
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 删不掉也别影响退出码：这只是打扫 */
    }
  }
}

// 断言失败会直接抛出、走不到文件末尾，所以清理挂在退出钩子上而不是只写一行收尾代码。
process.on('exit', cleanScratch)

/** 一个最小可用的 node:http 响应桩。 */
function makeRes() {
  const res = { statusCode: null, headers: null, body: '' }
  res.writeHead = (code, headers) => {
    res.statusCode = code
    res.headers = headers ?? null
  }
  res.end = (chunk) => {
    res.body = chunk === undefined ? '' : String(chunk)
  }
  return res
}

/** 一个最小可用的请求桩，默认是可信的同源 loopback POST。 */
function makeReq(method, overrides = {}) {
  return {
    method,
    url: overrides.url ?? '/dsh-desktop-restart/api/restart',
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    headers: {
      origin: overrides.origin ?? 'http://127.0.0.1:19387',
      host: overrides.host ?? '127.0.0.1:19387',
      ...(overrides.headers ?? {}),
    },
  }
}

console.log('host half')

const routes = new Map()
const commands = []
/** 桩：命令服务只记录注册，绝不执行任何调度。 */
const commandsService = {
  register: (definition) => {
    commands.push(definition)
    return () => {}
  },
}
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : undefined
  },
  webServer: {
    port: 19387,
    register: (spec) => {
      routes.set(spec.path, spec)
      return () => routes.delete(spec.path)
    },
  },
  logger: () => ({ info() {}, warn() {}, error() {} }),
  inject: (deps, cb) => {
    if (deps.includes('commands')) {
      cb({
        effect: (fn) => {
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : undefined
        },
        commands: commandsService,
      })
    }
  },
}

// 宿主半在**模块加载时**读 DSH_HOME 来决定状态目录（日志、交接、设置文件）在哪，
// 所以必须在 import 之前指到本次测试的临时目录 —— 否则测试会往用户真实的
// ~/.dsh/desktop-restart 里写设置。
process.env.DSH_HOME = scratch('dsh-home')

const hostHalf = await import(new URL('../lib/index.js', import.meta.url).href)
// sweep: false —— 测试绝不碰真实的系统 Temp：这个开关开着时，宿主半会在启动后
// 异步去删「判定为孤儿」的快照目录，而测试进程并不是那个拥有会话的宿主。
hostHalf.apply(ctx, { sweep: false })

const statusRoute = routes.get('/dsh-desktop-restart/api/status')
const restartRoute = routes.get('/dsh-desktop-restart/api/restart')
const sweepRoute = routes.get('/dsh-desktop-restart/api/sweep')
const { __test } = hostHalf

await ok('注册了状态、重启与清理设置三条路由', async () => {
  assert.ok(statusRoute, '缺少状态路由')
  assert.ok(restartRoute, '缺少重启路由')
  assert.ok(routes.get('/dsh-desktop-restart/api/sweep'), '缺少清理设置路由')
  assert.equal(routes.size, 3)
})

await ok('host 半声明 webServer 依赖', async () => {
  assert.deepEqual(hostHalf.inject, ['webServer'])
})

await ok('斜杠命令：注册了 /restart-desktop', async () => {
  assert.equal(commands.length, 1, '应当恰好注册一个命令')
  assert.equal(commands[0].name, 'restart-desktop')
  assert.ok(commands[0].description.length > 0, '描述不能为空')
  assert.equal(typeof commands[0].handler, 'function')
})

await ok('斜杠命令：非桌面宿主下返回 error 结果', async () => {
  const result = await commands[0].handler({})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /桌面版/u)
})

await ok('斜杠命令：--force 不会绕过「不是桌面版」这类硬拒绝', async () => {
  const result = await commands[0].handler({ rawInput: '--force' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /桌面版/u)
})

await ok('斜杠命令：invocation 形状意外时不抛异常', async () => {
  for (const input of [undefined, null, 'plain string', { rawInput: 42 }, { rawInput: '' }]) {
    const result = await commands[0].handler(input)
    assert.equal(result.kind, 'error')
  }
})

await ok('斜杠命令：命令名符合 DSH 的命名规则', async () => {
  assert.match(commands[0].name, /^[a-z][a-z0-9_-]*$/u)
})

await ok('状态路由：GET 返回 desktop=false（当前不是桌面宿主）', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.desktop, false)
  assert.equal(body.enabled, true)
})

await ok('状态路由：带上一份守卫摘要（只给计数与人话，不含路径）', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('GET'), res)
  const body = JSON.parse(res.body)
  assert.ok(body.guard, '状态里应当有 guard')
  assert.equal(typeof body.guard.active, 'boolean')
  assert.ok(Array.isArray(body.guard.reasons))
  assert.doesNotMatch(res.body, /[A-Za-z]:\\/u, 'guard 里不应出现本机路径')
})

await ok('状态路由：不再泄露 pid 与可执行文件路径', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('GET'), res)
  const body = JSON.parse(res.body)
  assert.equal('hostPid' in body, false)
  assert.equal('mainPid' in body, false)
  assert.equal('exe' in body, false)
})

await ok('状态路由：非 loopback 来源返回 403', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('GET', { remoteAddress: '10.1.2.3' }), res)
  assert.equal(res.statusCode, 403)
})

await ok('状态路由：Origin 与 Host 不一致返回 403', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('GET', { origin: 'http://evil.example' }), res)
  assert.equal(res.statusCode, 403)
})

await ok('状态路由：非 GET 返回 405', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 405)
})

await ok('重启路由：非 POST 返回 405', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

await ok('重启路由：非 loopback 来源返回 403', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('POST', { remoteAddress: '10.1.2.3' }), res)
  assert.equal(res.statusCode, 403)
})

await ok('重启路由：带 Origin 时以 Origin 为准（回环对端仍是硬前提）', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('POST', { headers: { 'x-forwarded-for': '203.0.113.9' } }), res)
  assert.equal(res.statusCode, 409)
})

await ok('重启路由：Origin 与 Host 不一致返回 403', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('POST', { origin: 'http://evil.example' }), res)
  assert.equal(res.statusCode, 403)
})

await ok('重启路由：桌面壳转发的无 Origin 请求被放行（走到非桌面判定）', async () => {
  const res = makeRes()
  const req = makeReq('POST')
  delete req.headers.origin
  await restartRoute.handler(req, res)
  assert.equal(res.statusCode, 409)
})

await ok('重启路由：无 Origin 且带转发头返回 403', async () => {
  const res = makeRes()
  const req = makeReq('POST', { headers: { 'x-forwarded-for': '203.0.113.9' } })
  delete req.headers.origin
  await restartRoute.handler(req, res)
  assert.equal(res.statusCode, 403)
})

await ok('重启路由：无 Origin 且 Sec-Fetch-Site 为 cross-site 返回 403', async () => {
  const res = makeRes()
  const req = makeReq('POST', { headers: { 'sec-fetch-site': 'cross-site' } })
  delete req.headers.origin
  await restartRoute.handler(req, res)
  assert.equal(res.statusCode, 403)
})

await ok('重启路由：无 Origin 且 Host 非回环返回 403', async () => {
  const res = makeRes()
  const req = makeReq('POST', { host: 'example.com' })
  delete req.headers.origin
  await restartRoute.handler(req, res)
  assert.equal(res.statusCode, 403)
})

await ok('重启路由：Origin 的 host 与 Host 一致时被放行', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('POST', { origin: 'http://localhost:19387', host: 'localhost:19387' }), res)
  assert.equal(res.statusCode, 409)
})

await ok('重启路由：可信但非桌面宿主返回 409 并说明原因', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.body).error, /桌面版/u)
})

await ok('重启路由：?force=1 也不绕过「不是桌面版」这类硬拒绝', async () => {
  const res = makeRes()
  await restartRoute.handler(makeReq('POST', { url: '/dsh-desktop-restart/api/restart?force=1' }), res)
  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.body).error, /桌面版/u)
})

await ok('重启路由：config.enabled=false 时返回 403', async () => {
  const disabled = new Map()
  const disabledCtx = {
    ...ctx,
    webServer: {
      port: 19387,
      register: (spec) => {
        disabled.set(spec.path, spec)
        return () => disabled.delete(spec.path)
      },
    },
  }
  hostHalf.apply(disabledCtx, { enabled: false })
  const res = makeRes()
  await disabled.get('/dsh-desktop-restart/api/restart').handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 403)
  assert.match(JSON.parse(res.body).error, /enabled/u)
})

console.log('guard')

/** 造一个只实现 agents / jobs 两个服务的桩上下文。 */
function guardCtx({ agents = [], jobs = {}, absent = false } = {}) {
  const services = {
    agents: { list: () => agents },
    jobs: { list: (id) => jobs[id ?? 'global'] ?? [] },
  }
  return {
    get: (name) => (absent ? undefined : services[name]),
  }
}

await ok('守卫：没有 agents/jobs 服务时如实回 known=false（不拦人）', async () => {
  const snapshot = __test.taskSnapshot(guardCtx({ absent: true }))
  assert.equal(snapshot.known, false)
  assert.equal(snapshot.active, false)
})

await ok('守卫：服务形状意外时也不抛异常', async () => {
  for (const weird of [{ get: () => ({}) }, { get: () => ({ list: 'nope' }) }, { get: () => ({ list: () => 'nope' }) }, {}]) {
    const snapshot = __test.taskSnapshot(weird)
    assert.equal(snapshot.known, false)
  }
})

await ok('守卫：正在生成的智能体算「有任务在跑」', async () => {
  const snapshot = __test.taskSnapshot(guardCtx({
    agents: [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }],
  }))
  assert.equal(snapshot.known, true)
  assert.equal(snapshot.active, true)
  assert.equal(snapshot.turns, 1)
})

await ok('守卫：排队消息与后台任务同样算（复刻 hasDesktopActiveTasks）', async () => {
  const queued = __test.taskSnapshot(guardCtx({
    agents: [{ id: 'a1', status: 'idle', inbox: { nextTurn: ['x'], nextStep: [] } }],
  }))
  assert.equal(queued.active, true)
  assert.equal(queued.queued, 1)

  const busy = __test.taskSnapshot(guardCtx({
    agents: [{ id: 'a1', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }],
    jobs: { a1: [{ id: 'j1', status: 'running' }], global: [{ id: 'j2', status: 'stopping' }] },
  }))
  assert.equal(busy.active, true)
  assert.equal(busy.jobs, 2)
})

await ok('守卫：闲置的智能体与已结束的任务不算', async () => {
  const snapshot = __test.taskSnapshot(guardCtx({
    agents: [{ id: 'a1', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }],
    jobs: { a1: [{ id: 'j1', status: 'completed' }], global: [] },
  }))
  assert.equal(snapshot.known, true)
  assert.equal(snapshot.active, false)
})

await ok('守卫：没有安装记录时不拦', async () => {
  const dir = scratch('install')
  const state = __test.installInProgress(dir)
  assert.equal(state.known, true)
  assert.equal(state.active, false)
  assert.equal(state.blocked, false)
})

await ok('守卫：记录里的进程还活着 = 正在安装（硬拦）', async () => {
  const dir = scratch('install-live')
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(
    join(dir, '.plugin-manager', 'run.json'),
    JSON.stringify({ pid: process.pid, grouped: false }),
    'utf8',
  )
  const busy = __test.installInProgress(dir)
  assert.equal(busy.active, true)
  assert.equal(busy.running, true)
  assert.equal(busy.blocked, true, '进程还活着时必须硬拦：腰斩 pnpm 会把依赖树弄成半新半旧')
  assert.equal(busy.pid, process.pid)
})

await ok('守卫：记录里的进程已经退出 = 崩溃残留（不拦，避免 2026-10-06 那类死锁）', async () => {
  const dir = scratch('install-stale')
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  // 真起一个进程再让它退出：拿到的 pid 一定「曾经存在、现在不存在」，
  // 比猜一个大概率空闲的 pid 稳。
  const gone = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.ok(Number.isInteger(gone.pid), '取不到临时进程的 pid，这条用例无效')
  writeFileSync(
    join(dir, '.plugin-manager', 'run.json'),
    JSON.stringify({ pid: gone.pid, grouped: false }),
    'utf8',
  )
  const state = __test.installInProgress(dir)
  assert.equal(state.active, false, '残留记录不该把重启按钮锁住')
  assert.equal(state.blocked, false)
  assert.equal(state.pid, gone.pid, '残留也要如实报出记录里的 pid，便于诊断')
})

await ok('守卫：存活判据照抄上游（process.kill(pid, 0) 不抛就算活着）', async () => {
  assert.equal(__test.runAlive({ pid: process.pid }), true)
  // grouped：Windows 忽略进程组（探测目标就是 pid 本身）；POSIX 上探测 -pid
  // （整个进程组）。CI 三档矩阵里 Linux 与 Windows 都会跑到这条 ——
  // 断言必须跟着平台走，不能再把「Windows 的行为」写死成全平台的事实
  // （2026-10-20 CI 首跑 Linux 三连红就是这么来的）。
  if (process.platform === 'win32') {
    assert.equal(__test.runAlive({ pid: process.pid, grouped: true }), true, 'Windows 上 grouped 不改探测目标')
  } else {
    // 自己不在前台进程组的组长位上：grouped 探测（-pid）按「已经没了」处理，
    // 不抛异常即可 —— 这里验证的是「走的是另一条探测路径」，不假设结果。
    assert.equal(typeof __test.runAlive({ pid: process.pid, grouped: true }), 'boolean')
  }
  assert.equal(__test.runAlive({ pid: null }), false)
  assert.equal(__test.runAlive({ pid: 0 }), false)
  assert.equal(__test.runAlive({ pid: -5 }), false)
  assert.equal(__test.runAlive({ pid: 1073741824 }), false, '不存在的 pid 必须判成「已经没了」')
  assert.equal(__test.runAlive(undefined), false, '记录形状意外时不能抛')
})

await ok('守卫：安装记录损坏时只警告、不硬拦（判不了就多问一次）', async () => {
  const dir = scratch('broken')
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(join(dir, '.plugin-manager', 'run.json'), '{not json', 'utf8')
  const state = __test.installInProgress(dir)
  assert.equal(state.active, true)
  assert.equal(state.blocked, false, '读不出进程号时不能硬拦')
  assert.equal(state.running, false)
  assert.equal(state.pid, null)
})

await ok('守卫：目录定位不到时静默跳过（known=false）', async () => {
  const state = __test.installInProgress(null)
  assert.equal(state.known, false)
  assert.equal(state.active, false)
  assert.equal(state.blocked, false)
})

await ok('守卫：安装中的硬拦排在 force 之前（force=1 也绕不过去）', async () => {
  const source = readFileSync(join(libDir, 'index.js'), 'utf8')
  const blockedAt = source.indexOf('if (installing.blocked)')
  const forceAt = source.indexOf('if (options.force !== true)')
  assert.ok(blockedAt > 0, '必须有「插件正在安装/更新」的硬拦分支')
  assert.ok(forceAt > 0, '应当保留 force 守卫')
  assert.ok(blockedAt < forceAt, '硬拦必须排在 force 守卫之前，否则 ?force=1 会绕过它')
})

await ok('守卫：profile 目录必须同时有 package.json 与 node_modules', async () => {
  const dir = scratch('profile')
  assert.equal(__test.validProfileDir(dir), null, '空目录不算 profile')
  writeFileSync(join(dir, 'package.json'), '{}', 'utf8')
  assert.equal(__test.validProfileDir(dir), null, '只有 package.json 也不算')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  assert.equal(__test.validProfileDir(dir), dir)
  assert.equal(__test.validProfileDir(join(dir, 'nope')), null)
  assert.equal(__test.validProfileDir(undefined), null)
})

await ok('守卫：把会打断什么写成一句人话', async () => {
  const reasons = __test.guardReasons(
    { known: true, active: true, turns: 2, queued: 1, jobs: 3, sessions: 2 },
    { known: true, active: true, blocked: true, running: true, pid: 99, record: 'x' },
  )
  assert.equal(reasons.length, 2)
  assert.match(reasons[0], /有任务在跑/u)
  assert.match(reasons[0], /2 项正在生成或运行工具/u)
  assert.match(reasons[0], /3 个后台任务/u)
  assert.match(reasons[1], /正在安装或更新/u)

  const clean = __test.guardReasons(
    { known: true, active: false, turns: 0, queued: 0, jobs: 0, sessions: 1 },
    { known: true, active: false, blocked: false, running: false, pid: null, record: null },
  )
  assert.deepEqual(clean, [])
})

await ok('守卫：判不了是否在装时只说「读不出进程」，不宣称正在安装', async () => {
  const reasons = __test.guardReasons(
    { known: true, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 },
    { known: true, active: true, blocked: false, running: false, pid: null, record: 'x' },
  )
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /读不出是哪个进程/u)
  assert.doesNotMatch(reasons[0], /正在安装或更新/u, '判不了就不能说成「正在装」')
})

await ok('守卫：只有 force=1 才算「已确认」', async () => {
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart?force=1'), true)
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart?x=1&force=1'), true)
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart?force=0'), false)
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart'), false)
  assert.equal(__test.forceRequested(undefined), false)
})

await ok('等待：wait=1 / cancelWait=1 参数解析（B 项）', async () => {
  assert.equal(__test.waitRequested('/dsh-desktop-restart/api/restart?wait=1'), true)
  assert.equal(__test.waitRequested('/dsh-desktop-restart/api/restart?force=1&wait=1'), true)
  assert.equal(__test.waitRequested('/dsh-desktop-restart/api/restart?wait=0'), false)
  assert.equal(__test.waitRequested('/dsh-desktop-restart/api/restart'), false)
  assert.equal(__test.waitRequested(undefined), false)
  assert.equal(__test.cancelWaitRequested('/dsh-desktop-restart/api/restart?cancelWait=1'), true)
  assert.equal(__test.cancelWaitRequested('/dsh-desktop-restart/api/restart'), false)
  assert.equal(__test.cancelWaitRequested(undefined), false)
})

await ok('等待：安静即重启、到顶即放弃、其余继续等（纯函数）', async () => {
  const since = 1_000_000
  assert.equal(__test.waitingDecision({ active: false }, since, since + 5_000), 'restart', '守卫安静了就该重启')
  assert.equal(__test.waitingDecision({ active: true }, since, since + 5_000), 'keep', '还响着就继续等')
  const max = 60_000
  assert.equal(__test.waitingDecision({ active: true }, since, since + 59_999, max), 'keep', '差一毫秒也继续等')
  assert.equal(__test.waitingDecision({ active: true }, since, since + 60_000, max), 'timeout', '到顶必须放弃，不能无限挂起')
  assert.equal(__test.waitingDecision(null, since, since), 'restart', '形状意外按安静处理')
  assert.equal(__test.waitingDecision({ active: true }, Number.NaN, since), 'keep', '时间读不出来就继续等')
})

await ok('平台：非 Windows 在入口说明白，而不是走到一半晦涩失败（C 项）', async () => {
  assert.equal(__test.platformUnsupported('win32'), null, 'Windows 是支持的平台')
  for (const platform of ['linux', 'darwin', 'aix']) {
    const message = __test.platformUnsupported(platform)
    assert.match(String(message), new RegExp(platform, 'u'), `说明里要带上平台名（${platform}）`)
    assert.match(String(message), /tasklist/u, '要说清缺的是什么')
  }
  assert.equal(__test.platformUnsupported('win32'), null)
})

await ok('守卫：交接目录只保留最近 20 组（handoff + log 一起清）', async () => {
  const dir = scratch('prune')
  for (let index = 0; index < 25; index += 1) {
    const stamp = `2026-10-${String(index + 1).padStart(2, '0')}T00-00-00`
    writeFileSync(join(dir, `handoff-${stamp}.json`), '{}', 'utf8')
    writeFileSync(join(dir, `restart-${stamp}.log`), '', 'utf8')
  }
  writeFileSync(join(dir, 'unrelated.txt'), '', 'utf8')
  __test.pruneState(dir)
  const names = readdirSync(dir)
  assert.equal(names.filter((name) => name.startsWith('handoff-')).length, 20)
  assert.equal(names.filter((name) => name.startsWith('restart-')).length, 20)
  assert.ok(names.includes('handoff-2026-10-25T00-00-00.json'), '最新的必须留着')
  assert.ok(!names.includes('handoff-2026-10-01T00-00-00.json'), '最旧的必须清掉')
  assert.ok(names.includes('unrelated.txt'), '不认识的文件不动')
})

await ok('守卫：先写后裁 —— 连写 25 组仍稳定在 20 组（0.3.4 修的那一位差）', async () => {
  // 复刻真实顺序：先写这一轮的 handoff + log，然后才裁剪。原先在写之前裁，
  // 于是刚写下的那一组没被计入名额，实测 handoff 21 / log 21 而不是 20。
  const dir = scratch('prune-seq')
  for (let index = 0; index < 25; index += 1) {
    const stamp = `2026-10-${String(index + 1).padStart(2, '0')}T00-00-00`
    writeFileSync(join(dir, `handoff-${stamp}.json`), '{}', 'utf8')
    writeFileSync(join(dir, `restart-${stamp}.log`), '', 'utf8')
    __test.pruneState(dir)
  }
  const names = readdirSync(dir)
  assert.equal(names.filter((name) => name.startsWith('handoff-')).length, 20, '连写 25 组后应当正好 20 组')
  assert.equal(names.filter((name) => name.startsWith('restart-')).length, 20)
  assert.ok(names.includes('handoff-2026-10-25T00-00-00.json'), '刚写下的那一组必须留下')
  assert.ok(!names.includes('handoff-2026-10-01T00-00-00.json'), '最旧的必须被挤掉')
})

console.log('platform auth')

/**
 * 造一个带 connection 服务的宿主上下文，把这次 apply 注册的路由收进自己的 Map。
 *
 * 不污染顶层那个 `routes`：顶层上下文里没有 connection 服务，走的正是
 * 「退回自检」那条分支，其余用例依赖它保持这个形状。
 * @param {unknown} connection - 假的 connection 服务。
 * @param {object} [config] - 传给 apply 的 config。
 * @returns {Map<string, object>} 路径 → 路由。
 */
function ctxWithConnection(connection, config) {
  const own = new Map()
  hostHalf.apply({
    ...ctx,
    get: (name) => (name === 'connection' ? connection : undefined),
    webServer: {
      port: 19387,
      register: (spec) => {
        own.set(spec.path, spec)
        return () => own.delete(spec.path)
      },
    },
  }, { sweep: false, ...config })
  return own
}

await ok('平台门：没有 connection 服务时退回自检（不拦、不报错）', async () => {
  const fence = __test.platformFence(ctx, makeReq('POST'))
  assert.equal(fence.available, false)
  assert.equal(fence.verdict, null)
  assert.equal(fence.error, null)

  const bare = __test.platformFence(undefined, makeReq('POST'))
  assert.equal(bare.available, false, '取不到 ctx 也不能抛')
  assert.equal(bare.verdict, null)
})

await ok('平台门：ctx.get 抛异常时不硬拦（一次故障不能把重启按钮锁死）', async () => {
  const fence = __test.platformFence({ get: () => { throw new Error('boom') } }, makeReq('POST'))
  assert.equal(fence.available, false)
  assert.equal(fence.verdict, null)
  assert.match(String(fence.error), /boom/u, '要把原因记下来，便于诊断')
})

await ok('平台门：connection 没有 requestRejection 时按「不可用」处理', async () => {
  const fence = __test.platformFence({
    get: (name) => (name === 'connection' ? {} : undefined),
  }, makeReq('POST'))
  assert.equal(fence.available, false)
  assert.equal(fence.verdict, null)
})

await ok('平台门：401 / 403 原样透传，undefined 表示放行', async () => {
  const build = (verdict) => ({
    get: (name) => (name === 'connection' ? { requestRejection: () => verdict } : undefined),
  })
  assert.deepEqual(__test.platformFence(build(401), makeReq('POST')), { available: true, verdict: 401, error: null })
  assert.deepEqual(__test.platformFence(build(403), makeReq('POST')), { available: true, verdict: 403, error: null })
  assert.deepEqual(__test.platformFence(build(undefined), makeReq('POST')), { available: true, verdict: null, error: null })
})

await ok('平台门：requestRejection 自己抛异常时按「不拦」处理并记下原因', async () => {
  const ctxThrows = {
    get: (name) => (name === 'connection' ? { requestRejection: () => { throw new Error('nope') } } : undefined),
  }
  const fence = __test.platformFence(ctxThrows, makeReq('POST'))
  assert.equal(fence.available, true)
  assert.equal(fence.verdict, null, '一次偶发故障不能放大成「应用重启不了」')
  assert.match(String(fence.error), /nope/u)
})

await ok('平台门：401 与 403 给出不同的修法说明', async () => {
  const unauthorized = __test.describeFenceRefusal({ verdict: 401 }, '重启')
  const forbidden = __test.describeFenceRefusal({ verdict: 403 }, '重启')
  assert.match(unauthorized, /会话凭据/u)
  assert.match(unauthorized, /页面/u)
  assert.match(forbidden, /信任栅栏/u)
  assert.notEqual(unauthorized, forbidden, '两种拒绝混成一句会让人对着 403 瞎猜')
  assert.match(__test.describeFenceRefusal({ verdict: 401 }, '清理设置'), /^清理设置/u, '要把操作名带上')
})

await ok('写路由：平台回 401 时重启被挡下，并说明缺会话凭据', async () => {
  const routes401 = ctxWithConnection({ requestRejection: () => 401 })
  const res = makeRes()
  await routes401.get('/dsh-desktop-restart/api/restart').handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 401)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.match(body.error, /会话凭据/u)
})

await ok('写路由：平台回 403 时清理请求被挡下，提示信任栅栏', async () => {
  const routes403 = ctxWithConnection({ requestRejection: () => 403 })
  const res = makeRes()
  await routes403.get('/dsh-desktop-restart/api/sweep').handler(
    makeReq('POST', { url: '/dsh-desktop-restart/api/sweep' }),
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.match(JSON.parse(res.body).error, /信任栅栏/u)
})

await ok('写路由：平台放行时照常往下走（这里走到「不是桌面版」）', async () => {
  const routesOpen = ctxWithConnection({ requestRejection: () => undefined })
  const res = makeRes()
  await routesOpen.get('/dsh-desktop-restart/api/restart').handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 409, '放行之后仍要过原有的各项拒绝路径')
  assert.match(JSON.parse(res.body).error, /桌面版/u)
})

await ok('写路由：requestRejection 抛异常时不拦，仍走到后续判定', async () => {
  const routesThrow = ctxWithConnection({ requestRejection: () => { throw new Error('nope') } })
  const res = makeRes()
  await routesThrow.get('/dsh-desktop-restart/api/restart').handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.body).error, /桌面版/u)
})

await ok('状态路由：只诊断不拦 —— 鉴权失败也回 200 并把判定说出来', async () => {
  const routes = ctxWithConnection({ requestRejection: () => 401 })
  const res = makeRes()
  await routes.get('/dsh-desktop-restart/api/status').handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 200, '状态路由必须能在鉴权失败时解释原因，而不是回 401')
  const body = JSON.parse(res.body)
  assert.equal(body.platformAuth.enforced, true)
  assert.equal(body.platformAuth.available, true)
  assert.equal(body.platformAuth.verdict, 401)
  assert.equal(body.platformAuth.error, null)
})

await ok('platformAuth=false 可退回旧行为（给桌面壳不带 cookie 的部署留后路）', async () => {
  const routes = ctxWithConnection({ requestRejection: () => 401 }, { platformAuth: false })
  const restart = makeRes()
  await routes.get('/dsh-desktop-restart/api/restart').handler(makeReq('POST'), restart)
  assert.equal(restart.statusCode, 409, '关掉平台门后应当回到「不是桌面版」，而不是 401')
  const status = makeRes()
  await routes.get('/dsh-desktop-restart/api/status').handler(makeReq('GET'), status)
  assert.equal(JSON.parse(status.body).platformAuth.enforced, false)
})

console.log('sweep')

await ok('清理：只挑「启动前就存在、启动后没被写过、且躺够最小年龄」的快照目录', async () => {
  const started = 1_000_000_000
  const day = 24 * 60 * 60 * 1000
  const now = started + 1000
  /** 造一个目录项。 */
  const entry = (name, createdAtMs, modifiedAtMs, isDir = true) => ({
    name, createdAtMs, modifiedAtMs, isDirectory: () => isDir,
  })
  const picked = orphanSnapshots([
    entry(`${SNAPSHOT_PREFIX}orphan`, started - 3 * day, started - 3 * day),
    entry(`${SNAPSHOT_PREFIX}young`, started - 1000, started - 1000),
    entry(`${SNAPSHOT_PREFIX}live`, started + 500, started + 500),
    entry(`${SNAPSHOT_PREFIX}writing`, started - 3 * day, started + 500),
    entry('not-a-snapshot', started - 3 * day, started - 3 * day),
    entry(`${SNAPSHOT_PREFIX}afile`, started - 3 * day, started - 3 * day, false),
    entry(`${SNAPSHOT_PREFIX}nan`, Number.NaN, started - 3 * day),
  ], started, { now, minAgeMs: day })
  assert.deepEqual(picked, [`${SNAPSHOT_PREFIX}orphan`])
})

await ok('清理：最小年龄默认是 24 小时', async () => {
  assert.equal(MIN_ORPHAN_AGE_MS, 24 * 60 * 60 * 1000)
})

await ok('清理：真删目录，前缀不对的、不是目录的都不动', async () => {
  const root = scratch('sweep')
  const doomed = join(root, `${SNAPSHOT_PREFIX}doomed`)
  const unrelated = join(root, 'unrelated')
  const asFile = join(root, `${SNAPSHOT_PREFIX}afile`)
  for (const dir of [doomed, unrelated]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'payload.bin'), Buffer.alloc(2048))
  }
  writeFileSync(asFile, 'x')
  // 把「启动时刻」放到未来、最小年龄放开：两条守卫本身在上面单独验，
  // 这里要验的是「真的会去删、而且只删该删的」。
  //
  // 时间戳由测试自己固定注入（2026-10-20 的两轮 CI 教训）：Linux 上
  // stat().birthtime 常不可用（回退的 ctime 语义也不同），拿真实文件系统
  // 的时间戳喂判定，等于把「该不该删」挂在平台差异上 —— Windows 全绿、
  // Linux 随缘。判定逻辑交给上面的纯函数用例；这里用「把 mtime/创建时间
  // 拨到很久以前」保证目录必然被判为孤儿，然后专心验证「删得掉、删得对」。
  const LONG_AGO = 1_000_000_000_000
  const OLD = Date.now() - LONG_AGO
  const logLines = []
  const result = await sweepOrphanSnapshots({
    tempRoot: root,
    startedAtMs: Date.now() + 60_000,
    minAgeMs: 0,
    log: (line) => logLines.push(line),
    // 注入时间戳来源：测试专用钩子，生产路径不传它。字段名与 node:fs 的
    // stat() 保持一致（birthtimeMs / ctimeMs / mtimeMs）。
    statOf: (target) => {
      const info = statSync(target)
      const isSnapshot = target.includes(SNAPSHOT_PREFIX)
      // 快照目录一律「很久以前建的、很久没写过」→ 必然命中孤儿；
      // 无关目录与文件同样给旧值，靠前缀/类型把它们挡在门外。
      const old = isSnapshot ? OLD : info.birthtimeMs
      return {
        isDirectory: () => info.isDirectory(),
        birthtimeMs: old,
        ctimeMs: old,
        mtimeMs: isSnapshot ? OLD : info.mtimeMs,
      }
    },
  })
  const scene = () => JSON.stringify({ scanned: result.scanned, removed: result.removed, failed: result.failed, logLines })
  assert.deepEqual(result.removed, [`${SNAPSHOT_PREFIX}doomed`], `删除结果不符：${scene()}`)
  assert.equal(result.failed.length, 0, `有目录删失败：${scene()}`)
  assert.equal(result.bytes, 2048, `字节数不符：${scene()}`)
  assert.equal(result.files, 1, `文件数不符：${scene()}`)
  assert.equal(existsSync(doomed), false, '该删的必须删掉')
  assert.equal(existsSync(unrelated), true, '不是快照前缀的目录一个都不该碰')
  assert.equal(existsSync(asFile), true, '同前缀的文件不动')
})

await ok('清理：本次启动之后才建的目录一个都不碰', async () => {
  const root = scratch('sweep-live')
  const fresh = join(root, `${SNAPSHOT_PREFIX}fresh`)
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(fresh, 'payload.bin'), Buffer.alloc(512))
  const result = await sweepOrphanSnapshots({
    tempRoot: root,
    // 启动时刻在过去 → 刚建的目录「晚于启动」，必须被排除。
    startedAtMs: Date.now() - 60_000,
    minAgeMs: 0,
    log: () => {},
  })
  assert.deepEqual(result.removed, [], '活动会话的目录绝不能被删')
  assert.equal(existsSync(fresh), true)
})

await ok('清理：临时目录不存在时静默返回空结果', async () => {
  const result = await sweepOrphanSnapshots({
    tempRoot: join(tmpdir(), 'dsh-desktop-restart-does-not-exist-xyz'),
    startedAtMs: Date.now(),
    log: () => {},
  })
  assert.deepEqual(result.removed, [])
  assert.equal(result.scanned, 0)
})

await ok('插件设置：写进去读得回来，坏文件退回默认', async () => {
  const dir = scratch('settings')
  const file = join(dir, 'settings.json')
  assert.deepEqual(__test.readSettings(file), {}, '文件不存在时回空对象')
  assert.deepEqual(__test.writeSettings({ sweep: false }, file), { sweep: false })
  assert.deepEqual(__test.readSettings(file), { sweep: false })
  assert.deepEqual(__test.writeSettings({ other: 1 }, file), { sweep: false, other: 1 }, '合并写，不丢别的字段')
  writeFileSync(file, '{ 这不是 JSON')
  assert.deepEqual(__test.readSettings(file), {}, '内容坏了回空对象')
})

await ok('清理：设置文件里没有这一项时，默认值来自 config', async () => {
  // 先把设置文件清掉，模拟「用户没改过」。
  rmSync(join(String(process.env.DSH_HOME), 'desktop-restart', 'settings.json'), { force: true })
  const probeRoutes = new Map()
  hostHalf.apply({
    effect: (fn) => { fn() },
    webServer: { port: 19387, register: (spec) => { probeRoutes.set(spec.path, spec); return () => {} } },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    inject: () => {},
  }, { sweep: false, command: false })
  const res = makeRes()
  probeRoutes.get('/dsh-desktop-restart/api/status').handler(makeReq('GET'), res)
  assert.equal(JSON.parse(res.body).sweep.enabled, false, 'config.sweep=false 且用户没改过 → 关闭')
})

await ok('清理设置路由：非 POST 返回 405', async () => {
  const res = makeRes()
  await sweepRoute.handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})
await ok('清理设置路由：非 loopback 来源返回 403', async () => {
  const res = makeRes()
  await sweepRoute.handler(makeReq('POST', { remoteAddress: '10.0.0.5' }), res)
  assert.equal(res.statusCode, 403)
})

await ok('清理设置路由：run / enabled 都走通，且只动传进来的 Temp', async () => {
  // 把 TMP/TEMP 指向本次测试的目录：宿主半跑清理时读的是 tmpdir()，
  // 否则这条用例会去扫真实的系统 Temp。
  const fakeTemp = scratch('sweeptemp')
  const fresh = join(fakeTemp, `${SNAPSHOT_PREFIX}fresh`)
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(fresh, 'x.bin'), Buffer.alloc(1024))
  const savedTmp = process.env.TMP
  const savedTemp = process.env.TEMP
  process.env.TMP = fakeTemp
  process.env.TEMP = fakeTemp
  try {
    const run = makeRes()
    await sweepRoute.handler(makeReq('POST', { url: '/dsh-desktop-restart/api/sweep?run=1' }), run)
    const afterRun = JSON.parse(run.body)
    assert.equal(afterRun.ok, true)
    assert.equal(afterRun.last.removed, 0, '刚建的目录不该被删')
    assert.equal(existsSync(fresh), true)

    const off = makeRes()
    await sweepRoute.handler(makeReq('POST', { url: '/dsh-desktop-restart/api/sweep?enabled=0' }), off)
    assert.equal(JSON.parse(off.body).enabled, false)
    assert.equal(__test.readSettings().sweep, false, '开关要写进插件的设置文件')

    const on = makeRes()
    await sweepRoute.handler(makeReq('POST', { url: '/dsh-desktop-restart/api/sweep?enabled=1' }), on)
    const afterOn = JSON.parse(on.body)
    assert.equal(afterOn.enabled, true)
    assert.equal(__test.readSettings().sweep, true)
    assert.equal(existsSync(fresh), true, '打开开关顺手清一次，也不该碰新目录')
  } finally {
    if (savedTmp === undefined) delete process.env.TMP
    else process.env.TMP = savedTmp
    if (savedTemp === undefined) delete process.env.TEMP
    else process.env.TEMP = savedTemp
  }
})

await ok('状态路由：带上清理开关与上次结果', async () => {
  __test.writeSettings({ sweep: true })
  const res = makeRes()
  statusRoute.handler(makeReq('GET'), res)
  const body = JSON.parse(res.body)
  assert.equal(typeof body.sweep, 'object')
  assert.equal(body.sweep.enabled, true, '设置文件里开着就是开着')
  assert.equal(body.sweep.minAgeHours, 24, '界面要能说出「躺够 24 小时」这个数')
  __test.writeSettings({ sweep: false })
  const off = makeRes()
  statusRoute.handler(makeReq('GET'), off)
  assert.equal(JSON.parse(off.body).sweep.enabled, false, '设置文件里关着就是关着')
})

console.log('client half')

/** 载入 client bundle 顶层，取回它注册的 factory 与插件导出。 */
function loadClientBundle(options = {}) {
  const loads = []
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 只执行 bundle 顶层。它唯一的副作用就是注册 factory —— factory 本体不会运行，
  // 因此这里既不需要真的 react，也不会碰到任何真实环境。
  const windowObject = { __ModuleLoader__: { load: (spec) => loads.push(spec) } }
  // 需要测「本机保存的开关」时，把假的 localStorage 塞进这个 vm 的 window。
  if (options.storage !== undefined) windowObject.localStorage = options.storage
  runInNewContext(source, { window: windowObject })
  assert.equal(loads.length, 1, 'client.js 应当恰好注册一个 factory')
  assert.equal(typeof loads[0].factory, 'function', 'factory 必须是一个函数')
  const react = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  return { load: loads[0], plugin: loads[0].factory((name) => (name === 'react' ? react : undefined)) }
}

await ok('client bundle：factory id 必须等于 package.json 的包名', async () => {
  const { load } = loadClientBundle()
  assert.equal(
    load.id,
    packageJson.name,
    'client-modules 用解析出的包名作为浏览器模块身份：id 与包名不一致时，启动图里那一行永远不会激活，'
      + '重试会二次执行 bundle，并以 duplicate factory registration 让整个 web boot 失败'
      + '（2026-10-06 改 scoped 包名时正是这样崩的）',
  )
})

await ok('client bundle：确认态与警告态是两条不同的路（force 只在警告态发出）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /\?force=1/u, '强制重启必须带 ?force=1')
  assert.match(source, /WARN_ARM_MS/u, '警告态必须有防连点冷却')
  assert.match(source, /result\.guard === true/u, '必须识别宿主半的守卫响应')
})

await ok('client bundle：等空闲再重启 —— wait/cancelWait 走通、按钮只在守卫响着时出现（B 项）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /wait=1/u, '等待请求必须带 wait=1')
  assert.match(source, /cancelWait=1/u, '取消请求必须带 cancelWait=1')
  assert.match(source, /function WaitButton/u, '必须有等待按钮组件')
  // 按钮出现条件：守卫响着（guardHint 非空）或已挂起等待；非桌面版不出现。
  const start = source.indexOf('function WaitButton')
  const fn = source.slice(start, source.indexOf('\n\t\t\t}', start) + 4)
  assert.ok(fn.length > 200, `WaitButton 函数体要完整截取到（现在 ${String(fn.length)} 字符）`)
  assert.match(fn, /guardHint === ""/u, '要判断守卫是否响着')
  assert.match(fn, /desktop === false.*?return null/us, '非桌面版不显示')
  // 等待与取消都换状态行而不进 done（等待不是「已排程重启」）。
  assert.match(source, /result\.waiting === true/u, '客户端要识别宿主的等待挂起响应')
  assert.match(source, /waitForIdle/u, 'useRestart 必须暴露 waitForIdle')
  assert.match(source, /cancelWait/u, 'useRestart 必须暴露 cancelWait')
})

await ok('client bundle：守卫提示由结构化计数按语言组句（E 项）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /function guardHintOf/u, '必须有组句函数')
  const start = source.indexOf('function guardHintOf')
  const fn = source.slice(start, source.indexOf('\n\t\t}', start) + 3)
  assert.ok(fn.length > 300, `guardHintOf 函数体要完整截取到（现在 ${String(fn.length)} 字符）`)
  // 有计数用计数组句；没有计数才退回宿主 reasons（宁可中文原文也不编话）。
  assert.match(fn, /tasks\.turns/u, '要用宿主给的结构化计数（turns）')
  assert.match(fn, /installs\.running/u, '要用宿主给的结构化计数（installs）')
  assert.match(fn, /guard\.reasons.*join/us, '没有计数时退回宿主原句')
})

await ok('client bundle：安装中的硬拦不弹「仍要重启」，也不说「仍可重启」', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  const blockedAt = source.indexOf('result.blocked === true')
  const guardAt = source.indexOf('result.guard === true')
  assert.ok(blockedAt > 0, '必须识别宿主半的硬拦响应')
  assert.ok(blockedAt < guardAt, '硬拦要排在守卫确认之前，否则会弹一个勾选了也没用的确认框')
  assert.match(source, /guardSuffix/u, '守卫提示的出路必须按 blocked 分开写')
  assert.match(source, /blockedSuffix/u, '硬拦时必须说清「装完之前不能重启」（字典键）')
})

await ok('client bundle：字典 zh/en 两表键一致，代码引用的键全部存在（issue #1）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 抠出 DICT 的两个语言表
  const dictStart = source.indexOf('const DICT = {')
  assert.ok(dictStart > 0, '必须有字典')
  const tableOf = (lang) => {
    const start = source.indexOf(lang + ': {', dictStart)
    assert.ok(start > 0, `字典里必须有 ${lang} 表`)
    const end = source.indexOf('},', start)
    return source.slice(start, end)
  }
  const keysOf = (table) => [...table.matchAll(/^\t{4}([A-Za-z0-9_]+):/gm)].map((m) => m[1])
  const zh = keysOf(tableOf('zh'))
  const en = keysOf(tableOf('en'))
  assert.equal(zh.length, en.length, '两个语言表的键数必须一致')
  const zhSet = new Set(zh)
  const enSet = new Set(en)
  assert.deepEqual(zh.filter((k) => !enSet.has(k)), [], '只在 zh 里的键是坏键')
  assert.deepEqual(en.filter((k) => !zhSet.has(k)), [], '只在 en 里的键是坏键')
  // 代码里 t("key") 引用的每一个键都必须在表里
  const used = [...source.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1])
  assert.ok(used.length > 40, `t() 引用应当覆盖几乎全部文案（现在 ${String(used.length)} 个）`)
  const missing = [...new Set(used)].filter((k) => !zhSet.has(k))
  assert.deepEqual(missing, [], `t() 引用了字典里不存在的键：${missing.join(', ')}`)
  // 间接引用：ENTRY_LABELS 与 DEFAULT_HINT_KEY / hostMessage 的 fallbackKey。
  // 只认 ENTRY_LABELS 那张表里的键对（锚定它后面的 t(copy[N])），否则
  // inject: ["slots", "locale"] 这类服务名数组也会被这个形状误抓
  // （0.4.1 首跑就这么红的 —— 服务声明不是字典键）。
  const entryBlock = /const ENTRY_LABELS = \{([\s\S]*?)\n\t\t\}/.exec(source)
  assert.ok(entryBlock, '必须保留 ENTRY_LABELS 表（四个入口的标题/说明键）')
  const entryKeys = [...entryBlock[1].matchAll(/\["([A-Za-z0-9_]+)",\s*"([A-Za-z0-9_]+)"\]/g)].flatMap((m) => [m[1], m[2]])
  assert.ok(entryKeys.length === 8, `ENTRY_LABELS 应有 4 行 × 2 键（现在 ${String(entryKeys.length)}）`)
  const entryMissing = entryKeys.filter((k) => !zhSet.has(k))
  assert.deepEqual(entryMissing, [], `ENTRY_LABELS 引用了不存在的键：${entryMissing.join(', ')}`)
  for (const key of ['defaultHint', 'blockedFallback', 'guardFallback', 'sweepLastPrefix', 'sweepJustNow', 'extrasSubtitle']) {
    assert.ok(zhSet.has(key), `间接引用的键必须存在：${key}`)
  }
  // 设置分区里两件「与重启无关」的顺手功能合并进同一个分类（2026-10-20 用户
  // 要求合并；同日第二次要求：标题只写「附带功能」，不特意标明与重启的关系）。
  assert.match(source, /t\("extrasSubtitle"\)/u, '两件附带功能应共用同一个分类标题')
  assert.doesNotMatch(source, /sweepSubtitle|tidySubtitle/u, '旧的分开小标题应已移除')
  assert.ok(
    /extrasSubtitle: "附带功能",/u.test(source),
    '中文标题应就是「附带功能」四个字（不带括号说明）',
  )
  assert.ok(
    /extrasSubtitle: "Bundled extras",/u.test(source),
    '英文标题不带 "unrelated to restarting" 括号说明',
  )
})

await ok('client bundle：locale 服务可用则用之，不可用则按浏览器语言兜底', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 注册进官方 locale（语言跟随主应用）；注册失败/服务缺席时保留兜底 —— 不能起不来。
  assert.match(source, /locale\.register\(LOCALE_NS, DICT\)/u, '必须把字典注册进官方 locale 服务')
  assert.match(source, /locale\.bind\(LOCALE_NS\)/u, '必须用官方 bind 拿翻译函数')
  assert.match(source, /navigator\.language/u, '兜底要按浏览器语言挑 zh/en')
  // 接入约定（0.4.0 的教训，2026-10-20 实测）：服务必须在导出的 inject 数组里
  // 声明、经 ctx.locale 访问 —— 只写 ctx.get("locale") 拿到 undefined，代码
  // 静默落到浏览器语言兜底，主应用切英文也不管用。官方插件全库 350+ 处都是
  // inject 声明的写法，ctx.get("locale") 仅 1 处例外。
  assert.match(
    source,
    /inject:\s*\["slots",\s*"locale"\]/u,
    '导出的 inject 数组必须声明 "locale"，否则服务根本注入不进来（0.4.0 因此失效）',
  )
  assert.match(source, /ctx\.locale/u, '必须经 ctx.locale 访问服务（inject 声明的注入方式）')
  // 注入声明
  const pkg = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'))
  assert.ok(
    pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-locale'),
    'package.json 的 dsh.client.inject 必须声明 locale 包',
  )
  // 模块级不再有写死的界面中文 —— 字典与 CONTACT_LABELS（按文字认菜单项，
  // 中英都要认，不能翻译）是仅有的例外。
  const dictStart = source.indexOf('const DICT = {')
  const dictEnd = source.indexOf('};', source.indexOf('hideContactOff:'))
  const outside = source.slice(0, dictStart) + source.slice(dictEnd + 2)
  const lines = outside.split('\n')
  const offenders = []
  lines.forEach((line, index) => {
    if (/const CONTACT_LABELS/.test(line)) return
    for (const hit of line.matchAll(/"([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g)) offenders.push(`L${String(index + 1)}: ${hit[1]}`)
  })
  assert.deepEqual(
    offenders,
    [],
    `字典之外仍有写死的中文界面文案（issue #1 的回归）：${offenders.join(' | ')}`,
  )
})

await ok('client bundle：自己注入样式，且重复加载不重复插入', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /typeof document !== "undefined"/u, '没有 document 的环境（测试 / SSR）不能炸')
  assert.match(source, /querySelector\("style\[data-plugin-css=/u, '重复加载时不能重复插入同一个 style')
  assert.match(source, /\.dshdr-/u, '选择器必须自带前缀，不能影响别的插件')
})

await ok('client bundle：标题栏按钮照抄官方座位里的真实按钮（ui-jobs JobListAction）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 数值逐字取自 packages/client/ui-jobs/src/client/JobListAction.module.css 的 .trigger
  // —— 它就是会话标题栏 conversation.session.header.actions 座位里的真实按钮。
  for (const token of [
    'min-height:28px',
    'padding:3px 2px',
    'gap:3px',
    '--dsw-radius-sm',
    'line-height:18px',
    '--dsw-alias-label-tertiary',
    '@container (width<=540px)',
  ]) {
    assert.ok(source.includes(token), `缺少与官方标题栏动作一致的 ${token}`)
  }
  assert.match(
    source,
    /\.dshdr-trigger:hover:not\(:disabled\),\.dshdr-trigger:focus-visible\{color:var\(--dsw-alias-label-secondary/u,
    '官方 hover / focus 只把字色提到 label-secondary，不加任何底色',
  )
})

await ok('client bundle：忙碌时有旋转动画，并尊重系统的减少动效', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /@keyframes dshdr-spin/u)
  assert.match(source, /data-busy=1/u)
  assert.match(source, /prefers-reduced-motion:reduce/u)
})

await ok('client bundle：状态色用官方 token 名（warn，不是 warning）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /data-phase=warn\]\{color:var\(--dsw-alias-state-warn-primary/u, '会打断工作用官方的 warn 色')
  assert.match(source, /data-phase=error\]\{color:var\(--dsw-alias-state-error-primary/u, '失败才是红色')
  assert.match(source, /data-phase=confirm\]\{color:var\(--dsw-alias-label-primary/u, '普通确认只做中性强调')
  assert.ok(!source.includes('--dsw-alias-state-warning-primary'), '官方没有 state-warning-primary 这个 token')
  assert.ok(!source.includes('--dsw-alias-interactive-bg-hover-warning'), '这个 token 也不存在，别自造')
  assert.match(source, /:active:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-active/u, '按下态用官方 active token')
  assert.match(source, /var\(--dsw-focus-ring-width/u, '焦点环用官方 token')
})

await ok('client bundle：状态变化对读屏可见（aria-live / aria-label / aria-busy）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /"aria-live": "polite"/u)
  assert.match(source, /"aria-label": ariaLabelOf\(action\)/u)
  assert.match(source, /"aria-busy"/u)
})

await ok('client bundle：aria-label 绝不放动态提示（皮肤插件会把它当可见标题）', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 2026-10-20 用户上报：dsh-claude-style 接管侧栏底部时用
  // `getAttribute("aria-label") || textContent` 当行标题，我们把
  // 「有任务在跑（…）；点两次仍可重启」塞进 aria-label，结果那句话
  // 被画成了按钮文字。这条断言把「提示不得进 aria-label」钉死。
  const start = source.indexOf('function ariaLabelOf')
  assert.ok(start > 0, '必须有 ariaLabelOf')
  const body = source.slice(start, source.indexOf('\n\t\t}', start) + 3)
  assert.ok(body.length > 100, `ariaLabelOf 函数体要能完整截取（现在 ${String(body.length)}）`)
  assert.doesNotMatch(body, /guardHint/u, 'aria-label 不得包含守卫提示（会被皮肤插件画成可见文字）')
  assert.doesNotMatch(body, /message/u, 'aria-label 不得包含结果消息')
  assert.doesNotMatch(body, /ariaWithGuard/u, '拼长句的那个键已废弃')
  // 提示改走 aria-describedby，且目标是一段视觉隐藏文本
  assert.match(source, /function ariaDescriptionOf/u, '必须有独立的详细提示函数')
  assert.match(source, /"aria-describedby": described === "" \? undefined : hintId/u, '两个常驻按钮都要接 describedby')
  assert.match(source, /className: "dshdr-sr-only"/u, 'describedby 的目标必须是视觉隐藏文本')
  assert.match(source, /\.dshdr-sr-only\{position:absolute;[^}]*clip:rect/u, 'sr-only 样式必须真的把它藏掉')
  // 提示不许进按钮的 textContent（皮肤插件在 aria-label 缺失时也会读它）
  const headerAt = source.indexOf('function HeaderRestartButton')
  const headerBody = source.slice(headerAt, source.indexOf('function SettingsRestartRow', headerAt))
  assert.match(headerBody, /described !== "" && React\.createElement\("span", \{ id: hintId/u, '隐藏提示是按钮的兄弟节点，不在按钮里面')
})

await ok('client bundle：无障碍文案保持短（≤12 字），不随状态膨胀', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  const dictStart = source.indexOf('const DICT = {')
  const zhStart = source.indexOf('zh: {', dictStart)
  const zhBlock = source.slice(zhStart, source.indexOf('en: {', zhStart))
  const pairs = [...zhBlock.matchAll(/^\t{4}(aria[A-Za-z]+): "([^"]*)",/gm)].map((m) => [m[1], m[2]])
  assert.ok(pairs.length >= 6, `aria* 键应至少 6 个（现在 ${String(pairs.length)}）`)
  for (const [key, text] of pairs) {
    assert.ok(text.length <= 12, `${key} 太长（${String(text.length)} 字）：${text}`)
    assert.doesNotMatch(text, /任务|队列|安装/u, `${key} 不该带动态状态：${text}`)
  }
})

await ok('client bundle：图标优先用官方 IconRefreshOutlineRegular，兜底也是 16 格描边', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /UI\.IconRefreshOutlineRegular/u, '官方图标集里有现成的刷新图标，优先用它')
  assert.match(source, /viewBox: "0 0 16 16"/u, '兜底图标按官方约定画在 16 格里')
  assert.match(source, /stroke: "currentColor"/u, '图标要跟文字颜色走')
  assert.match(source, /fill: "none"/u, '描边图标必须 fill:none，否则会填成实心')
  assert.doesNotMatch(source, /"⟳"/u, '不该再用字体符号当图标（字体缺字时会出现方框）')
})

await ok('client bundle：直接用官方组件，且取不到时有兜底', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/u, '要 require 官方组件库本体')
  assert.match(source, /catch \{[\s\S]{0,40}?UI = null/u, 'require 必须在 try/catch 里：官方改名也不能把插件带崩')
  assert.match(source, /UI\.Button/u, '设置页按钮用官方 Button')
  assert.match(source, /UI\.RiskConfirmation/u, '风险确认用官方 RiskConfirmation')
  assert.match(source, /variant: "ghost"/u, '官方 Button 的变体')
  assert.match(source, /acknowledged: action\.modal\.acknowledged/u, 'RiskConfirmation 是受控的：勾选状态由调用方持有')
  assert.match(source, /onAcknowledgedChange/u, '勾选回调用官方约定的名字')
  assert.match(source, /data-variant": "ghost"/u, '兜底按钮也照抄官方 ghost 变体')
})

await ok('package.json：client.inject 声明了官方组件库', async () => {
  const inject = packageJson.dsh.client.inject
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-primitives'), '必须在 inject 里声明，加载器才会先注册它')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'), '标题栏座位来自这个包')
})

await ok('文档：英文 README 存在、进包、且与中文版互相链接（issue #1 的延伸）', async () => {
  const enPath = join(libDir, '..', 'README.en.md')
  assert.ok(existsSync(enPath), 'README.en.md 必须存在')
  const en = readFileSync(enPath, 'utf8')
  // 英文版要有内容、要有回链、要覆盖关键章节 —— 不是占位文件。
  assert.ok(en.length > 8000, `英文 README 应当是完整翻译而不是占位（现在 ${String(en.length)} 字符）`)
  assert.match(en, /\[简体中文\]\(README\.md\)/u, '英文版顶部要回链中文版')
  for (const section of ['## Install', '## Usage', '## Security model', '## Known limitations']) {
    assert.ok(en.includes(section), `英文版缺少章节：${section}`)
  }
  const zh = readFileSync(join(libDir, '..', 'README.md'), 'utf8')
  assert.match(zh, /\[English\]\(README\.en\.md\)/u, '中文版顶部要前链英文版')
  assert.ok(packageJson.files.includes('README.en.md'), 'files 必须包含 README.en.md，否则 npm 包里没有它')
})

await ok('会话标题栏：必须排在后台任务条目（order 20）之前', async () => {
  const { plugin } = loadClientBundle()
  const registered = []
  const slots = {
    inject: (name, fn) => { fn() },
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  }
  plugin.apply({
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  })
  const header = registered.find((entry) => entry.name === 'conversation.session.header.actions')
  assert.ok(header !== undefined, '必须注册会话标题栏条目')
  assert.equal(typeof header.order, 'number', '标题栏条目必须显式声明 order')
  assert.ok(
    header.order < 20,
    '标题栏动作组是左紧排的：排在内置 jobs 条目（order 20）之后，'
      + '后台任务一跑起来本按钮就会被「N 个后台任务」往右顶走一截'
      + `（2026-10-06 实测 134px）。当前 order=${String(header.order)}`,
  )
})

await ok('左上角：注册进官方面板座位（同任务看板），行交给侧栏绘制', async () => {
  const { plugin } = loadClientBundle()
  const registered = []
  const slots = {
    inject: (name, fn) => { fn() },
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  }
  plugin.apply({
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  })
  const panel = registered.find((entry) => entry.name === 'sidebar.panellist')
  assert.ok(panel !== undefined, '必须注册到左上角的面板座位')
  assert.equal(panel.id, 'dsh-desktop-restart')
  assert.equal(typeof panel.order, 'number', '官方行按 order 排序')
  assert.equal(typeof panel.label, 'function', '官方行用 label 画文字（任务看板传的也是函数）')
  const main = registered.find((entry) => entry.name === 'main')
  assert.ok(main !== undefined, '必须注册主区面板，否则点开是空的')
  assert.equal(main.key, 'dsh-desktop-restart', 'main 是按 key 配对的面板')

  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /function PanelGlyph/u, '这个座位只提供图标组件')
  assert.match(source, /variant: "primary"/u, '面板里的按钮用官方 Button 的 primary 变体')
})

await ok('插件开关：宿主 config 里的入口开关（缺省 true）', async () => {
  assert.deepEqual(__test.readEntries({}), { panel: true, footer: true, header: true, command: true, settingsRow: true })
  const off = __test.readEntries({ footer: false, command: false })
  assert.equal(off.footer, false)
  assert.equal(off.command, false)
  assert.equal(off.panel, true, '没写的按 true')
})

await ok('插件开关：状态接口把默认开关给客户端', async () => {
  const res = makeRes()
  await statusRoute.handler(makeReq('GET'), res)
  const body = JSON.parse(res.body)
  assert.ok(body.entries && typeof body.entries === 'object', '状态里要有 entries')
  assert.equal(body.entries.footer, true)
  assert.equal(typeof body.entries.header, 'boolean')
})

await ok('插件开关：本机保存的选择能真的关掉入口（并保留开关页）', async () => {
  const store = new Map([['dsh-desktop-restart.entries', JSON.stringify({ footer: false })]])
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  const { plugin } = loadClientBundle({ storage })
  const registered = []
  const slots = {
    inject: (name, fn) => {
      fn()
      return () => {}
    },
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  }
  plugin.apply({
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  })
  const names = registered.map((entry) => entry.name)
  assert.ok(!names.includes('sidebar.footer.action'), '本地关掉的入口不该再注册')
  assert.ok(names.includes('sidebar.panellist'), '没关的照旧注册')
  assert.ok(names.includes('conversation.session.header.actions'))
  assert.ok(names.includes('settings.general.item'))
  assert.ok(names.includes('settings.section'), '开关页本身必须一直在，否则关掉就回不来了')
})

await ok('插件开关：清理那一行读写的宿主设置，不是浏览器本地', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /function SweepRow/u, '设置页要有这一行')
  assert.match(source, /SWEEP_ROUTE/u, '必须打宿主路由，不能只在本地记一下')
  assert.match(source, /\?enabled=1/u, '打开开关要通知宿主')
  assert.match(source, /\?enabled=0/u, '关掉开关也要通知宿主')
  assert.match(source, /\?run=1/u, '「立即清理」要能单独触发一次')
  assert.match(source, /sweep: body\.sweep/u, '开关状态必须来自宿主的状态接口（不许客户端自己编默认值）')
  assert.match(source, /躺够 24 小时/u, '界面要说清只清理什么样的目录')
})

await ok('左侧边栏：注册进官方座位 sidebar.footer.action，照官方 42px 动作行', async () => {
  const { plugin } = loadClientBundle()
  const registered = []
  const slots = {
    inject: (name, fn) => { fn() },
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  }
  plugin.apply({
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  })
  const footer = registered.find((entry) => entry.name === 'sidebar.footer.action')
  assert.ok(footer !== undefined, '必须注册到官方给第三方留的侧栏座位')
  assert.equal(footer.id, 'dsh-desktop-restart')
  assert.equal(footer.order, 100, '官方示例用的 order 是 100')
  assert.ok(typeof footer.label === 'string' && footer.label.length > 0, '官方示例带 label')

  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 数值逐字取自**同一个座位里另外两个占用者**（它们完全一致）：官方插件面板
  // CordisPanel.module.css 与第三方 dsh-diff-approval 的 PendingPanel.module.css。
  // 上一轮曾改成「侧栏设置行」（另一个座位）的数值，反而偏离了同座位的邻居。
  for (const token of [
    'height:42px',
    'border-radius:12px',
    'gap:8px',
    'padding:0 10px 0 8px',
    'font-size:14px',
    'line-height:22px',
    'width:calc(100% + 4px)',
    'margin:4px -2px',
  ]) {
    assert.ok(source.includes(token), `缺少与同座位占用者一致的 ${token}`)
  }
  assert.match(
    source,
    /\.dshdr-foot-badge:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover/u,
    '官方 hover 是加 interactive-bg-hover 底色',
  )
  assert.match(
    source,
    /\.dshdr-foot\[data-rail=1\]\{width:36px;height:36px;margin:8px 0 10px\}/u,
    '收起成 rail 时官方是 36×36、margin 8px 0 10px',
  )
  assert.match(
    source,
    /\.dshdr-foot\[data-rail=1\] \.dshdr-foot-badge\{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0\}/u,
    '收起成 rail 时官方是圆形',
  )
  // 同座位里 dsh-diff-approval 的条目也是整行宽 + flex:none；容器不允许换行时，
  // 后注册的那个会被挤出容器、只露出一角（2026-10-09 实测）。
  assert.match(
    source,
    /\[class\*=\\"footerActions\\"\]:has\(\.dshdr-foot\)\{flex-wrap:wrap !important\}/u,
    '同座位多个整行条目时，容器必须允许换行，且只命中装着本插件这一行的容器',
  )
})

await ok('插件开关：手动清理必须留下看得见的回执', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 2026-10-10 实测：清理结果通常是「扫描 N 个、删掉 0 个」，两次一模一样时界面
  // 毫无变化，用户以为按钮坏了（其实点击成功）。所以手动清理必须写一句带时间戳的回执。
  assert.match(source, /刚刚清理过/u, '手动清理后必须写一句回执')
  assert.match(source, /const clockOf/u, '回执要带时间戳，让「又跑了一次」看得见')
  assert.match(source, /describe\(last\)/u, '提示文字统一走 describe（含时间戳）')
  assert.match(source, /call\("\?run=1", true\)/u, '「立即清理」要标成手动触发')
  assert.match(source, /const toggle = /u, '开关的拨动处理要单独一处，别把形状假设写死在 JSX 里')
})

await ok('插件开关：清理结果要显眼 —— 独立一行、按结果上色、跑起来转圈', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 2026-10-10 第二轮实测：上一轮只是把回执写成 12px 的 hint（`.dshdr-set-hint`），
  // 读完仍然觉得「好像没发生什么」。结果因此独立成行、按结果上色，忙碌时转圈。
  assert.match(source, /className: "dshdr-set-result"/u, '结果必须有自己的那一行，不再借 hint 的位置')
  assert.match(
    source,
    /\.dshdr-set-result\[data-tone=ok\]\{color:var\(--dsw-alias-state-success-primary/u,
    '成功用官方成功色',
  )
  assert.match(
    source,
    /\.dshdr-set-result\[data-tone=warn\]\{color:var\(--dsw-alias-state-warn-primary/u,
    '有目录没删掉是警告色，不能谎报成功',
  )
  assert.match(
    source,
    /\.dshdr-set-result\[data-tone=error\]\{color:var\(--dsw-alias-state-error-primary/u,
    '失败用官方错误色',
  )
  assert.match(source, /const toneOf = /u, '颜色要有唯一一处判定，别散落在各处')
  assert.match(
    source,
    /\.dshdr-spin\{display:inline-flex;transform-origin:center;animation:dshdr-spin/u,
    '忙碌时图标要转起来（官方 Button 不接受 data-busy，所以用可复用的类）',
  )
  assert.match(
    source,
    /prefers-reduced-motion:reduce\)\{[^}]*\.dshdr-spin\{animation:none\}/u,
    '系统开了「减少动效」时必须停转',
  )
})

await ok('顺手收拾界面：默认按文字藏掉账号菜单里的「意见反馈」，且不碰别的行', async () => {
  const loads = []
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  /** 一个只够本插件用的假菜单项。 */
  const makeItem = (text) => ({
    nodeType: 1,
    role: 'menuitem',
    textContent: text,
    parentElement: null,
    style: {},
    attrs: {},
    matches: (selector) => selector === 'button[role="menuitem"]',
    querySelectorAll: () => [],
    setAttribute(key, value) { this.attrs[key] = value },
    removeAttribute(key) { delete this.attrs[key] },
  })
  const contact = makeItem('意见反馈')
  const settings = makeItem('设置')
  const observerState = { observed: false }
  class FakeMutationObserver {
    observe() { observerState.observed = true }
    disconnect() {}
  }
  runInNewContext(source, {
    window: {
      __ModuleLoader__: { load: (spec) => loads.push(spec) },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: {
      body: {
        nodeType: 1,
        textContent: '',
        matches: () => false,
        querySelectorAll: (selector) => (selector === 'button[role="menuitem"]' ? [settings, contact] : []),
      },
      // 本插件还会在这次调用里注入一次自己的样式（真实浏览器里是 <style>）——
      // 假 DOM 得让这条路径也走得通，否则测不到下面的行为。
      querySelector: () => null,
      createElement: () => ({ dataset: {} }),
      head: { appendChild: () => {} },
      querySelectorAll: () => [],
    },
    MutationObserver: FakeMutationObserver,
  })
  const react = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const plugin = loads[0].factory((name) => (name === 'react' ? react : undefined))
  const slots = { inject: (name, fn) => { fn() }, register: () => () => {} }
  plugin.apply({ get: (key) => (key === 'slots' ? slots : undefined), effect: (fn) => fn() })
  assert.equal(contact.style.display, 'none', '默认就该把「意见反馈」藏起来')
  assert.equal(contact.attrs['data-dshdr-hidden'], '1', '要留标记，关掉开关时才恢复得回来')
  assert.equal(settings.style.display, undefined, '「设置」那一项：一个字节都不许动')
  assert.equal(observerState.observed, true, '要盯着以后挂上来的菜单（它是点开才渲染的）')
  assert.equal(
    loads[0].factory.length,
    1,
    'factory 仍然只接受 require 一个参数',
  )
})

await ok('顺手收拾界面：开关存在本机、关掉能原样恢复，认不出文字就不动手', async () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /const CONTACT_LABELS = \["意见反馈", "Feedback"\]/u, '认人只用这两种文字')
  assert.match(source, /button\[role=\\"menuitem\\"\]/u, '内置账号菜单给的就是这个形状，没有 id / data 可认')
  assert.match(source, /new MutationObserver/u, '菜单是点开才挂 DOM 的，不能只在启动时扫一次')
  assert.match(source, /node\.removeAttribute\(HIDER_ATTR\)/u, '关掉开关要把标记摘掉')
  assert.match(source, /node\.style\.display = ""/u, '关掉开关要把被藏的元素放开')
  assert.match(source, /HIDE_CONTACT_STORE_KEY/u, '开关存本机即可（这是纯客户端行为）')
  assert.match(source, /raw === null \? true : raw !== "0"/u, '没存过时默认隐藏')
  assert.match(source, /CONTACT_LABELS\.indexOf\(text\) < 0/u, '认不出就跳过，绝不误伤别的菜单项')
})

await ok('host bundle：cordis.patch.yml 挂载的包名等于 package.json 的包名', async () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const mounted = [...patch.matchAll(/^\s*name:\s*["']?([^"'\s#]+)["']?\s*$/gmu)].map((match) => match[1])
  assert.deepEqual(mounted, [packageJson.name], 'cordis.patch.yml 里的挂载名必须与包名一致')
})

console.log('helper')

await ok('helper：缺参数时以退出码 1 结束', async () => {
  const result = spawnSync(process.execPath, [helperPath], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

await ok('helper：handoff 文件不存在时以退出码 1 结束', async () => {
  const result = spawnSync(process.execPath, [helperPath, join(tmpdir(), 'dsh-desktop-restart-missing.json')], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

await okWindows('helper：目标映像名不符时拒绝，且不启动任何进程', async () => {
  const dir = scratch('smoke')
  const logPath = join(dir, 'helper.log')
  const handoffPath = join(dir, 'handoff.json')
  writeFileSync(handoffPath, JSON.stringify({
    mainPid: process.pid,
    // 故意声明一个与当前进程映像名不同的目标：helper 必须拒绝。
    exe: 'C:\\Windows\\System32\\notepad.exe',
    hostPid: 1,
    port: 0,
    logPath,
    delayMs: 50,
  }), 'utf8')

  const result = spawnSync(process.execPath, [helperPath, handoffPath], { encoding: 'utf8' })
  assert.equal(result.status, 0)

  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /refusing/u, 'helper 应当记录拒绝原因')
  assert.doesNotMatch(log, /relaunched/u, 'helper 不应启动任何进程')
})

await okWindows('helper：新实例立刻退出时会重试，试完如实认输且不谎报成功', () => {
  const dir = scratch('relaunch')
  const logPath = join(dir, 'helper.log')
  const handoffPath = join(dir, 'handoff.json')
  writeFileSync(handoffPath, JSON.stringify({
    // 不存在的 pid：helper 查不到映像名，于是跳过 kill，直接走到拉起那一步。
    mainPid: 999999999,
    // where.exe 不带参数会立即退出，正好模拟「拉起来了但没活下来」。
    exe: 'C:\\Windows\\System32\\where.exe',
    hostPid: 1,
    port: 0,
    logPath,
    delayMs: 50,
    relaunchAttempts: 3,
    relaunchVerifyMs: 100,
    // 测试与无人值守部署可以关掉失败弹窗，否则这里会弹出模态框。
    alertOnFailure: false,
  }), 'utf8')

  const result = spawnSync(process.execPath, [helperPath, handoffPath], { encoding: 'utf8' })
  assert.equal(result.status, 0)

  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /relaunched/u, '应当记录已拉起')
  assert.match(log, /already gone/u, '应当识别出新实例已经退出')
  assert.match(log, /relaunch attempt 2\/3/u, '第一次没活下来应当再试')
  assert.match(log, /relaunch attempt 3\/3/u, '第二次没活下来应当再试')
  assert.match(log, /did not take after 3 attempt/u, '试完必须如实认输')
  assert.doesNotMatch(log, /restart complete/u, '不应谎报重启完成')
})

await ok('helper：把主进程的启动参数原样带回（引号与空格）', async () => {
  const exe = 'C:\\Program Files\\DSH\\DeepSeek Harness.exe'
  assert.deepEqual(helper.relaunchArgsFrom(`"${exe}"`, exe), [], '只有可执行文件时等于没有参数')
  assert.deepEqual(
    helper.relaunchArgsFrom(`"${exe}" --user-data-dir "D:\\my data\\dsh" --inspect=9229`, exe),
    ['--user-data-dir', 'D:\\my data\\dsh', '--inspect=9229'],
  )
  assert.equal(helper.relaunchArgsFrom(`"C:\\Other\\app.exe" --x`, exe), null, '命令行不是同一个程序时放弃复用')
  assert.equal(helper.relaunchArgsFrom(`"${exe}" "a\\"b"`, exe), null, '带转义引号时不做有损解析')
  // 同一个可执行文件还有渲染/GPU 子进程与 host 两种身份，抓错就宁可不带参数：
  // 2026-10-08 活体验证时，按 pid 抓错一行就能拿到一长串 Chromium 内部开关。
  assert.equal(
    helper.relaunchArgsFrom(`"${exe}" --type=renderer --user-data-dir="C:\\x"`, exe),
    null,
    '渲染/GPU 子进程的命令行不是启动参数',
  )
  assert.equal(
    helper.relaunchArgsFrom(`"${exe}" --expose-internals "C:\\host.js" "C:\\profiles\\desktop"`, exe),
    null,
    'host 子进程的命令行不是启动参数',
  )
  assert.equal(helper.relaunchArgsFrom('', exe), null)
  assert.equal(helper.relaunchArgsFrom(undefined, exe), null)
})

await ok('helper：兜底清理只认同一个可执行文件，且跳过 host / 主进程 / 自己', async () => {
  const exe = 'C:\\Program Files\\DSH\\DeepSeek Harness.exe'
  const processes = [
    { pid: 10, path: exe },
    { pid: 11, path: exe.toUpperCase() },
    { pid: 12, path: 'D:\\Other Copy\\DeepSeek Harness.exe' },
    { pid: 13, path: null },
    { pid: 0, path: exe },
    { pid: 'x', path: exe },
  ]
  assert.deepEqual(helper.leftoverPids(processes, exe), [10, 11])
  // host 与主进程、helper 自己用的是同一个可执行文件：它们必须由调用方显式排除，
  // 否则 host 会被当成「残留进程」顺手结束 —— 那正是「不带 /T」要避免的事。
  assert.deepEqual(helper.leftoverPids(processes, exe, [10]), [11], 'skip 里的 pid 不参与清理')
  assert.deepEqual(helper.leftoverPids(processes, exe, [10, 11]), [], '全被排除时没有候选')
  assert.deepEqual(helper.leftoverPids([], exe), [])
  assert.deepEqual(helper.leftoverPids(null, exe), [])
})

await okWindows('helper：端口迟迟不放时先清残留，最后才单独结束 host', async () => {
  // 占住一个端口，模拟「主进程已经没了，host 还攥着监听不放」。
  const server = net.createServer()
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port

  // 替身 host：一个真的进程，等 helper 来结束它。
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  /** 进程是否还在。 */
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  try {
    const dir = scratch('host')
    const logPath = join(dir, 'helper.log')
    const handoffPath = join(dir, 'handoff.json')
    writeFileSync(handoffPath, JSON.stringify({
      // 已经不在的主进程：helper 查不到映像名，于是跳过 kill。
      mainPid: 999999999,
      exe: 'C:\\Windows\\System32\\where.exe',
      hostPid: decoy.pid,
      port,
      logPath,
      delayMs: 50,
      relaunchAttempts: 1,
      relaunchVerifyMs: 100,
      // 三个等待上限在这里缩短，免得这条用例真的等满 30 秒。
      mainExitTimeoutMs: 200,
      portFreeTimeoutMs: 200,
      portRelistenTimeoutMs: 200,
      alertOnFailure: false,
    }), 'utf8')

    const result = spawnSync(process.execPath, [helperPath, handoffPath], { encoding: 'utf8' })
    assert.equal(result.status, 0)

    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /port \d+ is still held/u, '应当识别出端口还被占着')
    assert.match(log, /still holds port/u, '应当识别出攥着端口的正是 host')
    assert.match(log, /as a last resort/u, '应当写明这是最后手段、代价是什么')
    assert.doesNotMatch(
      log,
      new RegExp(`killing leftover pid ${String(decoy.pid)}\\b`, 'u'),
      'host 不该混在残留进程里被顺手带走',
    )

    await new Promise((resolve) => { setTimeout(resolve, 300) })
    assert.equal(alive(decoy.pid), false, '最后一道必须真的结束 host')
  } finally {
    if (alive(decoy.pid)) decoy.kill()
    server.close()
  }
})

await okWindows('helper：问不出进程表时不当成「主进程已经没了」', async () => {
  // 把 PATH 指到一个空目录：tasklist / taskkill / powershell 全都调不到，
  // 正好模拟「进程表读不出来」。helper 必须照样结束主进程，而不是以为它已经没了。
  const emptyPath = scratch('nopath')
  const dir = scratch('blind')
  const logPath = join(dir, 'helper.log')
  const handoffPath = join(dir, 'handoff.json')
  writeFileSync(handoffPath, JSON.stringify({
    // 不存在的 pid：正常路径下 helper 会查到「映像名 null」，据此跳过 kill。
    mainPid: 999999999,
    exe: 'C:\\Windows\\System32\\where.exe',
    hostPid: 1,
    port: 0,
    logPath,
    delayMs: 50,
    relaunchAttempts: 1,
    relaunchVerifyMs: 100,
    alertOnFailure: false,
  }), 'utf8')

  const result = spawnSync(process.execPath, [helperPath, handoffPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyPath, Path: emptyPath },
  })
  assert.equal(result.status, 0)

  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /could not read the process table/u, '读不到进程表时必须如实说明')
  assert.match(log, /without an image-name check/u, '读不到时仍然要结束主进程')
  assert.doesNotMatch(log, /is already gone; skipping the kill/u, '「问不出来」不能被当成「已经没了」')
})

await ok('helper：命令行分词在引号内保留空格', async () => {
  assert.deepEqual(helper.tokenizeCommandLine('a "b c" d'), ['a', 'b c', 'd'])
  assert.deepEqual(helper.tokenizeCommandLine('  a   b  '), ['a', 'b'])
  assert.deepEqual(helper.tokenizeCommandLine('""'), [''])
  assert.deepEqual(helper.tokenizeCommandLine(''), [])
})

await ok('helper：从 netstat 里认出「谁在听」（重启完成的新判据）', async () => {
  // 0.2.1-rc.2 起桌面版每次启动换端口，所以不能再等旧端口回来，
  // 只能反过来找「同一个可执行文件开着的回环监听」。
  const sample = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000',
    '  TCP    127.0.0.1:4453         0.0.0.0:0              LISTENING       47176',
    '  TCP    127.0.0.1:8418         127.0.0.1:1335         ESTABLISHED     30396',
    '  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4',
    '  TCP    [::1]:10317            [::]:0                 LISTENING       44896',
    '  UDP    127.0.0.1:1900         *:*                                    3000',
    '  TCP    fe80::1%12:54321       0.0.0.0:0              LISTENING       777',
    '',
  ].join('\r\n')
  const rows = helper.parseNetstatListeners(sample)
  assert.ok(Array.isArray(rows))
  assert.deepEqual(
    rows.map((row) => row.port).sort((a, b) => a - b),
    [135, 4453, 10317],
    '只取回环/通配地址上的 LISTENING：局域网地址、ESTABLISHED、UDP 都不算',
  )
  assert.deepEqual(rows.find((row) => row.port === 4453), { port: 4453, pid: 47176 })
  assert.equal(helper.parseNetstatListeners(''), null, '读不到要回 null，而不是「没有在听」')
  assert.equal(helper.parseNetstatListeners(undefined), null)
})

await ok('文档：README 里写的冒烟测试数量与实际一致', async () => {
  // 这条挡的是「加了测试却忘了改文档」—— 也顺带挡住反过来的「文档说加了、其实没加」
  // 那种曾经出现过的情况（2026-10-15：提交说明写着新增 10 项，仓库里一项都没有）。
  const readme = readFileSync(join(libDir, '..', 'README.md'), 'utf8')
  const claimed = /离线冒烟测试（(\d+) 项，其中 (\d+) 项仅 Windows）/u.exec(readme)
  assert.ok(claimed, 'README 必须写明「总数 + 其中仅 Windows 的数量」')
  const total = Number(claimed[1])
  const windowsOnly = Number(claimed[2])
  // 这一条自己也占一项；仅 Windows 的用例在本平台跳过时不计入。
  const expectedHere = total - (process.platform === 'win32' ? 0 : windowsOnly)
  assert.equal(passed + 1, expectedHere, 'README 写的数量与本平台实际不符：加了测试就要同步改文档')
  // 「仅 Windows」的声明也要对账 —— 非 Windows 平台上真能数出来；Windows 上
  // 跑不到这条对账（skipped 恒为 0），由 CI 的 Linux 三档代为核对。
  if (process.platform !== 'win32') {
    assert.equal(skippedWindowsOnly, windowsOnly, 'README 声明的「仅 Windows」数量与实际跳过的用例数不符')
  }
})

console.log('')
if (skippedWindowsOnly > 0) {
  console.log('all ' + String(passed) + ' checks passed (' + String(skippedWindowsOnly) + ' skipped: Windows-only)')
} else {
  console.log('all ' + String(passed) + ' checks passed')
}
