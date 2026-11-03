import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import { MIN_ORPHAN_AGE_MS, sweepOrphanSnapshots } from '../lib/sweep.js'

const root = dirname(fileURLToPath(import.meta.url))
const helperPath = join(root, '..', 'lib', 'helper.cjs')
const helperSource = readFileSync(helperPath, 'utf8')
const targetExe = 'C:\\DSH\\app.exe'

function makeProcess(pid, parentPid, path, createdAt, commandLine = 'app.exe') {
  return { pid, parentPid, path, createdAt: new Date(createdAt).toISOString(), commandLine }
}

function runHelperScenario({ foreignPath = targetExe, foreignListener = true, startNewHost = false, handoffPort = 18000, failOperationWrite = false, failLaunchWrite = false, failIdentityWrite = false, incompleteCim = false, legacyHandoff = false, notifications = false, authCookieFailure = false, acknowledgeRecovery = true, keepOldHost = false, disappearBeforeKill = false, opReadError = null, missingOp = false, finalWriteFailure = false, withLock = false, throwCore = false, badHandoff = false, privateExe = false, newHostListener = true, incompleteNewHostRow = false }) {
  let clock = Date.now()
  const main = makeProcess(100, 1, targetExe, clock - 20_000, '"C:\\DSH\\app.exe" --user-data-dir=C:\\profile-A')
  const host = makeProcess(101, 100, targetExe, clock - 15_000, '"C:\\DSH\\app.exe" --expose-internals')
  const helper = makeProcess(102, 101, targetExe, clock - 10_000, '"C:\\DSH\\app.exe" helper.cjs handoff.json')
  const oldHostChild = makeProcess(103, 101, targetExe, clock - 8_000, '"C:\\DSH\\app.exe" --type=utility')
  const foreignMain = makeProcess(200, 1, foreignPath, clock - 60_000, '"C:\\DSH\\app.exe" --user-data-dir=C:\\profile-B')
  const foreignHost = makeProcess(201, 200, foreignPath, clock - 55_000, '"C:\\DSH\\app.exe" --expose-internals')
  const processes = new Map([main, host, helper, oldHostChild, foreignMain, foreignHost].map((entry) => [entry.pid, entry]))
  const killed = []
  const noticesSent = []
  const notes = []
  const launchEnvs = []
  let cimReads=0
  const operationFiles = new Map()
  const opPath = 'C:\\virtual\\desktop-restart\\op-restart-test-123.json'
  operationFiles.set(opPath, JSON.stringify({ id: 'restart-test-123', schema: 1, phase: 'scheduled', result: 'pending', pid: null, hostPid: 101, startedAt: new Date(clock).toISOString(), stages: {} }))
  const originalOp = operationFiles.get(opPath)
  if (missingOp) operationFiles.delete(opPath)
  if (opReadError === 'json') operationFiles.set(opPath, '{broken json')
  const lockPath='C:\\virtual\\restart.lock'
  if (withLock) operationFiles.set(lockPath,JSON.stringify({pid:101,token:'restart-test-123',at:new Date(clock).toISOString()}))
  const listeners = new Map()
  if (foreignListener) listeners.set(18000, 201)
  if (startNewHost) listeners.set(19001, 301)
  const fakeDate = class extends Date {
    constructor(value) { super(value === undefined ? clock : value) }
    static now() { return clock }
  }
  const childProcess = {
    execFileSync(command, args) {
      if (command === 'netstat') {
        const rows = [...listeners].map(([port, pid]) => ` TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING ${pid}`)
        return rows.length === 0 ? 'Active Connections' : rows.join('\n')
      }
      if (command === 'taskkill') {
        const pid = Number(args[args.indexOf('/PID') + 1])
        killed.push(pid)
        processes.delete(pid)
        if (authCookieFailure && !keepOldHost && pid === 100) { processes.delete(101); processes.delete(103) }
        for (const [port, owner] of listeners) if (owner === pid) listeners.delete(port)
        return ''
      }
      if (command === 'powershell.exe' || command === 'pwsh.exe') {
        cimReads++
        if(disappearBeforeKill && cimReads===3) processes.delete(100)
        const rows = [...processes.values()].filter((entry) => win32.basename(entry.path).toLowerCase() === 'app.exe')
        const result = rows.map((entry) => ({
          ProcessId: entry.pid,
          ParentProcessId: entry.parentPid,
          ExecutablePath: entry.path,
          CommandLine: entry.commandLine,
          CreatedAt: entry.createdAt,
        }))
        if (incompleteCim) delete result.find((entry) => entry.ProcessId === 102).CreatedAt
        // 2026-11-03（回执晚到）：只让**新宿主**那一行不完整。整表按
        // rows.every(processIdentityComplete) 作废 → 就绪轮询里永远建不出进程树，
        // 于是「回执已落盘却读不到」被误报成结果未知 —— 正是真机第二次的形态。
        // 动手前的 verify/stop 阶段新宿主还不存在，所以不影响前置流程。
        if (incompleteNewHostRow) delete result.find((entry) => entry.ProcessId === 301)?.CreatedAt
        return JSON.stringify(result)
      }
      throw new Error(`Unexpected process command in fake: ${command}`)
    },
    spawn(command, args, options) {
      if (command === targetExe) {
        launchEnvs.push(options.env)
        const launchedAt = clock
        processes.set(300, makeProcess(300, 1, targetExe, launchedAt, '"C:\\DSH\\app.exe" --user-data-dir=C:\\profile-A'))
        if (startNewHost) {
          processes.set(301, makeProcess(301, 300, targetExe, launchedAt, '"C:\\DSH\\app.exe" --expose-internals'))
          if(acknowledgeRecovery) {
            const previous=JSON.parse(operationFiles.get(opPath))
            operationFiles.set(opPath,JSON.stringify({...previous,profileId:'engine-fixture',readyHostPid:301,hostReadyAt:new Date(launchedAt).toISOString(),clientReadyAt:new Date(launchedAt).toISOString()}))
            // 2026-11-03 issue #4：回执齐全但 netstat 里查不到新宿主监听项
            //（真机 06:38 那次：hostReadyPid 活着、clientReadyAt 有值、readyPort 空）。
            if (!newHostListener) listeners.delete(19001)
          }
        }
        return { pid: 300, on() { return this }, unref() {} }
      }
      if (command === 'powershell.exe') noticesSent.push(args)
      return { pid: 900, on() { return this }, unref() {} }
    },
  }
  const fakeProcess = {
    pid: 102,
    ppid: 101,
    argv: [],
    env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_RESTART_ID: 'old', ...(privateExe ? {DSH_DESKTOP_RESTART_EXE:targetExe} : {}) },
    kill(pid) {
      if (!processes.has(pid)) { const error = new Error('gone'); error.code = 'ESRCH'; throw error }
    },
  }
  const fakeNet = {
    connect({ port }) {
      const handlers = new Map()
      const socket = {
        on(event, callback) {
          handlers.set(event, callback)
          if (event === 'connect' && listeners.has(port)) queueMicrotask(callback)
          if (event === 'error' && !listeners.has(port)) queueMicrotask(callback)
          return socket
        },
        setTimeout() { return socket },
        destroy() {},
      }
      return socket
    },
  }
  const fakeRequire = (specifier) => {
    if (specifier === 'node:worker_threads') return {Worker:class extends EventEmitter {
      constructor(_file,{workerData}) {super();if(authCookieFailure==='timeout'||authCookieFailure==='terminate-fails')return;queueMicrotask(async()=>{
        const result=await module.exports.checkAuthCookies(workerData.authCookieCheck,line=>this.emit('message',{note:line}))
        this.emit('message',{result});this.emit('exit',0)
      })}
      async terminate(){notes.push('fixture Cookie worker terminated');if(authCookieFailure==='terminate-fails')throw Object.assign(new Error('cannot terminate'),{code:'EPERM'});this.emit('exit',1)}
    }}
    if (specifier === 'node:child_process') return childProcess
    if (specifier === 'node:fs') return {
      readFileSync(file) {
        if (String(file)===opPath && opReadError === 'EACCES') { const e=new Error('locked fixture');e.code='EACCES';throw e }
        if (!operationFiles.has(String(file))) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error }
        return operationFiles.get(String(file))
      },
      mkdirSync() {},
      unlinkSync(file){operationFiles.delete(String(file))},
      statSync(file) {if(operationFiles.has(String(file))) return {mtimeMs:0,ctimeMs:0,size:Buffer.byteLength(operationFiles.get(String(file)))};if(String(file)===win32.dirname(opPath)) return {mtimeMs:operationFiles.size,ctimeMs:operationFiles.size,size:0};const e=new Error('missing');e.code='ENOENT';throw e},
      existsSync: file => operationFiles.has(String(file)),
      readdirSync: dir => [...operationFiles.keys()].filter(file=>win32.dirname(file)===dir).map(file=>win32.basename(file)),
      writeFileSync(file, text, options) {
        if (options?.flag === 'wx' && operationFiles.has(String(file))) {const e=new Error('exists');e.code='EEXIST';throw e}
        if (finalWriteFailure && String(file).startsWith(opPath) && (String(text).includes('"result":"ok"') || String(text).includes('"stages":{"verify"'))) throw new Error('fixture final/timing disk full')
        if (failLaunchWrite && String(file).startsWith(opPath) && (String(text).includes('"phase":"port-wait"') || String(text).includes('"phase":"launch"'))) throw new Error('fixture launch bookkeeping disk full')
        if ((failOperationWrite && String(file).startsWith(opPath)) || (failIdentityWrite && String(text).includes('"helperIdentity"'))) throw new Error('simulated operation record write failure')
        operationFiles.set(String(file), String(text))
      },
      renameSync(from, to) { operationFiles.set(String(to), operationFiles.get(String(from))); operationFiles.delete(String(from)) },
    }
    if (specifier === 'node:sqlite' && authCookieFailure) return {
      DatabaseSync:class {
        constructor(){if(authCookieFailure!=='delete'){const e=new Error('isolated fake Cookie DB locked');e.code='SQLITE_BUSY';throw e}}
        prepare(sql){return sql.startsWith('SELECT')?{get:()=>({count:60,bytes:13560,authCount:60})}:{run(){const e=new Error('isolated fixture DELETE denied');e.code='SQLITE_IOERR';throw e}}}
        exec(sql){notes.push('fixture SQLite '+sql)}
        close(){}
      },
      backup:async()=>{notes.push('fixture consistent backup completed')},
    }
    if (specifier === 'node:net') return fakeNet
    if (specifier === 'node:path') return win32
    throw new Error(`Unexpected module in fake: ${specifier}`)
  }
  const module = { exports: {} }
  fakeRequire.main = {}
  vm.runInNewContext(helperSource, {
    require: fakeRequire,
    __filename: helperPath,
    module,
    exports: module.exports,
    process: fakeProcess,
    Buffer,
    Date: fakeDate,
    Promise,
    setTimeout(callback, ms) { if(ms===8000){if(authCookieFailure==='timeout'||authCookieFailure==='terminate-fails')queueMicrotask(callback);return {unref(){}}}; clock += ms; callback(); return { unref() {} } },
    clearTimeout() {},
    queueMicrotask,
  }, { filename: helperPath })
  const helperApi = module.exports
  const handoff = {
    mainPid: 100,
    hostPid: 101,
    exe: targetExe,
    restartId: 'restart-test-123',
    port: handoffPort,
    opPath,
    delayMs: 1,
    relaunchAttempts: 1,
    relaunchVerifyMs: 1,
    mainExitTimeoutMs: 2,
    portFreeTimeoutMs: 2,
    portRelistenTimeoutMs: 3,
    alertOnFailure: notifications,
    profileId: 'engine-fixture',
  }
  if (authCookieFailure) {
    operationFiles.set('C:\\profile-A\\Network\\Cookies','fixture')
    handoff.authCookie={databasePath:'C:\\virtual\\Cookies',statePath:'C:\\virtual\\health.json',backupDir:'C:\\virtual\\backups',clean:true}
  }
  // 旧宿主（0.4.4）的交接里没有 opPath —— 真机 2026-10-22 因此死锁过。
  if (legacyHandoff) delete handoff.opPath
  if (withLock) handoff.restartLock={path:lockPath,token:'restart-test-123'}
  if (privateExe) {handoff.exe=win32.basename(targetExe);handoff.exeFromEnv=true}
  if (badHandoff) handoff.mainPid=0
  if (throwCore) handoff.mainPid={valueOf(){throw new Error('fixture unexpected core failure')}}
  let coreError=null
  return helperApi.performRestart(handoff, (line) => notes.push(line)).catch(error=>{if(!throwCore)throw error;coreError=error.message}).then(() => ({ coreError, noticesSent, noticeRecords:[...operationFiles.entries()].filter(([file])=>win32.basename(file).startsWith('notice-') && file.endsWith('.json')).map(([,value])=>JSON.parse(value)), originalOp, rawOp:operationFiles.get(opPath), lockPresent:operationFiles.has(lockPath), cookieHealth:authCookieFailure?JSON.parse(operationFiles.get('C:\\virtual\\health.json')):null, killed, notes, launchEnvs, processes: [...processes.keys()], listeners: [...listeners], operation: legacyHandoff ? null : (opReadError === 'json' ? null : JSON.parse(operationFiles.get(opPath))), cimReadResult: helperApi.queryApplicationProcesses('app.exe') }))
}

