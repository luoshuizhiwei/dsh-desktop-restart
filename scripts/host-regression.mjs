import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as nativeFs from 'node:fs'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import * as vm from 'node:vm'
import * as path from 'node:path'
import * as url from 'node:url'
import { processIdentityState, createNoticeStore } from '../lib/helper.cjs'
import { assertV4MessageSource } from './fixtures/session-v4-source.mjs'

const sourcePath = new URL('../lib/index.js', import.meta.url)
const code = readFileSync(sourcePath, 'utf8')
// 0.4.4 宿主（git HEAD）快照：真机上「双击确认 == 立即重启」事故的原始代码。
// R0 用它在 VM 里复现 409 → warn → force 的完整成因链，证明缺陷不是推测。
const code044 = readFileSync(new URL('./fixtures/host-044-index.mjs', import.meta.url), 'utf8')
const home = 'E:\\virtual-dsh'
const profileDir = `${home}\\profiles\\desktop`
const profileId = createHash('sha256').update(profileDir.replaceAll('\\', '/').toLowerCase()).digest('hex')
const exe = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
const instanceId = createHash('sha256').update(`${profileId}\0${exe.replaceAll('\\', '/').toLowerCase()}`).digest('hex')
const stateDir = `${home}\\desktop-restart`
const profileSettingsPath = `${stateDir}\\settings-${profileId}.json`
const markerPath = `${stateDir}\\last-restart-${profileId}.json`
const resumeMode = 'wake'
const files = new Map([[`${stateDir}\\settings.json`, JSON.stringify({ resume: resumeMode })]])
const directories = new Set([profileDir, `${profileDir}\\node_modules`])
files.set(`${profileDir}\\package.json`, '{}')
let failSettingsWrites = false
let failOpWrites = false
let fakeSpawnCalls = 0
let nextFd = 1
const descriptors = new Map()

const makeMarker = (restartId = 'restart-once', sessions = ['session-private-id']) => ({
  schema: 1, status: 'pending', profileId, instanceId, restartId,
  requestedAt: new Date(Date.now() - 1000).toISOString(), sessions,
})

async function boot({ hostCode = code, noticeFactory = createNoticeStore, noticeOptions = {}, fsOverride = null, sweepImpl = null, profile = profileDir, restartId = 'restart-once', authThrows = false, deferredImports = null, sweepResult = { scanned: 0, candidates: [], preview: { files: 0, bytes: 0 }, skipped: [], partial: false, prefiltered: 0, removed: [], failed: [], error: null }, processList = [], processQueryFails = false, clock = Date, delivery = null, wakeAvailable = true, commandsEnabled = false, agentsList = () => [], knownTasks = true, fakeHelper = false, spawnError = null, deadLockPid = null, entryConfig = {} } = {}) {
  let processQueryCalls = 0
  let spawned = 0
  const timers = []
  const deliveries = []
  const disposers = [()=>{ const lock=files.get(stateDir+"\\restart.lock"); if(lock && [200,901].includes(JSON.parse(lock).pid)) files.delete(stateDir+"\\restart.lock") }]
  const routes = new Map()
  const commands = new Map()
  const submit = (mode, message) => {
    assertV4MessageSource(message)
    if (delivery !== null) return delivery(mode, message, deliveries)
    deliveries.push({ mode, message })
  }
  const agent = {
    ...(wakeAvailable ? { followup: (message) => submit('wake', message) } : {}),
    inject: (message) => submit('notice', message),
  }
  const context = vm.createContext({
    console, URL, Date: clock, Number, String, Object, Array, Promise, Buffer,
    process: {
      env: {
        DSH_HOME: home, DSH_PROFILE_DIR: profile, DSH_DESKTOP_RESTART_ID: restartId,
        ELECTRON_RUN_AS_NODE: '1',
      },
      pid: 200, ppid: 100, execPath: exe, platform: 'win32', argv: [], uptime: () => 10,
      kill(_pid, signal) { if (_pid === deadLockPid) { const e=new Error('gone');e.code='ESRCH';throw e }; if (!fakeHelper || signal !== 0) throw new Error('fixture permits only fake liveness queries') },
    },
    setTimeout(fn, ms) { const timer = { fn, ms, at: clock.now() + ms, cancelled: false, unref() {} }; timers.push(timer); if (fakeHelper && spawned > 0 && ms === 300) queueMicrotask(() => { timer.cancelled = true; fn() }); return timer },
    clearTimeout(timer) { timer.cancelled = true },
  })
  const makeModule = async (data) => {
    const mod = new vm.SyntheticModule(Object.keys(data), function () {
      for (const [key, value] of Object.entries(data)) this.setExport(key, value)
    }, { context })
    await mod.link(() => {})
    await mod.evaluate()
    return mod
  }
  const fsFake = {
    readFileSync(file) {
      const key = String(file)
      if (key.endsWith('package.json')) return '{"version":"0.4.5"}'
      if (!files.has(key)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error }
      return files.get(key)
    },
    existsSync: (file) => directories.has(String(file)) || files.has(String(file)),
    mkdirSync() {},
    readdirSync: dir => [...files.keys()].filter(file => path.win32.dirname(file) === String(dir)).map(file => path.win32.basename(file)),
    statSync(file) { if (directories.has(String(file)) || String(file) === stateDir) return { isDirectory: () => true, mtimeMs:files.size,ctimeMs:files.size,size:0 }; if(files.has(String(file))) return {isDirectory:()=>false,mtimeMs:parseInt(createHash('sha256').update(files.get(String(file))).digest('hex').slice(0,12),16),size:Buffer.byteLength(files.get(String(file)))}; const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error },
    unlinkSync(file) { files.delete(String(file)) },
    openSync(file, flag) {
      if (flag === 'wx' && files.has(String(file))) { const error = new Error('EEXIST'); error.code = 'EEXIST'; throw error }
      const fd = nextFd++
      descriptors.set(fd, String(file))
      files.set(String(file), '')
      return fd
    },
    closeSync() {},
    writeFileSync(fileOrFd, text, options) {
      if (options?.flag === 'wx' && files.has(String(fileOrFd))) { const error = new Error('EEXIST'); error.code = 'EEXIST'; throw error }
      if (failSettingsWrites && /settings(?:-[a-f0-9]+)?\.json\./u.test(String(fileOrFd))) throw new Error('simulated disk full')
      if (failOpWrites && String(fileOrFd).includes('\\op-')) throw new Error('simulated operation-state disk failure')
      const file = typeof fileOrFd === 'number' ? descriptors.get(fileOrFd) : String(fileOrFd)
      files.set(file, String(text))
    },
    renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)) },
  }
  const pathApi = Object.fromEntries(['basename', 'dirname', 'join'].map((name) => [name, path.win32[name]]))
  const nodeModules = {
    'node:child_process': { spawn() { fakeSpawnCalls += 1; spawned += 1; if (fakeHelper) { const child=new EventEmitter();child.pid=spawnError?undefined:901;child.unref=()=>{};queueMicrotask(()=>spawnError?child.emit('error',Object.assign(new Error('fixture spawn denied'),{code:spawnError})):child.emit('spawn'));return child }; throw new Error('real process creation forbidden') } },
    'node:crypto': { createHash, randomUUID: () => `generated-${Math.random()}` },
    'node:fs': fsOverride ?? fsFake,
    'node:os': { homedir: () => home, tmpdir: () => `${home}\\Temp` },
    'node:path': pathApi,
    'node:url': { fileURLToPath: url.fileURLToPath },
    './sweep.js': { MIN_ORPHAN_AGE_MS: 86400000, sweepOrphanSnapshots: options => sweepImpl ? sweepImpl(options) : Promise.resolve(sweepResult) },
    './helper.cjs': {
      queryApplicationProcesses: () => { processQueryCalls += 1; return processQueryFails ? null : processList },
      processIdentityState,
      createNoticeStore: options => noticeFactory({...options, ...noticeOptions, send: () => ({status:'failed',code:'notifications-disabled'})}),
    },
  }
  const module = new vm.SourceTextModule(hostCode, {
    context,
    identifier: sourcePath.href,
    initializeImportMeta(meta) { meta.url = sourcePath.href },
    importModuleDynamically: async (specifier) => {
      if (deferredImports !== null) {
        deferredImports.enter()
        await deferredImports.promise
      }
      if (specifier === '@deepseek-ai/dsh-llm') return makeModule({ createUserMessage: (input) => input })
      if (specifier === '@deepseek-ai/dsh-session') return makeModule({ SessionId: (id) => id })
      throw new Error(`unexpected dynamic import ${specifier}`)
    },
  })
  await module.link(async (specifier) => makeModule(nodeModules[specifier]))
  await module.evaluate()
  const ctx = {
    get(name) {
      if (name === 'agents' && knownTasks) return { get: () => agent, list: agentsList }
      if (name === 'jobs' && knownTasks) return { list: () => [] }
      if (name === 'connection' && authThrows) throw new Error('simulated connection failure')
      return undefined
    },
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject(services, callback) {
      if (commandsEnabled && services.includes('commands')) callback({
        ...ctx,
        commands: { register(spec) { commands.set(spec.name, spec); return () => commands.delete(spec.name) } },
      })
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    webServer: { port: 19387, register(spec) { routes.set(spec.path, spec); return () => routes.delete(spec.path) } },
  }
  module.namespace.apply(ctx, { sweep: false, command: commandsEnabled, platformAuth: authThrows, ...entryConfig })
  const request = async (route, method, urlPath) => {
    let body
    const req = {
      method, url: urlPath,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
    }
    const res = { writeHead(status) { this.status = status }, end(value) { if (value) body = JSON.parse(value) } }
    await routes.get(route).handler(req, res)
    return { status: res.status, body }
  }
  return { module, timers, deliveries, disposers, routes, commands, request, queryCount: () => processQueryCalls, spawnCount: () => spawned }
}

/**
 * 0.4.4 宿主（git HEAD 快照）的最小 boot：只保留 R0 复现所需的桩。
 * 与 {@link boot} 的差别：0.4.4 不 import ./helper.cjs、不用 notice store、
 * marker 是 last-restart.json（按 pid 认重启）、settings 直接写 settings.json。
 */
