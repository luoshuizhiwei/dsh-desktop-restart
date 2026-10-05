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

const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
const helperPath = join(libDir, 'helper.cjs')

let passed = 0
/** 跑一个断言块并计数。 */
function ok(name, fn) {
  fn()
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

ok('注册了状态与重启两条路由', () => {
  assert.ok(statusRoute, '缺少状态路由')
  assert.ok(restartRoute, '缺少重启路由')
  assert.equal(routes.size, 2)
})

ok('host 半声明 webServer 依赖', () => {
  assert.deepEqual(hostHalf.inject, ['webServer'])
})

ok('斜杠命令：注册了 /restart-desktop', () => {
  assert.equal(commands.length, 1, '应当恰好注册一个命令')
  assert.equal(commands[0].name, 'restart-desktop')
  assert.ok(commands[0].description.length > 0, '描述不能为空')
  assert.equal(typeof commands[0].handler, 'function')
})

ok('斜杠命令：非桌面宿主下返回 error 结果', () => {
  const result = commands[0].handler({})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /桌面版/u)
})

ok('斜杠命令：命令名符合 DSH 的命名规则', () => {
  assert.match(commands[0].name, /^[a-z][a-z0-9_-]*$/u)
})

ok('状态路由：GET 返回 desktop=false（当前不是桌面宿主）', () => {
  const res = makeRes()
  statusRoute.handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.desktop, false)
  assert.equal(body.enabled, true)
  assert.equal(body.hostPid, process.pid)
})

ok('状态路由：非 GET 返回 405', () => {
  const res = makeRes()
  statusRoute.handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 405)
})

ok('重启路由：非 POST 返回 405', () => {
  const res = makeRes()
  restartRoute.handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

ok('重启路由：非 loopback 来源返回 403', () => {
  const res = makeRes()
  restartRoute.handler(makeReq('POST', { remoteAddress: '10.1.2.3' }), res)
  assert.equal(res.statusCode, 403)
})

ok('重启路由：带 Origin 时以 Origin 为准（回环对端仍是硬前提）', () => {
  const res = makeRes()
  restartRoute.handler(makeReq('POST', { headers: { 'x-forwarded-for': '203.0.113.9' } }), res)
  assert.equal(res.statusCode, 409)
})

ok('重启路由：Origin 与 Host 不一致返回 403', () => {
  const res = makeRes()
  restartRoute.handler(makeReq('POST', { origin: 'http://evil.example' }), res)
  assert.equal(res.statusCode, 403)
})

ok('重启路由：桌面壳转发的无 Origin 请求被放行（走到非桌面判定）', () => {
  const res = makeRes()
  const req = makeReq('POST')
  delete req.headers.origin
  restartRoute.handler(req, res)
  assert.equal(res.statusCode, 409)
})

ok('重启路由：无 Origin 且带转发头返回 403', () => {
  const res = makeRes()
  const req = makeReq('POST', { headers: { 'x-forwarded-for': '203.0.113.9' } })
  delete req.headers.origin
  restartRoute.handler(req, res)
  assert.equal(res.statusCode, 403)
})

ok('重启路由：无 Origin 且 Sec-Fetch-Site 为 cross-site 返回 403', () => {
  const res = makeRes()
  const req = makeReq('POST', { headers: { 'sec-fetch-site': 'cross-site' } })
  delete req.headers.origin
  restartRoute.handler(req, res)
  assert.equal(res.statusCode, 403)
})

ok('重启路由：无 Origin 且 Host 非回环返回 403', () => {
  const res = makeRes()
  const req = makeReq('POST', { host: 'example.com' })
  delete req.headers.origin
  restartRoute.handler(req, res)
  assert.equal(res.statusCode, 403)
})

ok('重启路由：Origin 的 host 与 Host 一致时被放行', () => {
  const res = makeRes()
  restartRoute.handler(makeReq('POST', { origin: 'http://localhost:19387', host: 'localhost:19387' }), res)
  assert.equal(res.statusCode, 409)
})

ok('重启路由：可信但非桌面宿主返回 409 并说明原因', () => {
  const res = makeRes()
  restartRoute.handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.body).error, /桌面版/u)
})

ok('重启路由：config.enabled=false 时返回 403', () => {
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
  disabled.get('/dsh-desktop-restart/api/restart').handler(makeReq('POST'), res)
  assert.equal(res.statusCode, 403)
  assert.match(JSON.parse(res.body).error, /enabled/u)
})

console.log('helper')

ok('helper：缺参数时以退出码 1 结束', () => {
  const result = spawnSync(process.execPath, [helperPath], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

ok('helper：handoff 文件不存在时以退出码 1 结束', () => {
  const result = spawnSync(process.execPath, [helperPath, join(tmpdir(), 'dsh-desktop-restart-missing.json')], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})

ok('helper：目标映像名不符时拒绝，且不启动任何进程', () => {
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

console.log('')
console.log('all ' + String(passed) + ' checks passed')