// Same image and same executable, different profile: only the old host tree is eligible.
const sameExeOtherProfile = await runHelperScenario({ foreignPath: targetExe, foreignListener: true })
assert(sameExeOtherProfile.killed.includes(100), 'the verified old main is stopped')
assert(sameExeOtherProfile.killed.includes(103), 'a verified descendant of the old host may be stopped')
assert(!sameExeOtherProfile.killed.includes(200) && !sameExeOtherProfile.killed.includes(201), 'another profile tree is preserved')
assert(sameExeOtherProfile.notes.some((line) => line.includes('ownership by this instance could not be proved')), 'foreign listener aborts restart')
assert.equal(sameExeOtherProfile.operation.helperVerified, true, 'helper persists its verified process identity')
assert.equal(sameExeOtherProfile.operation.helperIdentity.pid, 102)
assert.equal(Object.hasOwn(sameExeOtherProfile.operation.helperIdentity, 'commandLine'), false, 'operation record does not persist full process command line')

// Different install path, same executable name: name matching is never used to expand the kill set.
// 真机 2026-10-22 的教训：旧宿主的交接没有 opPath，新 helper 不得因此拒绝执行。
const legacyHandoff = await runHelperScenario({ legacyHandoff: true })
assert(legacyHandoff.killed.includes(100), 'legacy handoff still stops the verified main (no deadlock)')
assert(legacyHandoff.notes.some((line) => line.includes('legacy handoff')), 'logs that state records are unavailable')
assert(!legacyHandoff.notes.some((line) => line.includes('could not be persisted')), 'a missing opPath is not a write failure')