async function boot044({ agentsList = () => [{ id: 'fixture-running', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] } = {}) {
  const timers = []
  const disposers = [()=>{ const lock=files.get(stateDir+"\\restart.lock"); if(lock && [200,901].includes(JSON.parse(lock).pid)) files.delete(stateDir+"\\restart.lock") }]
  const routes = new Map()
  const commands = new Map()
  const context = vm.createContext({
    console, URL, Date, Number, String, Object, Array, Promise, Buffer,
    process: {
      env: { DSH_HOME: home, DSH_PROFILE_DIR: profileDir, ELECTRON_RUN_AS_NODE: '1' },
      pid: 200, ppid: 100, execPath: exe, platform: 'win32', argv: [], uptime: () => 10,
      kill(_pid, signal) { if (signal !== 0) throw new Error('fixture permits only liveness queries') },
    },
    setTimeout(fn, ms) { const timer = { fn, ms, at: Date.now() + ms, cancelled: false, unref() {} }; timers.push(timer); return timer },
    clearTimeout(timer) { timer.cancelled = true },
  })
  const fsFake = {
    readFileSync(file) {
      const key = String(file)
      if (key.endsWith('package.json')) return '{"version":"0.4.4"}'
      if (!files.has(key)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error }
      return files.get(key)
    },
    existsSync: (file) => directories.has(String(file)) || files.has(String(file)),
    mkdirSync() {},
    readdirSync: dir => [...files.keys()].filter(file => path.win32.dirname(file) === String(dir)).map(file => path.win32.basename(file)),
    statSync(file) { if (directories.has(String(file)) || String(file) === stateDir) return { isDirectory: () => true, mtimeMs: files.size, ctimeMs: files.size, size: 0 }; if (files.has(String(file))) return { isDirectory: () => false, mtimeMs: 0, size: 0 }; const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error },
    unlinkSync(file) { files.delete(String(file)) },
    writeFileSync(file, text) { files.set(String(file), String(text)) },
    renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)) },
  }
  let spawned = 0
  const nodeModules = {
    'node:child_process': { spawn() { spawned += 1; return { pid: 901, unref() {} } } },
    'node:fs': fsFake,
    'node:os': { homedir: () => home, tmpdir: () => `${home}\\Temp` },
    'node:path': Object.fromEntries(['basename', 'dirname', 'join'].map((name) => [name, path.win32[name]])),
    'node:url': { fileURLToPath: url.fileURLToPath },
    './sweep.js': { MIN_ORPHAN_AGE_MS: 86400000, sweepOrphanSnapshots: () => Promise.resolve({ scanned: 0, candidates: [], preview: { bytes: 0, files: 0 }, removed: [], failed: [], skipped: [], partial: false }) },
  }
  const module = new vm.SourceTextModule(code044, {
    context,
    identifier: 'host-044-index.mjs',
    initializeImportMeta(meta) { meta.url = new URL('./fixtures/host-044-index.mjs', import.meta.url).href },
    importModuleDynamically: async () => { throw new Error('0.4.4 fixture forbids dynamic imports') },
  })
  await module.link(async (specifier) => {
    const stub = nodeModules[specifier]
    if (stub === undefined) throw new Error(`0.4.4 fixture has no stub for ${specifier}`)
    const mod = new vm.SyntheticModule(Object.keys(stub), function () {
      for (const [key, value] of Object.entries(stub)) this.setExport(key, value)
    }, { context })
    await mod.link(() => {})
    await mod.evaluate()
    return mod
  })
  await module.evaluate()
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => ({}), list: agentsList }
      if (name === 'jobs') return { list: () => [] }
      return undefined
    },
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject(services, callback) {
      if (services.includes('commands')) callback({ ...ctx, commands: { register(spec) { commands.set(spec.name, spec); return () => commands.delete(spec.name) } } })
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    webServer: { port: 19387, register(spec) { routes.set(spec.path, spec); return () => routes.delete(spec.path) } },
  }
  module.namespace.apply(ctx, { sweep: false, command: true })
  const request = async (route, method, urlPath) => {
    let body
    const req = { method, url: urlPath, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }
    const res = { writeHead(status) { this.status = status }, end(value) { if (value) body = JSON.parse(value) } }
    await routes.get(route).handler(req, res)
    return { status: res.status, body }
  }
  return { timers, disposers, routes, commands, request, spawnCount: () => spawned }
}

const results = []
assert.throws(() => assertV4MessageSource({ source: { kind: 'plugin', plugin: 'dsh-desktop-restart' } }), /producer-owned source kind/u)
const markerWithoutSessions = makeMarker('marker-without-sessions')
delete markerWithoutSessions.sessions
files.set(markerPath, JSON.stringify(markerWithoutSessions))
const legacyShape = await boot({ restartId: 'marker-without-sessions' })
const legacyStatus = await legacyShape.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(legacyStatus.status, 200, '标记里没有 sessions 时状态接口不能 400')
assert.ok(legacyStatus.body.lastRestart, '回执仍要给出')
assert.equal(Object.hasOwn(legacyStatus.body.lastRestart, 'sessions'), false, '回执不再包含 sessions')
results.push({ case: 'status-tolerates-marker-without-sessions', passed: true })

const noResume = await boot({ restartId: 'no-resume-removed' })
const noResumeStatus = await noResume.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(Object.hasOwn(noResumeStatus.body, 'resume'), false, '续跑已移除：状态里不应再有 resume 字段')
assert.equal(Object.hasOwn(noResumeStatus.body, 'resumeStatus'), false, '续跑已移除：状态里不应再有 resumeStatus 字段')
assert.equal(noResume.deliveries.length, 0, '续跑已移除：不应有任何投递')
results.push({ case: 'resume-feature-absent', passed: true })

const scanError = await boot({ restartId: 'scan-error', sweepResult: {
  scanned: 12, candidates: [], preview: { files: 0, bytes: 0 }, skipped: [], partial: true,
  prefiltered: 7, removed: [], failed: [], error: { code: 'EACCES' },
} })
const scanErrorResponse = await scanError.request('/dsh-desktop-restart/api/prefs', 'POST', '/dsh-desktop-restart/api/prefs?run=1')
assert.equal(scanErrorResponse.body.last.error.code, 'EACCES')
assert.equal(scanErrorResponse.body.last.partial, true)
assert.equal(scanErrorResponse.body.last.prefiltered, 7)
results.push({ case: 'scan-api-preserves-error-partial-prefiltered', passed: true })

const scanEmpty = await boot({ restartId: 'scan-empty' })
const scanEmptyResponse = await scanEmpty.request('/dsh-desktop-restart/api/prefs', 'POST', '/dsh-desktop-restart/api/prefs?run=1')
assert.equal(scanEmptyResponse.body.last.error, null)
assert.equal(scanEmptyResponse.body.last.partial, false)
assert.equal(scanEmptyResponse.body.last.scanned, 0)
results.push({ case: 'scan-api-preserves-normal-empty-result', passed: true })

const missingRestart = await boot({ restartId: 'missing-operation' })
const missingStatus = await missingRestart.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(missingStatus.body.restartOp.result, 'unknown')
assert.equal(missingStatus.body.restartOp.busy, true)
assert.equal(missingStatus.body.restartOp.helperAlive, null)
assert.equal(missingStatus.body.restartOp.helperVerified, false)
assert.equal(missingStatus.body.restartOp.needsManualCheck, true)
const missingDuplicate = await missingRestart.request('/dsh-desktop-restart/api/restart', 'POST', '/dsh-desktop-restart/api/restart')
assert.equal(missingDuplicate.status, 409)
const missingClear = await missingRestart.request('/dsh-desktop-restart/api/prefs', 'POST', '/dsh-desktop-restart/api/prefs?clearOp=1')
assert.equal(missingClear.status, 409)
assert.equal(missingClear.body.cleared, false)
results.push({ case: 'missing-op-remains-locked-and-cannot-be-cleared', passed: true })

const reusedPidId = 'reused-helper-pid'
const reusedIdentity = { pid: 777, parentPid: 200, path: exe, commandLine: 'helper.cjs', createdAt: '2026-10-22T00:00:00.000Z' }
files.set(missingRestart.module.namespace.__test.opFileOf(reusedPidId), JSON.stringify({
  id: reusedPidId, schema: 1, phase: 'unknown', result: 'unknown', pid: reusedIdentity.pid,
  hostPid: reusedIdentity.parentPid, helperIdentity: reusedIdentity, helperVerified: true,
  startedAt: new Date().toISOString(), stages: {},
}))
const reusedPid = await boot({ restartId: reusedPidId, processList: [{ ...reusedIdentity, createdAt: '2026-10-22T00:01:00.000Z' }] })
const reusedStatus = await reusedPid.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(reusedStatus.body.restartOp.helperAlive, false)
assert.equal(reusedStatus.body.restartOp.helperVerified, true)
assert.equal(reusedStatus.body.restartOp.busy, false)
results.push({ case: 'reused-pid-is-verified-as-original-helper-exited', passed: true })

const exitedPendingId = 'exited-pending-helper'
files.set(missingRestart.module.namespace.__test.opFileOf(exitedPendingId), JSON.stringify({
  id: exitedPendingId, schema: 1, phase: 'verify', result: 'pending', pid: reusedIdentity.pid,
  hostPid: reusedIdentity.parentPid, helperIdentity: reusedIdentity, helperVerified: true,
  startedAt: new Date().toISOString(), stages: {},
}))
const exitedPending = await boot({ restartId: exitedPendingId, processList: [{ ...reusedIdentity, createdAt: '2026-10-22T00:01:00.000Z' }] })
const exitedPendingStatus = await exitedPending.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(exitedPendingStatus.body.restartOp.result, 'unknown')
assert.equal(exitedPendingStatus.body.restartOp.reason, 'helper-exited')
assert.equal(exitedPendingStatus.body.restartOp.busy, false)
assert.equal(exitedPendingStatus.body.restartOp.needsManualCheck, true)
results.push({ case: 'verified-helper-exit-releases-pending-operation-as-unknown', passed: true })

