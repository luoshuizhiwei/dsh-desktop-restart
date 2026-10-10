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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
/** 跑一个断言块并计数。 */
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log('  ok   ' + name)
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

await ok('守卫：安装记录存在即视为「正在写 profile」', async () => {
  const dir = scratch('install')
  assert.equal(__test.installInProgress(dir).active, false)
  assert.equal(__test.installInProgress(dir).known, true)

  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: 4321 }), 'utf8')
  const busy = __test.installInProgress(dir)
  assert.equal(busy.active, true)
  assert.equal(busy.pid, 4321)
})

await ok('守卫：安装记录损坏时按「有」处理（宁可多问一次）', async () => {
  const dir = scratch('broken')
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
    { known: true, active: true, pid: 99, record: 'x' },
  )
  assert.equal(reasons.length, 2)
  assert.match(reasons[0], /有任务在跑/u)
  assert.match(reasons[0], /2 项正在生成或运行工具/u)
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
  const result = await sweepOrphanSnapshots({
    tempRoot: root,
    startedAtMs: Date.now() + 60_000,
    minAgeMs: 0,
    log: () => {},
  })
  assert.deepEqual(result.removed, [`${SNAPSHOT_PREFIX}doomed`])
  assert.equal(result.failed.length, 0)
  assert.equal(result.bytes, 2048, '应当统计出释放的字节数')
  assert.equal(result.files, 1)
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

await ok('helper：目标映像名不符时拒绝，且不启动任何进程', async () => {
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

await ok('helper：新实例立刻退出时会重试，试完如实认输且不谎报成功', () => {
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

await ok('helper：端口迟迟不放时先清残留，最后才单独结束 host', async () => {
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

await ok('helper：问不出进程表时不当成「主进程已经没了」', async () => {
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

console.log('')
console.log('all ' + String(passed) + ' checks passed')