const otherInstall = await runHelperScenario({ foreignPath: 'D:\\OtherInstall\\app.exe', foreignListener: true })
assert(!otherInstall.killed.includes(200) && !otherInstall.killed.includes(201), 'another install is preserved')

// The main PID alone is not readiness. An unrelated app host listener must time out as unknown.
const foreignListenerOnly = await runHelperScenario({
  foreignPath: targetExe,
  foreignListener: true,
  startNewHost: false,
  handoffPort: null,
})
assert.equal(foreignListenerOnly.launchEnvs.length, 1, 'readiness case reaches new-instance launch')
assert(!foreignListenerOnly.notes.some((line) => line.includes('restart complete')), 'another profile listener is not readiness')
assert.equal(foreignListenerOnly.operation.reason,'ready-unconfirmed','a foreign listener cannot establish host/client readiness')

// Both verified transport and matching host/client receipts are required.
const newHostReady = await runHelperScenario({ foreignPath: targetExe, foreignListener: false, startNewHost: true })
assert(newHostReady.notes.some((line) => line.includes('acknowledged recovery on port 19001')), 'nonce-bound host and client acknowledge the verified transport')
assert.equal(newHostReady.launchEnvs[0].DSH_DESKTOP_RESTART_ID, 'restart-test-123', 'handoff nonce reaches the new host environment')
assert.equal(newHostReady.launchEnvs[0].ELECTRON_RUN_AS_NODE, undefined, 'Node mode is still removed')