const invalidIdentityId = 'invalid-helper-created-at'
const invalidIdentity = { ...reusedIdentity, pid: 781, createdAt: 'not-a-date' }
files.set(missingRestart.module.namespace.__test.opFileOf(invalidIdentityId), JSON.stringify({
  id: invalidIdentityId, schema: 1, phase: 'unknown', result: 'unknown', pid: invalidIdentity.pid,
  hostPid: invalidIdentity.parentPid, helperIdentity: invalidIdentity, helperVerified: true,
  startedAt: new Date().toISOString(), stages: {},
}))
const invalidIdentityHost = await boot({ restartId: invalidIdentityId, processList: [] })
const invalidIdentityStatus = await invalidIdentityHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(invalidIdentityStatus.body.restartOp.helperAlive, null)
assert.equal(invalidIdentityStatus.body.restartOp.helperVerified, false)
assert.equal(invalidIdentityStatus.body.restartOp.busy, true)
results.push({ case: 'invalid-helper-created-at-cannot-prove-exit', passed: true })

const missingParentId = 'missing-helper-parent-identity'
const missingParentIdentity = { pid: 782, parentPid: undefined, path: exe, createdAt: new Date().toISOString() }
files.set(missingRestart.module.namespace.__test.opFileOf(missingParentId), JSON.stringify({
  id: missingParentId, schema: 1, phase: 'unknown', result: 'unknown', pid: missingParentIdentity.pid,
  hostPid: undefined, helperIdentity: missingParentIdentity, helperVerified: true,
  startedAt: new Date().toISOString(), stages: {},
}))
const missingParentHost = await boot({ restartId: missingParentId, processList: [] })
const missingParentStatus = await missingParentHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(missingParentStatus.body.restartOp.helperAlive, null)
assert.equal(missingParentStatus.body.restartOp.helperVerified, false)
assert.equal(missingParentStatus.body.restartOp.busy, true)
results.push({ case: 'missing-helper-parent-identity-cannot-prove-exit', passed: true })

const incompleteActualId = 'incomplete-current-helper-row'
const incompleteActualIdentity = { ...reusedIdentity, pid: 783 }
files.set(missingRestart.module.namespace.__test.opFileOf(incompleteActualId), JSON.stringify({
  id: incompleteActualId, schema: 1, phase: 'unknown', result: 'unknown', pid: incompleteActualIdentity.pid,
  hostPid: incompleteActualIdentity.parentPid, helperIdentity: incompleteActualIdentity, helperVerified: true,
  startedAt: new Date().toISOString(), stages: {},
}))
const incompleteActual = await boot({ restartId: incompleteActualId, processList: [{ ...incompleteActualIdentity, path: null }] })
const incompleteActualStatus = await incompleteActual.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(incompleteActualStatus.body.restartOp.helperAlive, null)
assert.equal(incompleteActualStatus.body.restartOp.helperVerified, false)
assert.equal(incompleteActualStatus.body.restartOp.busy, true)
results.push({ case: 'incomplete-actual-cim-identity-cannot-prove-exit', passed: true })

const queryFailId = 'helper-query-failure'
const queryFailIdentity = { ...reusedIdentity, pid: 778, createdAt: '2026-10-22T00:00:00.000Z' }
files.set(missingRestart.module.namespace.__test.opFileOf(queryFailId), JSON.stringify({
  id: queryFailId, schema: 1, phase: 'verify', result: 'pending', pid: queryFailIdentity.pid,
  hostPid: queryFailIdentity.parentPid, helperIdentity: queryFailIdentity, helperVerified: true,
  startedAt: new Date(Date.now() - 300000).toISOString(), stages: {},
}))
const queryFail = await boot({ restartId: queryFailId, processQueryFails: true })
const queryFailStatus = await queryFail.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(queryFailStatus.body.restartOp.result, 'unknown')
assert.equal(queryFailStatus.body.restartOp.helperAlive, null)
assert.equal(queryFailStatus.body.restartOp.helperVerified, false)
assert.equal(queryFailStatus.body.restartOp.busy, true)
results.push({ case: 'cim-query-failure-keeps-operation-locked-as-unknown', passed: true })

const liveId = 'verified-live-helper'
const liveIdentity = { ...reusedIdentity, pid: 779 }
files.set(missingRestart.module.namespace.__test.opFileOf(liveId), JSON.stringify({
  id: liveId, schema: 1, phase: 'verify', result: 'pending', pid: liveIdentity.pid,
  hostPid: liveIdentity.parentPid, helperIdentity: liveIdentity, helperVerified: true,
  startedAt: new Date().toISOString(), stages: {},
}))
const liveHelper = await boot({ restartId: liveId, processList: [liveIdentity] })
const liveStatus = await liveHelper.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(liveStatus.body.restartOp.helperAlive, true)
assert.equal(liveStatus.body.restartOp.helperVerified, true)
assert.equal(liveStatus.body.restartOp.busy, true)
assert.equal((await liveHelper.request('/dsh-desktop-restart/api/restart', 'POST', '/dsh-desktop-restart/api/restart')).status, 409)
results.push({ case: 'verified-live-helper-blocks-duplicate-restart', passed: true })

const terminalId = 'verified-terminal'
files.set(missingRestart.module.namespace.__test.opFileOf(terminalId), JSON.stringify({
  id: terminalId, schema: 1, phase: 'done', result: 'ok', pid: 780,
  hostPid: 200, helperVerified: true, startedAt: new Date().toISOString(), stages: {},
}))
const terminal = await boot({ restartId: terminalId })
const terminalStatus = await terminal.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(terminalStatus.body.restartOp.result, 'ok')
assert.equal(terminalStatus.body.restartOp.busy, false)
results.push({ case: 'terminal-result-is-not-busy', passed: true })

const noOpRecord = await boot({ restartId: null })
fakeSpawnCalls = 0
failOpWrites = true
const opWriteFailed = await noOpRecord.request('/dsh-desktop-restart/api/restart', 'POST', '/dsh-desktop-restart/api/restart')
failOpWrites = false
assert.equal(opWriteFailed.status, 500)
assert.equal(opWriteFailed.body.error, '无法保存重启操作记录，未启动辅助进程')
assert.equal(fakeSpawnCalls, 0)
results.push({ case: 'initial-operation-write-failure-prevents-helper-spawn', passed: true })

