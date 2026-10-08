/**
 * dsh-desktop-restart 的离线冒烟测试。
 *
 * 刻意不重启任何东西：
 * - 宿主半用桩上下文加载，只验证路由的守卫与拒绝路径；
 * - helper 只走「映像名不匹配」的拒绝路径，绝不会走到 taskkill / spawn。
 *
 * 运行：node scripts/smoke.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
const helperPath = join(libDir, 'helper.cjs')

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

await ok('helper：新实例立刻退出时会如实记录，不谎报成功', () => {
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
  }), 'utf8')

  const result = spawnSync(process.execPath, [helperPath, handoffPath], { encoding: 'utf8' })
  assert.equal(result.status, 0)

  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /relaunched/u, '应当记录已拉起')
  assert.match(log, /already gone/u, '应当识别出新实例已经退出')
  assert.doesNotMatch(log, /restart complete/u, '不应谎报重启完成')
})

console.log('')
console.log('all ' + String(passed) + ' checks passed')