const listenerWithoutReceipt=await runHelperScenario({foreignListener:false,startNewHost:true,acknowledgeRecovery:false})
assert.equal(listenerWithoutReceipt.operation.result,'unknown')
assert.equal(listenerWithoutReceipt.operation.reason,'ready-unconfirmed','an inspector-only listener is not success')

// 2026-11-03 issue #4：真机 06:38 那次重启成功，但 netstat 里没匹配到新宿主的
// 监听项，旧逻辑等到超时判 unknown/ready-unconfirmed，用户看到「结果未知」。
// 回执（nonce + readyHostPid + 时间序）已经证明新宿主起来了、客户端连上了，
// 端口只是佐证：缺端口应当判成功，并把「未取得端口」如实记进 reason。
const readyWithoutPort = await runHelperScenario({ foreignListener: false, startNewHost: true, newHostListener: false })
assert.equal(readyWithoutPort.operation.result, 'ok', 'issue #4: 回执齐全但缺端口时必须判成功，不能报未知')
assert.equal(readyWithoutPort.operation.reason, 'ready-without-port', 'issue #4: 缺端口要如实记录原因码')
assert.equal(readyWithoutPort.operation.readyPort, null, 'issue #4: 不得伪造 readyPort')
assert(readyWithoutPort.notes.some((line) => line.includes('restart complete without a port')), 'issue #4: 日志要说明「完成但无端口」')
const exitedBeforeKill=await runHelperScenario({foreignListener:false,startNewHost:true,disappearBeforeKill:true})
assert.equal(exitedBeforeKill.operation.result,'ok')
assert.ok(!exitedBeforeKill.killed.includes(100),'an already-exited main does not require taskkill')

// 2026-11-03 真机第二次：新宿主回执已经落盘，但轮询里因为进程表整表作废而
// 建不出进程树 → 回执从来没被读到 → 判成结果未知（日志：判定 08:43:54.908，
// clientReadyAt 08:43:54.461，只差 60ms）。关闸后必须补读一次回执。
const lateReceipt = await runHelperScenario({
  foreignListener: false,
  startNewHost: true,
  incompleteNewHostRow: true,
})
assert.equal(lateReceipt.operation.result, 'ok', '回执已在盘上、只是轮询读不到时必须判成功，不能报未知')
assert.equal(lateReceipt.operation.reason, 'ready-without-port')
assert(lateReceipt.notes.some((line) => line.includes('readiness receipt appeared after the wait window closed')), '日志要说明回执是关闸后补读到的')

const operationWriteFailure = await runHelperScenario({ foreignListener: false, failOperationWrite: true })
assert.deepEqual(operationWriteFailure.killed, [], 'helper refuses to stop processes when operation state cannot be persisted')
assert(operationWriteFailure.notes.some((line) => line.includes('operation state could not be persisted')), 'helper reports the fail-closed state write error')
const identityWriteFailure = await runHelperScenario({ foreignListener: false, failIdentityWrite: true })
assert.deepEqual(identityWriteFailure.killed, [], 'helper refuses to stop processes when verified identity cannot be persisted')
assert(identityWriteFailure.notes.some((line) => line.includes('verified helper identity could not be persisted')), 'helper reports the identity write failure')
const incompleteCim = await runHelperScenario({ foreignListener: false, incompleteCim: true })
assert.equal(incompleteCim.cimReadResult, null, 'incomplete CIM rows are a failed query, not an empty process table')
assert.deepEqual(incompleteCim.killed, [], 'partial CIM results do not prove process ownership')
assert(incompleteCim.notes.some((line) => line.includes('process ancestry, executable path, or creation time could not prove')), 'partial CIM results abort before process termination')