const busyContract = await boot({ restartId: 'missing-record-busy-contract' })
const busyResponse = await busyContract.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(busyResponse.body.restartBusy, true)
assert.equal(busyResponse.body.restartBusy, busyResponse.body.restartOp.busy)
const idleContract = await boot({ restartId: null })
const idleResponse = await idleContract.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(idleResponse.body.restartBusy, false)
assert.equal(idleResponse.body.restartOp, null)
assert.equal((await terminal.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')).body.restartBusy, false)
results.push({ case: 'status-top-level-busy-matches-the-operation-or-idle-state', passed: true })

let fixtureNow = Date.now()
class FixtureDate extends Date {
  constructor(value) { super(value === undefined ? fixtureNow : value) }
  static now() { return fixtureNow }
}
const cacheId = 'helper-cache-across-ui-polls'
const cachedProcesses = [liveIdentity]
files.set(missingRestart.module.namespace.__test.opFileOf(cacheId), JSON.stringify({
  id: cacheId, schema: 1, phase: 'verify', result: 'pending', pid: liveIdentity.pid,
  hostPid: liveIdentity.parentPid, helperIdentity: liveIdentity,
  startedAt: new Date(fixtureNow).toISOString(), stages: {},
}))
const cachedHost = await boot({ restartId: cacheId, processList: cachedProcesses, clock: FixtureDate })
await cachedHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
fixtureNow += 2000
cachedProcesses.length = 0
const cachedResponse = await cachedHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(cachedHost.queryCount(), 1, 'one UI poll reuses the verified identity result')
assert.equal(cachedResponse.body.restartBusy, true, 'a cached live helper cannot release the lock')
fixtureNow += 1001
const freshResponse = await cachedHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(cachedHost.queryCount(), 2, 'identity is queried again after the short cache expires')
assert.equal(freshResponse.body.restartBusy, false, 'fresh proof of helper exit permits retry')
results.push({ case: 'identity-cache-spans-a-ui-poll-and-refreshes-after-three-seconds', passed: true })

const deadlineId = 'helper-cache-operation-deadline'
files.set(missingRestart.module.namespace.__test.opFileOf(deadlineId), JSON.stringify({
  id: deadlineId, schema: 1, phase: 'verify', result: 'pending', pid: liveIdentity.pid,
  hostPid: liveIdentity.parentPid, helperIdentity: liveIdentity,
  startedAt: new Date(fixtureNow - 238000).toISOString(), stages: {},
}))
const deadlineHost = await boot({ restartId: deadlineId, processList: [liveIdentity], clock: FixtureDate })
await deadlineHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
fixtureNow += 2001
const deadlineResponse = await deadlineHost.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
assert.equal(deadlineHost.queryCount(), 2, 'the cache never extends across the operation deadline')
assert.equal(deadlineResponse.body.restartOp.result, 'unknown')
assert.equal(deadlineResponse.body.restartBusy, true, 'timeout still cannot release a verified live helper')
results.push({ case: 'identity-cache-does-not-reuse-evidence-beyond-operation-deadline', passed: true })


{
  let now = Date.now()
  class WaitingClock extends Date {
    constructor(value) { super(value === undefined ? now : value) }
    static now() { return now }
  }
  const host = await boot({ restartId: null, clock: WaitingClock, commandsEnabled: true,
    agentsList: () => [{ id: 'fixture-running', status: 'running', inbox: { nextTurn: [], nextStep: [] } }],
  })
  const command = host.commands.get('restart-desktop')
  const statusPath = '/dsh-desktop-restart/api/status'
  const first = await command.handler({ rawInput: '/restart-desktop' })
  const firstStatus = await host.request(statusPath, 'GET', statusPath)
  const originalSince = firstStatus.body.waiting.since
  assert.equal(first.kind, 'success', 'a single command submits a normal waiting request')
  now += 60_000
  const repeated = await command.handler({ rawInput: '/restart-desktop' })
  const repeatedStatus = await host.request(statusPath, 'GET', statusPath)
  console.log(JSON.stringify({ case: 'F4', originalSince, repeatedSince: repeatedStatus.body.waiting.since, repeatedText: repeated.text }))
  assert.equal(repeatedStatus.body.waiting.since, originalSince, 'F4: repeating a normal command must preserve the original deadline')
  assert.doesNotMatch(first.text + repeated.text, /再次执行.*取消/u, 'F4: do not promise command-based cancellation')
  await host.request('/dsh-desktop-restart/api/restart', 'POST', '/dsh-desktop-restart/api/restart?wait=1')
  assert.equal((await host.request(statusPath, 'GET', statusPath)).body.waiting.since, originalSince, 'graphical normal requests share the original deadline')
  const active = host.timers.filter(timer => timer.ms === 5000 && !timer.cancelled)
  assert.equal(active.length, 1, 'repeated requests retain one host waiting timer')
  now = Date.parse(originalSince) + 1_800_001
  active[0].fn()
  assert.equal((await host.request(statusPath, 'GET', statusPath)).body.waiting, null, 'the original deadline still cancels the waiting request')
  for (const dispose of host.disposers) dispose()
  results.push({ case: 'F4-repeated-normal-command-keeps-original-deadline-and-truthful-copy', passed: true })
}

const settle4a = async () => { await new Promise(resolve => setImmediate(resolve)) }
async function requestFixture4a({ known = true, sweepImpl = null } = {}) {
  files.delete(stateDir+"\\restart.lock") // Prior isolated fixture helper has ended.
  let now = Date.now()
  let active = false
  class RequestClock extends Date { constructor(value) { super(value === undefined ? now : value) } static now() { return now } }
  files.set(profileSettingsPath, JSON.stringify({ countdown: 0 }))
  files.delete(`${profileDir}\\.plugin-manager\\run.json`)
  const host = await boot({ restartId: null, clock: RequestClock, knownTasks: known, fakeHelper: true, sweepImpl,
    agentsList: () => active ? [{ id: 'busy-fixture', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] : [],
  })
  const advance = async ms => {
    const until = now + ms
    while (true) {
      await settle4a()
      const next = host.timers.filter(timer => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.cancelled = true
      next.fn()
    }
    now = until
    await settle4a()
  }
  return { ...host, advance, clockNow: () => now, jump: ms => { now += ms }, setBusy: value => { active = value },
    setInstalling(value) { const path = `${profileDir}\\.plugin-manager\\run.json`; if (value) files.set(path, JSON.stringify({ pid: 987, grouped: false })); else files.delete(path) },
    status: async () => (await host.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')).body,
    post: query => host.request('/dsh-desktop-restart/api/restart', 'POST', '/dsh-desktop-restart/api/restart' + (query ? '?' + query : '')),
    prefs: query => host.request('/dsh-desktop-restart/api/prefs', 'POST', '/dsh-desktop-restart/api/prefs?' + query),
  }
}
async function pausedFixture4a() {
  const host = await requestFixture4a()
  await host.prefs('countdown=5')
  await host.post('wait=1')
  await host.advance(1000)
  host.setBusy(true)
  await host.advance(1000)
  assert.equal((await host.status()).restartRequest?.state, 'paused', 'new work during countdown must pause')
  return host
}
const cases4a = [
  ['1', 'idle countdown zero immediately executes; unknown task state waits', async () => {
    const host = await requestFixture4a()
    const pending = host.post('wait=1')
    await settle4a()
    assert.equal((await host.status()).restartRequest?.state, 'executing')
    assert.equal(host.spawnCount(), 1)
    await host.advance(500)
    assert.equal((await pending).status, 202)
    const operation = (await host.status()).restartOp
    const operationPath = host.module.namespace.__test.opFileOf(operation.id)
    const record = JSON.parse(files.get(operationPath))
    files.set(operationPath, JSON.stringify({ ...record, result: 'ok', phase: 'done' }))
    const terminal = await host.status()
    assert.equal(terminal.restartRequest.state, 'terminal', 'the current request mirrors the operation terminal result')
    assert.equal(terminal.restartRequest.reason, 'ok')
    assert.equal(terminal.restartBusy, false)
    const unknown = await requestFixture4a({ known: false })
    await unknown.post('wait=1')
    await unknown.advance(60_000)
    assert.equal((await unknown.status()).restartRequest.state, 'waiting')
    assert.equal(unknown.spawnCount(), 0)
  }],
  ['2', 'five-second countdown and immutable request settings snapshot', async () => {
    const host = await requestFixture4a()
    await host.prefs('countdown=5')
    await host.post('wait=1')
    let state = (await host.status()).restartRequest
    assert.equal(state?.state, 'countdown')
    assert.equal(state.countdownRemainingMs, 5000)
    await host.prefs('countdown=0')
    await host.advance(4999)
    assert.equal(host.spawnCount(), 0)
    assert.equal((await host.status()).restartRequest.countdownRemainingMs, 1)
    await host.advance(1)
    assert.equal(host.spawnCount(), 1)
    assert.equal((await host.status()).restartRequest.state, 'executing')
  }],
  ['3', 'new work pauses once with one stable ask identifier', async () => {
    const host = await pausedFixture4a()
    const request = (await host.status()).restartRequest
    assert.ok(request.ask)
    assert.ok(request.pausedReason)
    await host.advance(20_000)
    assert.equal((await host.status()).restartRequest.ask, request.ask)
    assert.equal(host.spawnCount(), 0)
  }],
  ['4', 'unanswered pause never executes even after work becomes idle', async () => {
    const host = await pausedFixture4a()
    host.setBusy(false)
    await host.advance(15 * 60_000)
    assert.equal((await host.status()).restartRequest.state, 'paused')
    assert.equal(host.spawnCount(), 0)
  }],
  ['5', 'continue waits and restarts the full captured countdown without extending deadline', async () => {
    const host = await pausedFixture4a()
    const paused = (await host.status()).restartRequest
    await host.prefs('countdown=9')
    await host.post('choice=wait&ask=' + encodeURIComponent(paused.ask))
    assert.equal((await host.status()).restartRequest.state, 'waiting')
    host.setBusy(false)
    await host.advance(5000)
    const countdown = (await host.status()).restartRequest
    assert.equal(countdown.state, 'countdown')
    assert.equal(countdown.countdownRemainingMs, 5000)
    assert.equal(countdown.deadlineAt, paused.deadlineAt)
    await host.advance(4999)
    assert.equal(host.spawnCount(), 0)
    await host.advance(1)
    assert.equal(host.spawnCount(), 1)
  }],
  ['6', 'immediate restart rejects live installation and keeps the request paused', async () => {
    const host = await pausedFixture4a()
    host.setInstalling(true)
    const refusal = await host.post('choice=now')
    assert.equal(refusal.status, 409)
    assert.equal(refusal.body.blocked, true)
    assert.equal(host.spawnCount(), 0)
    assert.equal((await host.status()).restartRequest.state, 'paused')
    host.setInstalling(false)
    const accepted = host.post('choice=now')
    await settle4a()
    assert.equal((await host.status()).restartRequest.state, 'executing')
    assert.equal(host.spawnCount(), 1)
    assert.equal((await host.post('cancelWait=1')).body.cancelled, false, 'execution is irrevocable')
    await host.advance(500)
    await accepted
  }],
  ['7', 'deadline cancels all pre-execution states and explicitly reports not executed', async () => {
    const host = await pausedFixture4a()
    await host.advance(1_800_001)
    const state = (await host.status()).restartRequest
    assert.equal(state.state, 'terminal')
    assert.equal(state.reason, 'deadline-expired')
    assert.equal(state.executed, false)
    assert.match(state.message, /未执行|没有执行/u)
    assert.equal(host.spawnCount(), 0)
    assert.equal((await host.post('choice=now')).status, 409)
  }],
  ['9', 'countdown preference rejects invalid values atomically', async () => {
    const host = await requestFixture4a()
    assert.equal((await host.prefs('countdown=5')).status, 200)
    for (const value of ['-1', '61', 'no-number', '', '1.5']) {
      const response = await host.prefs('countdown=' + encodeURIComponent(value) + '&enabled=1')
      assert.equal(response.status, 400, 'invalid countdown: ' + value)
      assert.equal((await host.status()).countdownSeconds, 5)
      assert.equal(JSON.parse(files.get(profileSettingsPath)).countdown, 5)
    }
  }],
  // ── 2026-10-29 warnExpire 设置项（客户端警告态过期时长的宿主侧读写）──
  ['10', 'warnExpire preference reads, writes, validates, and defaults to 15', async () => {
    const host = await requestFixture4a()
    // 默认值：status 暴露 15（未配置时）。
    assert.equal((await host.status()).warnExpireSeconds, 15)
    // 合法写入：5–60 整数。
    assert.equal((await host.prefs('warnExpire=30')).status, 200)
    assert.equal((await host.status()).warnExpireSeconds, 30)
    assert.equal(JSON.parse(files.get(profileSettingsPath)).warnExpire, 30)
    assert.equal((await host.prefs('warnExpire=5')).status, 200)
    assert.equal((await host.prefs('warnExpire=60')).status, 200)
    assert.equal((await host.status()).warnExpireSeconds, 60)
    // 越界/非整数：400 且不改变已存值（原子性）。
    for (const value of ['4', '61', '-5', 'no-number', '', '1.5']) {
      const response = await host.prefs('warnExpire=' + encodeURIComponent(value))
      assert.equal(response.status, 400, 'invalid warnExpire: ' + value)
      assert.equal((await host.status()).warnExpireSeconds, 60)
      assert.equal(JSON.parse(files.get(profileSettingsPath)).warnExpire, 60)
    }
    // 非法存量回落 15（写坏文件后读默认，宁可短不可永不过期）。
    files.set(profileSettingsPath, JSON.stringify({ warnExpire: 999 }))
    assert.equal((await host.status()).warnExpireSeconds, 15)
  }],
  ['guards', 'stale asks are refused; concurrent choices and normal submissions spawn one helper', async () => {
    const host = await pausedFixture4a()
    const ask = (await host.status()).restartRequest.ask
    assert.equal((await host.post('choice=wait&ask=stale')).status, 409)
    assert.equal((await host.status()).restartRequest.ask, ask)
    const results = await Promise.all([host.post('choice=now&ask=' + ask), host.post('choice=now&ask=' + ask), host.post('wait=1')])
    assert.deepEqual(results.map(result => result.status), [202, 409, 409])
    assert.equal(host.spawnCount(), 1)
    assert.equal((await host.post('cancelWait=1')).body.cancelled, false)
  }],
  ['late-install', 'installation appearing at countdown end pauses safely without executing', async () => {
    const host = await requestFixture4a()
    await host.prefs('countdown=1')
    await host.post('wait=1')
    host.setInstalling(true)
    await host.advance(1000)
    const paused = (await host.status()).restartRequest
    assert.equal(paused.state, 'paused')
    assert.ok(paused.ask)
    host.setInstalling(false)
    await host.advance(60_000)
    assert.equal((await host.status()).restartRequest.ask, paused.ask)
    assert.equal(host.spawnCount(), 0)
  }],
  ['deadline-fields', 'deadline status expires waiting and countdown atomically with the legacy projection', async () => {
    for (const busy of [true, false]) {
      const host = await requestFixture4a()
      await host.prefs('countdown=60')
      host.setBusy(busy)
      await host.post('wait=1')
      assert.equal((await host.post('choice=wait')).status, 409, 'choices only apply to paused requests')
      host.jump(1_800_001)
      const status = await host.status()
      assert.equal(status.restartRequest.state, 'terminal')
      assert.equal(status.restartRequest.executed, false)
      assert.equal(status.waiting, null, 'legacy waiting must expire in the same response')
      assert.equal(status.restartRequest.countdownRemainingMs, null)
      assert.equal(host.spawnCount(), 0)
      assert.equal((await host.post('cancelWait=1')).body.cancelled, false)
    }
  }],
  // ── 2026-10-26 缺陷 1 回归（普通请求一律 waiting → countdown → executing）──
  // R0：用 0.4.4 宿主快照（真机当时在跑的代码）复现完整成因链：
  // 普通请求撞上运行中的任务 → 409+guard → 客户端 warn → 第二次点击带
  // force=1 → scheduleOnce 见 force 直接 spawn。倒计时形同虚设。
  // 这条用例在 0.4.4 上必须是「缺陷成立」，在 0.4.5 修复后用来钉住历史事实。
  ['R0', 'the 0.4.4 host reproduced the force shortcut: 409 then force spawns immediately', async () => {
    const host = await boot044()
    const restart = '/dsh-desktop-restart/api/restart'
    // 第一次：普通请求，任务在跑 → 409 + guard（这就是客户端 warn 态的来源）。
    const first = await host.request(restart, 'POST', restart)
    assert.equal(first.status, 409, 'R0: 0.4.4 returns 409 for a plain request while busy')
    assert.equal(first.body.guard.active, true, 'R0: the 409 carries the guard payload')
    // 第二次：客户端 warn 态二击发 force=1 → 0.4.4 直接 spawn，没有任何等待/倒计时。
    const second = host.request(restart, 'POST', restart + '?force=1')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(host.spawnCount(), 1, 'R0: 0.4.4 force=1 spawns at once — countdown never ran')
    // helperAlive 第一轮探活（300ms timer）在 VM 里不会自己跑，手动烧掉；
    // kill 桩对 signal 0 放行，所以一轮就判活，202 随即返回。
    for (const timer of host.timers.filter(t => !t.cancelled && t.ms === 300)) { timer.cancelled = true; timer.fn() }
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const response = await second
    assert.equal(response.status, 202, 'R0: 0.4.4 accepts the forced request immediately')
    for (const dispose of host.disposers) dispose()
  }],
  // R1：普通请求（无任何参数）空闲时也必须真的等满倒计时，5 秒内不得 spawn。
  ['R1', 'plain idle request still waits the full five-second countdown', async () => {
    const host = await requestFixture4a()
    await host.prefs('countdown=5')
    // 不带 wait=1 的「普通」请求：点重启时若有任务会 409（0.4.4）或直接
    // 挂等待（0.4.5），客户端第二次确认点击发的就是这种裸 POST。
    const response = host.post('')
    await settle4a()
    const state = (await host.status()).restartRequest
    assert.equal(state?.state, 'countdown', 'R1: plain request must enter countdown, not execute')
    assert.equal(state.countdownRemainingMs, 5000, 'R1: full countdown from the captured setting')
    await host.advance(4_900)
    assert.equal(host.spawnCount(), 0, 'R1: 4.9s in, no helper may be spawned')
    assert.notEqual((await host.status()).restartRequest.state, 'executing')
    await host.advance(100)
    assert.equal(host.spawnCount(), 1, 'R1: only at 5.0s does execution start')
    assert.equal((await host.status()).restartRequest.state, 'executing')
    await host.advance(500)
    await response
  }],
  // R2：有任务在跑时普通请求必须 202 + waiting（不是 409，更不是 executing）。
  ['R2', 'busy plain request returns 202 waiting and executes only after idle plus countdown', async () => {
    const host = await requestFixture4a()
    await host.prefs('countdown=5')
    host.setBusy(true)
    const response = await host.post('')
    assert.equal(response.status, 202, 'R2: a plain request while busy must be accepted (202), never 409')
    assert.equal(response.body.waiting, true, 'R2: acceptance means waiting')
    let state = (await host.status()).restartRequest
    assert.equal(state.state, 'waiting', 'R2: busy request parks in waiting')
    assert.equal(host.spawnCount(), 0, 'R2: nothing executes while work runs')
    // 任务还没结束：等 5 秒也仍在 waiting，不进 countdown。
    await host.advance(5_000)
    state = (await host.status()).restartRequest
    assert.equal(state.state, 'waiting', 'R2: still waiting while the turn runs')
    // 任务结束：要等下一轮 5 秒轮询核实空闲后才进 countdown，再等满 5 秒执行。
    host.setBusy(false)
    await host.advance(5_000)
    state = (await host.status()).restartRequest
    assert.equal(state.state, 'countdown', 'R2: countdown begins once idle is verified')
    await host.advance(4_999)
    assert.equal(host.spawnCount(), 0, 'R2: 4.999s into countdown, still no spawn')
    await host.advance(1)
    assert.equal(host.spawnCount(), 1, 'R2: executes at the full 5s mark')
    await host.advance(500)
  }],
  // R3：显式立即重启。now=1 单独出现不算「已确认」；force=1 单独出现也不算
  // （0.4.5 缺陷：客户端 warn 二击只带 force=1，宿主就直接执行了）；
  // 只有 force=1&now=1（来自「仍要重启 / 立即重启」的显式动作）才跳过
  // waiting/countdown；安装中照样硬拒绝。
  ['R3', 'explicit now skips waiting and countdown; bare now or force is refused; installs stay hard-blocked', async () => {
    const host = await requestFixture4a()
    await host.prefs('countdown=5')
    host.setBusy(true)
    // 裸 now=1（未确认）：不得跳过等待 —— 必须还回 waiting。
    const bare = await host.post('now=1')
    assert.equal(bare.status, 202, 'R3: bare now is still an accepted waiting request')
    assert.equal(bare.body.restartRequest.state, 'waiting', 'R3: bare now must not jump the queue')
    await host.post('cancelWait=1')
    // 裸 force=1（客户端 warn 态二击的形状）：同样不得跳过等待/倒计时。
    // 这正是「双击确认 == 立即重启」缺陷的宿主侧入口。
    const warnConfirm = await host.post('force=1')
    assert.equal(warnConfirm.status, 202, 'R3: bare force must be accepted as a normal waiting request')
    assert.equal(warnConfirm.body.restartRequest.state, 'waiting', 'R3: bare force must not execute immediately')
    assert.equal(host.spawnCount(), 0, 'R3: bare force spawns nothing')
    await host.post('cancelWait=1')
    // force=1&now=1（显式「仍要重启 / 立即重启」）：跳过 waiting/countdown。
    const immediate = host.post('force=1&now=1')
    await settle4a()
    assert.equal((await host.status()).restartRequest.state, 'executing', 'R3: force+now executes at once')
    assert.equal(host.spawnCount(), 1, 'R3: exactly one helper for the immediate path')
    await host.advance(500)
    await immediate
    // 安装中：连 force+now 也硬拒绝。
    const blocked = await requestFixture4a()
    blocked.setInstalling(true)
    const refusal = await blocked.post('force=1&now=1')
    assert.equal(refusal.status, 409, 'R3: installing stays a hard refusal')
    assert.equal(refusal.body.blocked, true, 'R3: refusal carries the blocked marker')
    assert.equal(blocked.spawnCount(), 0, 'R3: nothing spawns during an install')
  }],
  // R4：忙闲不可核实（guard.tasks.known=false）时保持 waiting，绝不执行。
  ['R4', 'unknown task state keeps the request waiting without executing', async () => {
    const host = await requestFixture4a({ known: false })
    await host.prefs('countdown=5')
    const response = await host.post('wait=1')
    assert.equal(response.status, 202)
    await host.advance(60_000)
    const state = (await host.status()).restartRequest
    assert.equal(state.state, 'waiting', 'R4: unverifiable busy state must stay in waiting')
    assert.equal(host.spawnCount(), 0, 'R4: never executes on unknown evidence')
    await host.post('cancelWait=1')
  }],
]
let failed4a = 0
for (const [id, name, test] of cases4a) {
  if (process.env.DSHDR4A_CASE && process.env.DSHDR4A_CASE !== id) continue
  try { await test(); if(id==='R0'){console.log('HISTORICAL-ONLY 0.4.4 defect reproduced; excluded from current pass count');continue} results.push({ case: '4A-' + id + ': ' + name, passed: true }); console.log('PASS 4A-' + id + ': ' + name) }
  catch (error) { failed4a += 1; console.error('FAIL 4A-' + id + ': ' + name + '\n' + error.stack) }
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '1') {
  const legacy = `${stateDir}\\settings.json`
  const original = JSON.stringify({ countdown: 7, sweep: false })
  files.set(legacy, original)
  const aDir = `${home}\\profiles\\profile-A`, bDir = `${home}\\profiles\\profile-B`
  for (const dir of [aDir, bDir]) { directories.add(dir); directories.add(dir + '\\node_modules'); files.set(dir + '\\package.json', '{}') }
  const a = await boot({ profile: aDir, restartId: null })
  const b = await boot({ profile: bDir, restartId: null })
  const status = h => h.request('/dsh-desktop-restart/api/status', 'GET', '/dsh-desktop-restart/api/status')
  assert.equal((await status(b)).body.countdownSeconds, 7)
  assert.equal((await a.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?countdown=11&enabled=1')).status, 200)
  assert.equal((await status(b)).body.countdownSeconds, 7, '4B-1: profile B must not see A countdown')
  assert.equal((await status(b)).body.sweep.enabled, false, '4B-1: sweep must also be isolated')
  assert.equal(files.get(legacy), original, 'migration must not modify legacy settings')
  files.set(legacy, JSON.stringify({countdown: 59, sweep: true}))
  const bAgain = await boot({ profile: bDir, restartId: null })
  assert.equal((await status(bAgain)).body.countdownSeconds, 7, 'migration only runs once')
  results.push({case:'4B-1 profile settings isolation and one-time legacy migration',passed:true})
  console.log('PASS 4B-1 profile settings isolation and one-time legacy migration')
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '2') {
  const host=await boot({restartId:'unread-missing-operation'})
  const status=()=>host.request('/dsh-desktop-restart/api/status','GET','/dsh-desktop-restart/api/status')
  const first=(await status()).body
  assert.ok(first.notifications?.items.some(n=>n.unread),'4B-2 host: unknown outcome must surface durable unread diagnostics')
  const notice=first.notifications.items.find(n=>n.unread)
  const response=await host.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?readNotice='+encodeURIComponent(notice.id))
  assert.equal(response.status,200)
  const second=(await status()).body
  assert.equal(second.notifications.items.find(n=>n.id===notice.id).unread,false)
  assert.equal(second.restartBusy,true,'mark read must not clear unknown mutual exclusion')
  assert.equal(second.restartOp.reason,'record-missing')
  assert.ok(second.notifications.items.find(n=>n.id===notice.id).details,'diagnostic retained')
  console.log('PASS 4B-2 host unread persists; read action preserves diagnosis and busy lock')
  results.push({case:'4B-2 host unread/read does not clear lock',passed:true})
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '3') {
  for (const action of ['cancelSweep=1','restart']) {
    let control, finish, count=0
    const host=await boot({restartId:null,agentsList:()=>[{id:'running',status:'running',inbox:{nextTurn:[],nextStep:[]}}],sweepImpl:options=>{control=options;return new Promise(resolve=>{finish=()=>resolve({scanned:count,candidates:[],preview:{bytes:0,files:0},removed:[],failed:[],skipped:[],partial:options.shouldStop?.()===true})})}})
    const scan=host.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?run=1')
    await settle4a()
    assert.equal(typeof control.shouldStop,'function','4B-3: production scan must receive cancellation signal')
    count++
    const pending=action==='restart'?host.request('/dsh-desktop-restart/api/restart','POST','/dsh-desktop-restart/api/restart?wait=1'):host.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?'+action)
    await settle4a()
    assert.equal(control.shouldStop(),true)
    if(!control.shouldStop()) count++
    finish()
    const result=await scan;await pending
    assert.equal(result.body.last.partial,true)
    assert.equal(result.body.last.scanned,1)
    assert.equal(result.body.last.removed,0)
    if(action==='restart') assert.equal((await host.request('/dsh-desktop-restart/api/status','GET','/dsh-desktop-restart/api/status')).body.restartRequest.state,'waiting')
  }

  let finishScan
  const snapshotHost=await requestFixture4a({sweepImpl:()=>new Promise(resolve=>{finishScan=()=>resolve({scanned:0,candidates:[],preview:{bytes:0,files:0},removed:[],failed:[],skipped:[],partial:true})})})
  await snapshotHost.prefs('countdown=5')
  const scan=snapshotHost.prefs('run=1');await settle4a()
  const since=snapshotHost.clockNow()
  const request=snapshotHost.post('wait=1');await settle4a()
  snapshotHost.jump(3000);await snapshotHost.prefs('countdown=9')
  finishScan();await scan;await request
  const captured=(await snapshotHost.status()).restartRequest
  assert.equal(captured.countdownSeconds,5,'4B-3: stopping a scan must retain settings captured when restart arrived')
  assert.equal(Date.parse(captured.deadlineAt),since+1_800_000,'scan cleanup must not move the original deadline')

  let releaseClosingScan
  const closing=await requestFixture4a({sweepImpl:()=>new Promise(resolve=>{releaseClosingScan=()=>resolve({scanned:0,candidates:[],preview:{bytes:0,files:0},removed:[],failed:[],skipped:[],partial:true})})})
  const closingScan=closing.prefs('run=1');await settle4a()
  const closingRestart=closing.post('force=1&now=1');await settle4a()
  for(const dispose of closing.disposers) dispose()
  releaseClosingScan();await closingScan
  assert.equal((await closingRestart).status,409,'4B-3: unload while stopping scan must not execute a pending restart')
  assert.equal(closing.spawnCount(),0)
  console.log('PASS 4B-3 cancel and restart both stop the production scan; partial results; removed zero')
  results.push({case:'4B-3 scan cancellation and restart priority',passed:true})
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '5') {
  const host=await requestFixture4a();host.setBusy(true);await host.post('wait=1')
  const cancelled=await host.post('cancelWait=1')
  assert.equal(cancelled.body.cancelled,true)
  assert.equal(cancelled.body.restartRequest.state,'terminal','cancel response still communicates its result')
  const next=await host.status()
  assert.deepEqual(next.restartRequest,cancelled.body.restartRequest,'terminal remains available to all status readers')
  await host.post('wait=1')
  assert.equal((await host.status()).restartRequest.state,'waiting','a new request replaces the previous terminal result')
  console.log('PASS 4B-5 cancel terminal remains until a new request replaces it')
  results.push({case:'4B-5 terminal persists for readers and is replaced by a new request',passed:true})
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '7') {
  const host=await requestFixture4a();await host.prefs('countdown=5');await host.post('wait=1')
  const state=(await host.status()).restartRequest
  assert.equal(typeof state.countdownUntil,'string','4B-7: host provides absolute countdownUntil')
  assert.equal(Date.parse(state.countdownUntil),Date.parse(state.deadlineAt)-1_800_000+5000)
  await host.post('cancelWait=1');assert.equal((await host.status()).restartRequest.countdownUntil,null)
  console.log('PASS 4B-7 countdownUntil is absolute and absent outside countdown')
  results.push({case:'4B-7 absolute countdownUntil',passed:true})
}

if (!process.env.DSHDR4C_CASE || process.env.DSHDR4C_CASE === 'B') {
  const deliveryRoot=process.env.DSHDR4C_ARTIFACT_ROOT || nativeFs.mkdtempSync(path.join(tmpdir(),'dshdr4c-performance-'))
  if (!process.env.DSHDR4C_ARTIFACT_ROOT) process.on('exit',()=>nativeFs.rmSync(deliveryRoot,{recursive:true,force:true}))
  const dir=path.join(deliveryRoot,'performance-fixture')
  nativeFs.mkdirSync(dir,{recursive:true})
  const ids=Array.from({length:60},(_,i)=>'notice-'+profileId+'-perf-'+i+'-failed')
  for (const [i,id] of ids.entries()) {
    const stem=path.join(dir,id)
    if (!nativeFs.existsSync(stem+'.json')) {
      nativeFs.writeFileSync(stem+'.json',JSON.stringify({schema:1,id,profileId,result:'failed',reason:'stop-failed',summary:'性能测试诊断（stop-failed）',at:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),details:{reason:'stop-failed',stages:{stop:i}}}))
      nativeFs.writeFileSync(stem+'.html','isolated performance diagnostic')
      nativeFs.writeFileSync(stem+'.delivery',JSON.stringify({status:'submitted',code:'visibility-unconfirmed'}))
      if (i%2===0) nativeFs.writeFileSync(stem+'.read','{}')
    }
  }
  const digest=createHash('sha256').update(ids.map(id=>nativeFs.readFileSync(path.join(dir,id+'.json'),'utf8')).join('\n')).digest('hex')
  const counts={readdirSync:0,readFileSync:0,statSync:0,existsSync:0}
  const io=new Proxy(nativeFs,{get(target,name){const value=target[name];return typeof value==='function' && Object.hasOwn(counts,name)?(...args)=>{counts[name]++;return value(...args)}:value}})
  let store
  const phase=process.env.DSHDR4C_PHASE || ('gate-'+Date.now())
  const before=phase==='before'
  const factory=before?createRequire(import.meta.url)(path.join(deliveryRoot,'before/source/lib/helper.cjs')).createNoticeStore:createNoticeStore
  const measuredHost=await boot({restartId:null,hostCode:before?nativeFs.readFileSync(path.join(deliveryRoot,'before/source/lib/index.js'),'utf8'):code,noticeOptions:{dir,io},noticeFactory:options=>{store=factory(options);return store}})
  const get=()=>measuredHost.request('/dsh-desktop-restart/api/status','GET','/dsh-desktop-restart/api/status')
  const samples=[]
  for(let i=0;i<10;i++) {const start=performance.now();const response=await get();samples.push(performance.now()-start);assert.equal(response.body.notifications.items.length,60)}
  const measuredSamples=samples.slice(1) // First GET warms the record cache; keep it in raw evidence only.
  const result={phase,kind:'actual status handler in VM; native NTFS notice IO; no TCP or real DSH',node:process.version,platform:process.platform,fixtureDirectory:dir,fixtureSha256:digest,recordCount:60,readCount:30,unreadCount:30,samplesMs:samples,warmupMs:samples[0],measuredSamplesMs:measuredSamples,averageMs:measuredSamples.reduce((a,b)=>a+b,0)/measuredSamples.length,maxMs:Math.max(...samples),ioCounts:{...counts}}
  nativeFs.writeFileSync(path.join(deliveryRoot,'performance-'+phase+'.json'),JSON.stringify(result,null,2))
  console.log('PERFORMANCE 4C-B '+JSON.stringify(result))
  assert.ok(result.averageMs<25,'60-record warm status GET average must remain below 25 ms')
  assert.equal(counts.readdirSync,1,'4C-B: ten consecutive status reads should enumerate notices only once')
  const original0=nativeFs.readFileSync(path.join(dir,ids[0]+'.json'),'utf8')
  const originalDelivery=nativeFs.readFileSync(path.join(dir,ids[0]+'.delivery'),'utf8')
  const original59=nativeFs.readFileSync(path.join(dir,ids[59]+'.json'),'utf8')
  const newId='notice-'+profileId+'-perf-new-failed'
  try {
    store.ensure({id:'perf-new',result:'failed',reason:'stop-failed'})
    assert.ok((await get()).body.notifications.items.some(n=>n.id===newId),'new ensure is visible on the very first GET')
    nativeFs.writeFileSync(path.join(dir,ids[0]+'.delivery'),JSON.stringify({status:'failed',code:'toast-unavailable'}))
    nativeFs.unlinkSync(path.join(dir,ids[0]+'.read'))
    let current=(await get()).body.notifications.items
    assert.equal(current.find(n=>n.id===ids[0]).unread,true,'missing read marker is immediately reflected')
    assert.equal(current.find(n=>n.id===ids[0]).delivery.code,'toast-unavailable','delivery update is not hidden by the cache')
    const updated=JSON.parse(original0);updated.at='2030-01-01T00:00:00.000Z'
    nativeFs.writeFileSync(path.join(dir,ids[0]+'.json'),JSON.stringify(updated))
    const realNow=Date.now
    try {
      Date.now=()=>realNow()+2001
      assert.equal((await get()).body.notifications.items[0].id,ids[0],'ordering matches live data when the two-second immutable-record cache expires')
    } finally {Date.now=realNow}
    const exposed=store.list();exposed.pop();exposed[0].details.reason='mutated'
    assert.equal((await get()).body.notifications.items.length,61)
    assert.equal((await get()).body.notifications.items[0].details.reason,'stop-failed','callers cannot mutate cached diagnostics')
    nativeFs.unlinkSync(path.join(dir,ids[59]+'.json'))
    assert.equal((await get()).body.notifications.items.some(n=>n.id===ids[59]),false,'cached records tolerate removal')
  } finally {
    nativeFs.writeFileSync(path.join(dir,ids[0]+'.json'),original0)
    nativeFs.writeFileSync(path.join(dir,ids[0]+'.delivery'),originalDelivery)
    nativeFs.writeFileSync(path.join(dir,ids[0]+'.read'),'{}')
    nativeFs.writeFileSync(path.join(dir,ids[59]+'.json'),original59)
    for(const suffix of ['json','html','delivery','read']) {const file=path.join(dir,newId+'.'+suffix);if(nativeFs.existsSync(file)) nativeFs.unlinkSync(file)}
  }
  console.log('PASS 4C-B cache avoids repeated directory scans; immediate new/read/delivery/order updates; warm average below 25 ms')
  results.push({case:'4C-B native 60-record status performance and coherent cache',passed:true})
}

if (!process.env.DSHDR4C_CASE || process.env.DSHDR4C_CASE === 'C') {
  const root=nativeFs.mkdtempSync(path.join(tmpdir(),'dshdr4c-migration-'))
  const translated=file=>{
    const text=String(file)
    assert.ok(text===home || text.startsWith(home+'\\'),'fixture IO must remain under the virtual home')
    return path.join(root,...path.win32.relative(home,text).split('\\'))
  }
  const adapter={}
  for(const name of ['readFileSync','writeFileSync','existsSync','statSync','mkdirSync','readdirSync','unlinkSync','renameSync','openSync','closeSync']) {
    adapter[name]=(...args)=>{
      if(name==='closeSync') return nativeFs.closeSync(...args)
      if(name==='readFileSync' && !String(args[0]).startsWith(home) && String(args[0]).endsWith('package.json')) return '{"version":"0.4.5"}'
      const translatedArgs=[translated(args[0]),...args.slice(1)]
      if(name==='renameSync') translatedArgs[1]=translated(args[1])
      return nativeFs[name](...translatedArgs)
    }
  }
  let primaryError=null
  const actualState=translated(stateDir)
  const legacy=path.join(actualState,'settings.json')
  const settings=path.join(actualState,'settings-'+profileId+'.json')
  const marker=path.join(actualState,'settings-migrated-'+profileId)
  try {
    nativeFs.mkdirSync(translated(profileDir+'\\node_modules'),{recursive:true})
    nativeFs.writeFileSync(translated(profileDir+'\\package.json'),'{}')
    nativeFs.mkdirSync(actualState,{recursive:true})
    nativeFs.writeFileSync(legacy,JSON.stringify({countdown:17,sweep:false}))
    const beforeBytes=nativeFs.readFileSync(legacy), beforeMtime=nativeFs.statSync(legacy).mtimeMs
    const get=host=>host.request('/dsh-desktop-restart/api/status','GET','/dsh-desktop-restart/api/status')
    const first=await boot({restartId:null,fsOverride:adapter})
    assert.equal((await get(first)).body.countdownSeconds,17)
    assert.equal((await get(first)).body.settingsMigrated,true,'4C-C: successful migration must persist a one-time marker')
    assert.equal(nativeFs.existsSync(marker),true)
    assert.deepEqual(nativeFs.readFileSync(legacy),beforeBytes)
    assert.equal(nativeFs.statSync(legacy).mtimeMs,beforeMtime,'legacy mtime must remain unchanged')
    nativeFs.unlinkSync(settings)
    const again=await boot({restartId:null,fsOverride:adapter})
    const second=(await get(again)).body
    assert.equal(second.settingsMigrated,true)
    assert.equal(second.countdownSeconds,0,'deleted per-profile settings must not resurrect legacy values')
    assert.equal(nativeFs.existsSync(settings),false)
    nativeFs.writeFileSync(settings,JSON.stringify({countdown:23,sweep:true}))
    nativeFs.unlinkSync(marker)
    const adoptedMtime=nativeFs.statSync(settings).mtimeMs
    const adopted=(await get(await boot({restartId:null,fsOverride:adapter}))).body
    assert.equal(adopted.settingsMigrated,true,'pre-marker profile settings are adopted without importing legacy values')
    assert.equal(adopted.countdownSeconds,23)
    assert.equal(nativeFs.statSync(settings).mtimeMs,adoptedMtime)
    nativeFs.unlinkSync(settings)
    // An operator removing the marker explicitly makes migration eligible again.
    nativeFs.unlinkSync(marker)
    const readonly={...adapter,writeFileSync(){const error=new Error('read-only fixture');error.code='EACCES';throw error}}
    const failed=await boot({restartId:null,fsOverride:readonly})
    const failure=(await get(failed)).body
    assert.ok(failure.settingsMigrationError,'read-only directory must expose migration error')
    assert.equal(failure.settingsMigrationError,'EACCES','adapter write rejection must reach the status interface')
    assert.equal(failure.settingsMigrated,false)
    assert.equal((await failed.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?countdown=9')).status,503)
    assert.deepEqual(nativeFs.readFileSync(legacy),beforeBytes)
    assert.equal(nativeFs.statSync(legacy).mtimeMs,beforeMtime)
    console.log('PASS 4C-C durable migration marker; deleted profile settings stay default; legacy bytes/mtime preserved; read-only writes return 503')
    results.push({case:'4C-C persistent one-time settings migration and read-only failure',passed:true})
  } catch(error) {
    primaryError=error
    throw error
  } finally {
    try {nativeFs.rmSync(root,{recursive:true,force:true})}
    catch(error) {if(primaryError) console.error('migration fixture cleanup also failed:',error);else throw error}
  }
}

{
  const statePath = `${stateDir}\\auth-cookie-${profileId}.json`
  files.delete(statePath)
  const host = await requestFixture4a()
  let health=(await host.status()).authCookie
  assert.equal(health.backup,false);assert.equal(health.warn,true);assert.equal(health.limitBytes,16384);assert.equal(health.last,null)
  await host.prefs('authCookieClean=1')
  assert.equal((await host.status()).authCookie.backup,false,'legacy clean setting cannot enable backup or deletion')
  const enabled=await host.prefs('authCookieBackup=1&authCookieWarn=0')
  assert.equal(enabled.body.authCookie.backup,true);assert.equal(enabled.body.authCookie.warn,false)
  const saved=JSON.parse(files.get(profileSettingsPath))
  assert.equal(saved.authCookieBackup,true);assert.equal(saved.authCookieWarn,false)
  assert.equal((await host.prefs('authCookieBackup=yes')).status,400)
  assert.equal((await host.prefs('authCookieWarn=2')).status,400)
  const last={schema:1,checkedAt:new Date(host.clockNow()-5000).toISOString(),status:'near',sample:{estimatedBytes:14028,authCount:60,status:'near'},cleanup:{performed:false}}
  files.set(statePath,JSON.stringify(last))
  assert.deepEqual((await host.status()).authCookie.last,last)
  const scheduled=await host.prefs('checkAuthCookie=1')
  assert.equal(scheduled.body.authCookie.checkPending,true)
  assert.equal(host.spawnCount(),0,'checking in settings must not spawn or restart')
  assert.equal((await host.status()).authCookie.backup,true)
  // No live Cookie DB exists in this host fixture: GET and preference saves use only the JSON record.
  files.delete(statePath)
  console.log('PASS AUTH COOKIE HOST: defaults off/on; strict preference values; stored-only status; next-restart check; no immediate restart')
  results.push({case:'auth-cookie preferences and stored-only status',passed:true})
}


{
  for (const [entryConfig,expected] of [[{},true],[{accountMenu:false},false]]) {
    const host=await boot({restartId:null,entryConfig})
    const response=await host.request('/dsh-desktop-restart/api/status','GET','/dsh-desktop-restart/api/status')
    assert.equal(response.body.entries.accountMenu,expected)
  }
  console.log('PASS ACCOUNT MENU HOST: status entry defaults true; explicit config false disables')
  results.push({case:'accountMenu host status defaults and explicit false',passed:true})
}

// Written with the deep-review repair. Do not execute until the user approves tests.
{
  const host=await requestFixture4a()
  host.setBusy(true);await host.post('wait=1')
  await host.advance(1_800_001)
  const first=(await host.status()).restartRequest
  const second=(await host.status()).restartRequest
  assert.equal(first.state,'terminal');assert.equal(first.reason,'deadline-expired')
  assert.deepEqual(second,first,'GET must preserve the result for other readers')
  for(const dispose of host.disposers)dispose()
  results.push({case:'deep-review: terminal survives multiple status readers',passed:true})
}
{
  const host=await requestFixture4a()
  host.setBusy(true);await host.post('wait=1')
  const response=await host.post('cancelWait=1&expiresAt='+String(host.clockNow()-1))
  assert.equal(response.status,408)
  assert.equal((await host.status()).restartRequest.state,'waiting','an expired cancellation cannot affect a newer request')
  const malformed=await host.post('expiresAt=NaN')
  assert.equal(malformed.status,400)
  for(const dispose of host.disposers)dispose()
  results.push({case:'deep-review: expired and malformed submissions are rejected before state changes',passed:true})
}
{
  const host=await boot({restartId:null})
  for(let i=0;i<25;i++) files.set(`${stateDir}\\op-retention-fixture-${i}.json`,JSON.stringify({schema:1,id:`retention-fixture-${i}`,profileId:'retention-fixture-profile',result:'ok',updatedAt:new Date(Date.UTC(2026,9,1,0,i)).toISOString()}))
  for(const result of ['pending','unknown']) files.set(`${stateDir}\\op-retention-${result}.json`,JSON.stringify({schema:1,id:`retention-${result}`,profileId:'retention-fixture-profile',result,updatedAt:new Date().toISOString()}))
  files.set(`${stateDir}\\notice-retention-profile-retention-fixture-0-failed.json`,'{}')
  host.module.namespace.__test.pruneState(stateDir)
  assert.ok(files.has(`${stateDir}\\op-retention-fixture-0.json`),'unread reference protects an old completed record')
  assert.ok(!files.has(`${stateDir}\\op-retention-fixture-1.json`),'old unreferenced completed record retires')
  assert.ok(files.has(`${stateDir}\\op-retention-pending.json`));assert.ok(files.has(`${stateDir}\\op-retention-unknown.json`))
  assert.equal([...files.keys()].filter(name=>/op-retention-fixture-\d+\.json$/u.test(name)).length,21)
  for(const dispose of host.disposers)dispose()
  results.push({case:'deep-review: operation retention preserves unknown/pending/unread evidence',passed:true})
}
{
  const host=await boot({restartId:null})
  const status=(await host.request('/dsh-desktop-restart/api/status','GET','/dsh-desktop-restart/api/status')).body
  assert.equal(status.requestExpiry,true);assert.ok(Number.isFinite(status.serverNow))
  const rejected=await host.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?clientReady=foreign')
  assert.equal(rejected.status,409,'another restart cannot claim this client receipt')
  for(const dispose of host.disposers)dispose()
  results.push({case:'deep-review: status expiry capability and recovery nonce mismatch',passed:true})
}

{
  const id='deep-client-recovery'
  files.set(markerPath,JSON.stringify(makeMarker(id)))
  files.set(`${stateDir}\\op-${id}.json`,JSON.stringify({schema:1,id,profileId,hostPid:123,pid:901,result:'pending',startedAt:new Date().toISOString(),stages:{}}))
  const host=await boot({restartId:id})
  const ready=JSON.parse(files.get(`${stateDir}\\op-${id}.json`))
  assert.equal(ready.readyHostPid,200);assert.ok(Number.isFinite(Date.parse(ready.hostReadyAt)))
  const response=await host.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?clientReady='+id)
  assert.equal(response.status,200)
  assert.ok(Number.isFinite(Date.parse(JSON.parse(files.get(`${stateDir}\\op-${id}.json`)).clientReadyAt)))
  for(const dispose of host.disposers)dispose()
  results.push({case:'deep-review: matching nonce records host and authenticated client recovery',passed:true})
}

console.log(JSON.stringify({ kind: 'in-memory VM; upstream V4 source admission fixture; fake fs/timers/agents; no real host, process, network, cleanup, or agent messaging', results }, null, 2))
if (failed4a) process.exitCode = 1

{
  files.delete(stateDir+'\\restart.lock')
  const first=await boot({restartId:null,fakeHelper:true})
  const api=first.module.namespace.__test
  assert.equal(api.acquireRestartLock('first-profile').ok,true)
  const second=await boot({restartId:null,fakeHelper:true,profile:profileDir+'-second'})
  const other=second.module.namespace.__test
  const response=await second.request('/dsh-desktop-restart/api/restart','POST','/dsh-desktop-restart/api/restart?force=1&now=1')
  assert.equal(response.status,409);assert.equal(second.spawnCount(),0)
  const normal=await second.request('/dsh-desktop-restart/api/restart','POST','/dsh-desktop-restart/api/restart')
  assert.equal(normal.status,409);assert.equal(second.spawnCount(),0)
  assert.equal(other.acquireRestartLock('second-profile').status,409)
  api.releaseRestartLock('wrong-token');assert.ok(files.has(api.RESTART_LOCK))
  api.releaseRestartLock('first-profile');assert.equal(files.has(api.RESTART_LOCK),false)
  console.log('PASS BATCH1-1: two profile hosts share lock; second POST=409; no second helper; wrong token cannot release')
  const stale=await boot({restartId:null,fakeHelper:true,deadLockPid:99999})
  const staleApi=stale.module.namespace.__test
  files.set(staleApi.RESTART_LOCK,JSON.stringify({pid:99999,at:'2026-01-01T00:00:00Z',token:'old'}))
  assert.equal(staleApi.acquireRestartLock('takeover').stale,true)
  assert.equal(JSON.parse(files.get(staleApi.RESTART_LOCK)).token,'takeover')
  staleApi.releaseRestartLock('takeover')
  for(const h of [first,second,stale])for(const dispose of h.disposers)dispose()
  console.log('PASS BATCH1-1: ESRCH stale owner taken over and recorded; single owner released')
}

{
  const h=await requestFixture4a()
  const response=await h.post('force=1&now=1')
  assert.equal(response.status,202)
  const api=h.module.namespace.__test
  const lock=JSON.parse(files.get(api.RESTART_LOCK))
  assert.equal(lock.pid,901,'parent binds the lock to the spawned helper before acknowledging')
  const handoff=[...files.entries()].filter(([name])=>name.includes('handoff-')&&name.endsWith('.json')).map(([,value])=>JSON.parse(value)).find(value=>value.restartId===lock.token)
  assert.equal(handoff.exe,path.win32.basename(exe));assert.equal(handoff.exeFromEnv,true)
  api.releaseRestartLock(lock.token)
  for(const dispose of h.disposers)dispose()
  console.log('PASS BATCH1-1: normal request succeeds and lock PID is immediately transferred to helper')
}

{
  const h=await boot({restartId:null,entryConfig:{platformAuth:true}})
  const status=(await h.request('/dsh-desktop-restart/api/status','GET')).body
  assert.equal(status.platformAuth.available,false);assert.equal(status.enabled,false)
  for(const route of ['/dsh-desktop-restart/api/restart','/dsh-desktop-restart/api/prefs']){
    const result=await h.request(route,'POST',route)
    assert.equal(result.status,503);assert.match(result.body.error,/缺少平台鉴权服务/)
  }
  assert.equal(h.spawnCount(),0)
  for(const dispose of h.disposers)dispose()
  console.log('PASS BATCH2-9: missing platform auth disables status and rejects both write routes with 503')
}
{
  const h=await boot({restartId:null}),api=h.module.namespace.__test
  for(const [id,result,age] of [['old','ok',9],['recent','ok',2],['pending','pending',9],['unknown','unknown',9]])
    files.set(`${stateDir}\\op-orphan-${id}.json`,JSON.stringify({schema:1,id:'orphan-'+id,result,updatedAt:new Date(Date.now()-age*86400000).toISOString()}))
  api.pruneState(stateDir)
  assert.equal(files.has(`${stateDir}\\op-orphan-old.json`),false)
  for(const id of ['recent','pending','unknown'])assert.equal(files.has(`${stateDir}\\op-orphan-${id}.json`),true)
  for(const dispose of h.disposers)dispose()
  console.log('PASS BATCH2-14: seven-day terminal orphan records retire; recent/pending/unknown evidence stays')
}

for(const [value,expected] of [[undefined,false],[false,false],[true,true],['true',false]]) {
  const h=await boot({restartId:null,entryConfig:{headerRefresh:value}})
  const result=await h.request('/dsh-desktop-restart/api/status','GET')
  assert.equal(result.body.entries.headerRefresh,expected)
  for(const dispose of h.disposers)dispose()
  console.log('PASS UI CLEANUP HOST: headerRefresh config='+String(value)+' => '+expected)
}

{
  const h=await boot({restartId:null,fakeHelper:true,spawnError:'EACCES'})
  const response=await h.request('/dsh-desktop-restart/api/restart','POST','/dsh-desktop-restart/api/restart?force=1&now=1')
  assert.equal(response.status,500)
  assert.match(response.body.error,/fixture spawn denied/)
  const api=h.module.namespace.__test
  assert.equal(files.has(api.RESTART_LOCK),false,'failed asynchronous spawn releases owned lock')
  const status=(await h.request('/dsh-desktop-restart/api/status','GET')).body
  assert.equal(status.restartBusy,false)
  assert.equal(status.restartOp.reason,'helper-spawn-failed')
  for(const dispose of h.disposers)dispose()
  console.log('PASS REPAIR F1: asynchronous helper EACCES becomes HTTP500; failure recorded, lock released, host remains responsive')
}
{
  const off=await boot({restartId:null})
  const status=await off.request('/dsh-desktop-restart/api/status','GET')
  assert.equal(status.body.menuTraceEnabled,false)
  assert.equal((await off.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?menuTrace=%7B%7D')).status,404)
  for(const dispose of off.disposers)dispose()
  files.set(stateDir+'\\menu-trace-control.json',JSON.stringify({enabled:true}))
  const h=await boot({restartId:null})
  assert.equal((await h.request('/dsh-desktop-restart/api/status','GET')).body.menuTraceEnabled,true)
  for(let i=0;i<51;i++){
    const data={id:'1000-'+i,startedAt:1000,endReason:'timeout',events:[{at:1000,type:'probe',outcome:'trigger-not-open',expanded:'false',connected:true,menus:0,menuitem:false,viewport:false,secret:'do-not-save'}]}
    const response=await h.request('/dsh-desktop-restart/api/prefs','POST','/dsh-desktop-restart/api/prefs?menuTrace='+encodeURIComponent(JSON.stringify(data)))
    assert.equal(response.status,200)
  }
  const raw=files.get(stateDir+'\\menu-trace-'+profileId+'.json')
  const data=JSON.parse(raw)
  assert.equal(data.sessions.length,50);assert.equal(data.sessions[0].id,'1000-1')
  assert.ok(!raw.includes('do-not-save'))
  files.delete(stateDir+'\\menu-trace-control.json')
  for(const dispose of h.disposers)dispose()
  console.log('PASS MENU TRACE: off by default; authenticated receiver opt-in; 50-session ring; extra fields discarded')
}
