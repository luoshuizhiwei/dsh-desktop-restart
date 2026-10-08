/**
 * dsh-desktop-restart 的离线冒烟测试。
 *
 * 刻意不重启任何东西：
 * - 宿主半用桩上下文加载，只验证路由的守卫与拒绝路径；
 * - helper 只走「映像名不匹配」与「拉起来又立刻退出」两条路径，绝不会真的
 *   走到 taskkill 一个真应用，也不弹任何窗口（测试把 alertOnFailure 关掉）；
 * - 守卫的判据（任务快照、安装记录、路径过滤、命令行解析）是纯函数，直接
 *   单测，不依赖本机当前有没有活在跑。
 *
 * 运行：node scripts/smoke.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
const helperPath = join(libDir, 'helper.cjs')

const require = createRequire(import.meta.url)
const helper = require(helperPath)

let passed = 0
/** 跑一个断言块并计数。 */
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log('  ok   ' + name)
}

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

const hostHalf = await import(new URL('../lib/index.js', import.meta.url).href)
hostHalf.apply(ctx, {})

const statusRoute = routes.get('/dsh-desktop-restart/api/status')
const restartRoute = routes.get('/dsh-desktop-restart/api/restart')
const { __test } = hostHalf

await ok('注册了状态与重启两条路由', async () => {
  assert.ok(statusRoute, '缺少状态路由')
  assert.ok(restartRoute, '缺少重启路由')
  assert.equal(routes.size, 2)
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

await ok('守卫：安装记录存在即视为「正在写 profile」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-restart-install-'))
  assert.equal(__test.installInProgress(dir).active, false)
  assert.equal(__test.installInProgress(dir).known, true)

  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: 4321 }), 'utf8')
  const busy = __test.installInProgress(dir)
  assert.equal(busy.active, true)
  assert.equal(busy.pid, 4321)
})

await ok('守卫：安装记录损坏时按「有」处理（宁可多问一次）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-restart-broken-'))
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(join(dir, '.plugin-manager', 'run.json'), '{not json', 'utf8')
  const state = __test.installInProgress(dir)
  assert.equal(state.active, true)
  assert.equal(state.pid, null)
})

await ok('守卫：目录定位不到时静默跳过（known=false）', async () => {
  assert.deepEqual(__test.installInProgress(null), { known: false, active: false, pid: null, record: null })
})

await ok('守卫：profile 目录必须同时有 package.json 与 node_modules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-restart-profile-'))
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
    { known: true, active: true, pid: 99, record: 'x' },
  )
  assert.equal(reasons.length, 2)
  assert.match(reasons[0], /有任务在跑/u)
  assert.match(reasons[0], /2 个回合/u)
  assert.match(reasons[0], /3 个后台任务/u)
  assert.match(reasons[1], /正在安装或更新/u)

  const clean = __test.guardReasons(
    { known: true, active: false, turns: 0, queued: 0, jobs: 0, sessions: 1 },
    { known: true, active: false, pid: null, record: null },
  )
  assert.deepEqual(clean, [])
})

await ok('守卫：只有 force=1 才算「已确认」', async () => {
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart?force=1'), true)
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart?x=1&force=1'), true)
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart?force=0'), false)
  assert.equal(__test.forceRequested('/dsh-desktop-restart/api/restart'), false)
  assert.equal(__test.forceRequested(undefined), false)
})

await ok('守卫：交接目录只保留最近 20 组（handoff + log 一起清）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-restart-prune-'))
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

console.log('client half')

/** 载入 client bundle 顶层，取回它注册的 factory 与插件导出。 */
function loadClientBundle() {
  const loads = []
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  // 只执行 bundle 顶层。它唯一的副作用就是注册 factory —— factory 本体不会运行，
  // 因此这里既不需要真的 react，也不会碰到任何真实环境。
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (spec) => loads.push(spec) } },
  })
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

await ok('helper：目标映像名不符时拒绝，且不启动任何进程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-restart-smoke-'))
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

await ok('helper：新实例立刻退出时会重试，试完如实认输且不谎报成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-restart-relaunch-'))
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

await ok('helper：兜底强杀只认同一个可执行文件', async () => {
  const exe = 'C:\\Program Files\\DSH\\DeepSeek Harness.exe'
  const processes = [
    { pid: 10, path: exe },
    { pid: 11, path: exe.toUpperCase() },
    { pid: 12, path: 'D:\\Other Copy\\DeepSeek Harness.exe' },
    { pid: 13, path: null },
    { pid: 0, path: exe },
    { pid: 'x', path: exe },
  ]
  assert.deepEqual(helper.ownProcessPids(processes, exe), [10, 11])
  assert.deepEqual(helper.ownProcessPids([], exe), [])
  assert.deepEqual(helper.ownProcessPids(null, exe), [])
})

await ok('helper：命令行分词在引号内保留空格', async () => {
  assert.deepEqual(helper.tokenizeCommandLine('a "b c" d'), ['a', 'b c', 'd'])
  assert.deepEqual(helper.tokenizeCommandLine('  a   b  '), ['a', 'b'])
  assert.deepEqual(helper.tokenizeCommandLine('""'), [''])
  assert.deepEqual(helper.tokenizeCommandLine(''), [])
})

console.log('')
console.log('all ' + String(passed) + ' checks passed')