const fixture = mkdtempSync(join(tmpdir(), 'dsh-engine-safe-'))
try {
  const tempRoot = join(fixture, 'Temp')
  const active = join(tempRoot, 'dsh-workspace-changes-active')
  mkdirSync(join(active, 'objects'), { recursive: true })
  const existingObject = join(active, 'objects', 'item.bin')
  writeFileSync(existingObject, 'old content')
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  utimesSync(active, old, old)
  utimesSync(existingObject, old, old)
  const rootMtimeBefore = lstatSync(active).mtimeMs
  const startedAtMs = Date.now() - 60_000
  writeFileSync(existingObject, 'rewritten after this host started')
  const recent = new Date()
  utimesSync(existingObject, recent, recent)
  const rootMtimeAfter = lstatSync(active).mtimeMs
  assert.equal(rootMtimeAfter, rootMtimeBefore, 'overwriting an existing child file leaves root mtime unchanged')

  const preview = await sweepOrphanSnapshots({
    tempRoot,
    startedAtMs,
    minAgeMs: 0,
    statOf: async (target) => {
      const info = await import('node:fs/promises').then((fs) => fs.stat(target))
      if (target !== active) return info
      return { isDirectory: () => true, birthtimeMs: old.getTime(), ctimeMs: old.getTime(), mtimeMs: rootMtimeAfter }
    },
  })
  assert.deepEqual(preview.removed, [], 'snapshot scanning is always preview-only')
  assert.equal(preview.candidates.length, 0, 'recent child content write excludes active tree')
  assert.equal(preview.skipReason, 'preview-only', 'unknown owners are reported')

  const oldCandidate = join(tempRoot, 'dsh-workspace-changes-old')
  mkdirSync(oldCandidate)
  const oldCreated = Date.now() - 30 * 24 * 60 * 60 * 1000
  const stats = await import('node:fs/promises')
  const realStat = await stats.stat(oldCandidate)
  const ownerUnknown = await sweepOrphanSnapshots({
    tempRoot,
    startedAtMs: Date.now() + 60_000,
    minAgeMs: 0,
    statOf: async (target) => {
      const info = await stats.stat(target)
      return target === oldCandidate
        ? { ...info, birthtimeMs: oldCreated, ctimeMs: oldCreated, mtimeMs: oldCreated }
        : info
    },
  })
  assert(ownerUnknown.candidates.some((entry) => entry.name === basename(oldCandidate)), 'old directory appears in preview')
  assert(ownerUnknown.skipped.some((entry) => entry.name === basename(oldCandidate) && entry.reason === 'preview-only'), 'preview explains why candidates remain')
  assert.equal(ownerUnknown.removed.length, 0, 'preview never deletes')
  assert.equal(realStat.isDirectory(), true)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}


if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '2') {
  const api = createRequire(import.meta.url)('../lib/helper.cjs')
  assert.equal(typeof api.createNoticeStore, 'function', '4B-2: durable toast/diagnostic store must be available')
  const memory = new Map(), sent = []
  const io = {
    mkdirSync() {},
    statSync(file) {if(memory.has(file)) return {mtimeMs:0,ctimeMs:0,size:Buffer.byteLength(memory.get(file))};if(file==='E:\\fixture-notices') return {mtimeMs:memory.size,ctimeMs:memory.size,size:0};const e=new Error('missing');e.code='ENOENT';throw e},
    writeFileSync(file, value, options) { if(options?.flag === 'wx' && memory.has(file)) { const e = new Error('exists'); e.code='EEXIST'; throw e }; memory.set(file,String(value)) },
    readFileSync(file) { if(!memory.has(file)) throw new Error('missing'); return memory.get(file) },
    readdirSync(dir) { return [...memory.keys()].filter(k=>win32.dirname(k)===dir).map(k=>win32.basename(k)) },
    existsSync(file) { return memory.has(file) },
  }
  const store = api.createNoticeStore({ dir:'E:\\fixture-notices', profileId:'profile-A', io, send(record, paths) { sent.push({record,paths}); return {status:'failed',code:'notifications-disabled'} } })
  const operation = { id:'op-fixture', result:'failed', reason:'stop-failed', phase:'stop', commandLine:'secret-token', path:'C:\\private\\app.exe', stages:{stop:35}, busy:true }
  store.ensure(operation); store.ensure(operation)
  assert.equal(sent.length,1,'one failed operation submits once')
  assert.equal(store.list().length,1,'one durable failure record')
  assert.equal(store.list()[0].unread,true)
  assert.equal(store.list()[0].delivery.status,'failed')
  const raw = [...memory.values()].join('\n')
  assert.doesNotMatch(raw,/secret-token|private|commandLine/u,'persisted public diagnostics must be redacted')
  assert.match(raw,/stop-failed/u)
  const id=store.list()[0].id
  const recordPath=sent[0].paths.record
  const preserved=memory.get(recordPath)
  assert.equal(store.markRead(id),true)
  assert.equal(store.list()[0].unread,false)
  store.ensure(operation)
  assert.equal(sent.length,1,'read records never notify again')
  assert.equal(memory.get(recordPath),preserved,'read must not delete or change diagnostic record')
  assert.equal(operation.busy,true,'read must not release the operation')
  store.ensure({...operation,result:'unknown',reason:'ready-unverifiable'})
  store.ensure({...operation,result:'unknown',reason:'ready-unverifiable'})
  assert.equal(sent.length,2,'unknown result also submits once')
  const reopened=api.createNoticeStore({dir:'E:\\fixture-notices',profileId:'profile-A',io,send(){throw new Error('duplicate toast forbidden')}})
  reopened.ensure(operation)
  assert.equal(reopened.list().filter(n=>n.unread).length,1,'unread survives reopening; read failure does not remind again')
  const scripts=api.toastScript({summary:'重启未成功（stop-failed）',title:'DSH',id:'op-fixture'},'E:\\fixture-notices\\diagnostic.html','E:\\fixture-notices\\delivery.json')
  assert.match(scripts,/Windows.UI.Notifications/u)
  assert.doesNotMatch(scripts,/MessageBox|performRestart|taskkill|followup|inject/u)
  assert.match(scripts,/UseShellExecute/u,'activation only opens the saved diagnostic document')
  for (const scenario of [{incompleteCim:true},{foreignListener:false,startNewHost:false}]) {
    const actual=await runHelperScenario({...scenario,notifications:true})
    assert.equal(actual.noticesSent.length,1,'real helper entry dispatches one toast for failed/unknown outcome')
    assert.equal(actual.noticeRecords.length,1,'helper saves one durable diagnosis')
    assert.doesNotMatch(JSON.stringify(actual.noticeRecords),/Program Files|user-data-dir|commandLine/u)
  }
  console.log('PASS 4B-2 one toast per outcome; durable unread; read preserves diagnosis and lock; redacted details; diagnostic-only click')
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '3') {
  const root=mkdtempSync(join(tmpdir(),'dshdr4b-cancel-'))
  try {
    const candidate=join(root,'dsh-workspace-changes-cancel');mkdirSync(candidate)
    for(let i=0;i<10;i++) writeFileSync(join(candidate,'fixture-'+i+'.txt'),'test')
    let polls=0
    const result=await sweepOrphanSnapshots({tempRoot:root,startedAtMs:Date.now()+60_000,minAgeMs:0,shouldStop:()=>++polls>=3,statOf:async()=>({isDirectory:()=>true,birthtimeMs:1,mtimeMs:1})})
    assert.equal(result.partial,true,'4B-3: cancellation must be observed inside recursive inspection')
    assert.equal(result.removed.length,0)
    const stopped=polls;await new Promise(resolve=>setImmediate(resolve));assert.equal(polls,stopped,'no traversal continues after cancellation settles')
    assert.ok(polls<=4,'cancellation should stop before the ten children are traversed')
  } finally {rmSync(root,{recursive:true,force:true})}
  console.log('PASS 4B-3 recursive cancellation returns partial, stops traversal and removes nothing')
}

if (!process.env.DSHDR4C_CASE || process.env.DSHDR4C_CASE === 'A') {
  const io=await import('node:fs')
  const {createNoticeStore}=createRequire(import.meta.url)('../lib/helper.cjs')
  const dir=mkdtempSync(join(tmpdir(),'dshdr4c-retention-'))
  const profileId='retention-fixture', prefix='notice-'+profileId+'-'
  const seed=(name,at,read)=>{
    const id=prefix+name+'-failed'
    writeFileSync(join(dir,id+'.json'),JSON.stringify({schema:1,id,profileId,result:'failed',reason:'stop-failed',summary:'fixture',at,details:{reason:'stop-failed'}}))
    writeFileSync(join(dir,id+'.html'),'fixture diagnostic')
    writeFileSync(join(dir,id+'.delivery'),JSON.stringify({status:'submitted',code:'visibility-unconfirmed'}))
    if(read) writeFileSync(join(dir,id+'.read'),'{}')
    return id
  }
  try {
    const readIds=Array.from({length:60},(_,i)=>seed('read-'+String(i).padStart(2,'0'),new Date(Date.UTC(2026,9,1,0,i)).toISOString(),true))
    const unreadIds=Array.from({length:3},(_,i)=>seed('unread-'+i,new Date(Date.UTC(2020,0,1,0,i)).toISOString(),false))
    const store=createNoticeStore({dir,profileId,send(){throw new Error('no real notifications')}})
    assert.equal(store.list().length,63)
    assert.equal(store.markRead(readIds[59]),true)
    let records=store.list()
    assert.equal(records.filter(n=>!n.unread).length,50,'4C-A: retain only the newest fifty read records')
    assert.equal(records.filter(n=>n.unread).length,3,'all unread records survive regardless of age')
    assert.deepEqual(records.filter(n=>!n.unread).map(n=>n.id),readIds.slice(10).reverse())
    for(const id of readIds.slice(0,10)) for(const suffix of ['json','html','delivery','read']) assert.equal(io.existsSync(join(dir,id+'.'+suffix)),false,'all four files retire as a group')
    for(const file of io.readdirSync(dir)) if(file.startsWith(prefix)) assert.ok(io.existsSync(join(dir,file.replace(/\.(?:html|delivery|read)$/u,'.json'))),'no orphan siblings remain after cleanup')
    writeFileSync(join(dir,prefix+'orphan-failed.html'),'partial removal residue')
    assert.doesNotThrow(()=>store.list(),'html-only residue must not break listing')
    io.unlinkSync(join(dir,unreadIds[0]+'.delivery'))
    assert.equal(store.list().find(n=>n.id===unreadIds[0]).delivery.code,'visibility-unconfirmed')
    io.unlinkSync(join(dir,readIds[59]+'.read'))
    assert.equal(store.list().find(n=>n.id===readIds[59]).unread,true,'a missing read marker is immediately unread')
    for(let i=0;i<12;i++) seed('extra-'+i,new Date(Date.UTC(2027,0,1,0,i)).toISOString(),true)
    assert.equal(store.list().filter(n=>!n.unread).length,61,'listing alone must not prune records')
    store.ensure({id:'new-diagnostic',result:'failed',reason:'stop-failed'})
    assert.equal(store.list().filter(n=>!n.unread).length,50,'creating a new notice also prunes read records')
    assert.ok(io.existsSync(join(dir,readIds[59]+'.json')),'unread record is never selected for retirement')
    for(let i=0;i<12;i++) seed('delivery-error-'+i,new Date(Date.UTC(2028,0,1,0,i)).toISOString(),true)
    const deliveryFailure=createNoticeStore({dir,profileId,io:{...io,writeFileSync(file,...args){if(String(file).endsWith('.delivery')) throw new Error('fixture delivery write failed');return io.writeFileSync(file,...args)}},send(){throw new Error('no notifications')}})
    assert.equal(deliveryFailure.ensure({id:'failed-delivery',result:'failed',reason:'stop-failed'}).code,'notice-delivery-write-failed')
    assert.equal(deliveryFailure.list().filter(n=>!n.unread).length,50,'new record cleanup still runs when delivery recording fails')
    const raced=unreadIds[1]
    const concurrent=createNoticeStore({dir,profileId,io:{...io,readFileSync(file,...args){if(String(file)===join(dir,raced+'.json') && io.existsSync(file)) io.unlinkSync(file);return io.readFileSync(file,...args)}},send(){throw new Error('no notifications')}})
    assert.doesNotThrow(()=>concurrent.list(),'record disappearing between enumeration and read is skipped')
    console.log('PASS 4C-A 60 read + 3 unread -> 50 read + 3 unread; four-file retirement; partial deletion tolerated; unread protected')
  } finally {rmSync(dir,{recursive:true,force:true})}
}
console.log(JSON.stringify({
  helper: {
    sameExeOtherProfileKilled: sameExeOtherProfile.killed,
    otherInstallKilled: otherInstall.killed,
    foreignListenerAccepted: foreignListenerOnly.notes.some((line) => line.includes('restart complete')),
    newHostAndClientAcknowledged: newHostReady.notes.some((line) => line.includes('acknowledged recovery on port 19001')),
    operationWriteFailureStoppedNoProcesses: operationWriteFailure.killed.length === 0,
    identityWriteFailureStoppedNoProcesses: identityWriteFailure.killed.length === 0,
    incompleteCimQueryFailsClosed: incompleteCim.cimReadResult === null && incompleteCim.killed.length === 0,
  },
  sweep: {
    activeChildRewriteKeptRootMtime: true,
    recursiveChildMtimeExcludedActiveTree: true,
    snapshotPreviewOnly: true,
    snapshotPreviewNeverDeletes: true,
    minAgeMs: MIN_ORPHAN_AGE_MS,
  },
}, null, 2))

const cookieFailureRun=await runHelperScenario({foreignListener:false,startNewHost:true,authCookieFailure:true})
assert.equal(cookieFailureRun.operation.result,'ok','Cookie DB failure must not stop restart')
assert.equal(cookieFailureRun.cookieHealth.status,'unavailable')
assert.equal(cookieFailureRun.cookieHealth.reason,'database-unavailable')
console.log('PASS AUTH COOKIE: helper continues successful restart after Cookie database failure')
const oldHostSurvives=await runHelperScenario({foreignListener:false,startNewHost:true,authCookieFailure:true,keepOldHost:true})
assert.equal(oldHostSurvives.cookieHealth.reason,'old-instance-running','main absence must not hide the surviving old host')
assert.equal(oldHostSurvives.cookieHealth.cleanup.performed,false)
assert.equal(oldHostSurvives.operation.result,'ok','skip Cookie access and continue restart')
console.log('PASS AUTH COOKIE: surviving old host skips SQLite despite exited main')
await import('./auth-cookie-regression.mjs')

for (const opReadError of ['EACCES','json']) {
  const r=await runHelperScenario({opReadError,withLock:true})
  assert.equal(r.killed.length,0)
  assert.equal(r.launchEnvs.length,0)
  assert.equal(r.rawOp,opReadError === 'json' ? '{broken json' : r.originalOp)
  assert.ok(r.notes.some(n=>n.includes('original record preserved')))
  assert.equal(r.lockPresent,false)
  console.log('PASS BATCH1-3: '+opReadError+' preserves original bytes; no stop or launch; lock released')
}
const firstOp=await runHelperScenario({missingOp:true,foreignListener:false,startNewHost:true,withLock:true})
assert.equal(firstOp.operation.result,'ok');assert.equal(firstOp.lockPresent,false)
console.log('PASS BATCH1-3: ENOENT creates first operation record; normal restart and lock release succeed')
const failedRecord=await runHelperScenario({badHandoff:true,failOperationWrite:true,withLock:true})
assert.ok(failedRecord.notes.some(n=>n.includes('result could not be persisted: failed/bad-handoff')))
assert.equal(failedRecord.lockPresent,false)
console.log('PASS BATCH1-4 log: '+failedRecord.notes.find(n=>n.includes('result could not be persisted')))
const finalRecord=await runHelperScenario({foreignListener:false,startNewHost:true,finalWriteFailure:true})
assert.ok(finalRecord.notes.some(n=>n.includes('result could not be persisted: ok; restart itself completed')))
assert.ok(finalRecord.notes.some(n=>n.includes('timing could not be persisted')))
assert.ok(finalRecord.killed.includes(100));assert.equal(finalRecord.launchEnvs.length,1)
console.log('PASS BATCH1-4 log: '+finalRecord.notes.find(n=>n.includes('result could not be persisted: ok')))
const abnormal=await runHelperScenario({withLock:true,throwCore:true})
assert.match(abnormal.coreError,/unexpected core failure/);assert.equal(abnormal.lockPresent,false)
console.log('PASS BATCH1-1: unexpected helper exception releases owned lock')

await import('./batch1-lock-regression.mjs')

const privateTransport=await runHelperScenario({foreignListener:false,startNewHost:true,privateExe:true})
assert.equal(privateTransport.operation.result,'ok')
assert.ok(!privateTransport.notes.join(' ').includes(targetExe))
assert.ok(!privateTransport.notes.join(' ').includes('--user-data-dir'))
assert.equal(privateTransport.launchEnvs[0].DSH_DESKTOP_RESTART_EXE,undefined)
console.log('PASS BATCH2-14/15: basename handoff, child-only executable transport, redacted log, no private transport inherited by relaunched app')

await import('./cookie-window-regression.mjs')

const timedCookie=await runHelperScenario({foreignListener:false,startNewHost:true,authCookieFailure:'timeout'})
assert.equal(timedCookie.cookieHealth.reason,'check-timeout')
assert.equal(timedCookie.operation.result,'ok')
assert.equal(timedCookie.launchEnvs.length,1)
assert.ok(timedCookie.notes.findIndex(n=>n.includes('worker terminated'))<timedCookie.notes.findIndex(n=>n.includes('relaunched "')))
console.log('PASS COOKIE BUDGET FLOW: timed-out optional check stops worker before app launch; restart still succeeds')

// 2026-11-02 自检发现的两条「杀完主进程后不拉起」路径；修复后必须有回归覆盖。
const terminateFails=await runHelperScenario({foreignListener:false,startNewHost:true,authCookieFailure:'terminate-fails'})
assert.equal(terminateFails.coreError,null)
assert.equal(terminateFails.launchEnvs.length,1)
assert.equal(terminateFails.operation.result,'ok')
assert.equal(terminateFails.cookieHealth.reason,'check-aborted')
assert.ok(terminateFails.notes.some(n=>n.includes('check aborted')&&n.includes('restart continues')))
assert.ok(terminateFails.notes.findIndex(n=>n.includes('check aborted'))<terminateFails.notes.findIndex(n=>n.includes('relaunched "')))
console.log('PASS COOKIE TERMINATE-REJECT: rejecting terminate can no longer abort the relaunch; unavailable record keeps the last sample contract')

const launchWriteFails=await runHelperScenario({foreignListener:false,startNewHost:true,failLaunchWrite:true})
assert.equal(launchWriteFails.coreError,null)
assert.equal(launchWriteFails.launchEnvs.length,1)
assert.equal(launchWriteFails.operation.result,'ok')
assert.ok(launchWriteFails.notes.some(n=>n.includes('port-wait phase could not be persisted; restart continues')))
console.log('PASS LAUNCH BOOKKEEPING: failing op-record writes after the kill no longer strand the user with a closed app')
