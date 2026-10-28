import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { MIN_ORPHAN_AGE_MS, sweepOrphanSnapshots } from '../lib/sweep.js'

const root = dirname(fileURLToPath(import.meta.url))
const helperPath = join(root, '..', 'lib', 'helper.cjs')
const helperSource = readFileSync(helperPath, 'utf8')
const targetExe = 'C:\\DSH\\app.exe'

function makeProcess(pid, parentPid, path, createdAt, commandLine = 'app.exe') {
  return { pid, parentPid, path, createdAt: new Date(createdAt).toISOString(), commandLine }
}

function runHelperScenario({ foreignPath = targetExe, foreignListener = true, startNewHost = false, handoffPort = 18000, failOperationWrite = false, failIdentityWrite = false, incompleteCim = false, legacyHandoff = false, notifications = false }) {
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
  const operationFiles = new Map()
  const opPath = 'C:\\virtual\\desktop-restart\\op-restart-test-123.json'
  operationFiles.set(opPath, JSON.stringify({ id: 'restart-test-123', schema: 1, phase: 'scheduled', result: 'pending', pid: null, hostPid: 101, startedAt: new Date(clock).toISOString(), stages: {} }))
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
        for (const [port, owner] of listeners) if (owner === pid) listeners.delete(port)
        return ''
      }
      if (command === 'powershell.exe' || command === 'pwsh.exe') {
        const rows = [...processes.values()].filter((entry) => win32.basename(entry.path).toLowerCase() === 'app.exe')
        const result = rows.map((entry) => ({
          ProcessId: entry.pid,
          ParentProcessId: entry.parentPid,
          ExecutablePath: entry.path,
          CommandLine: entry.commandLine,
          CreatedAt: entry.createdAt,
        }))
        if (incompleteCim) delete result.find((entry) => entry.ProcessId === 102).CreatedAt
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
          processes.set(301, makeProcess(301, 300, targetExe, launchedAt + 10, '"C:\\DSH\\app.exe" --expose-internals'))
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
    env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_RESTART_ID: 'old' },
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
    if (specifier === 'node:child_process') return childProcess
    if (specifier === 'node:fs') return {
      readFileSync(file) {
        if (!operationFiles.has(String(file))) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error }
        return operationFiles.get(String(file))
      },
      mkdirSync() {},
      statSync(file) {if(operationFiles.has(String(file))) return {mtimeMs:0,ctimeMs:0,size:Buffer.byteLength(operationFiles.get(String(file)))};if(String(file)===win32.dirname(opPath)) return {mtimeMs:operationFiles.size,ctimeMs:operationFiles.size,size:0};const e=new Error('missing');e.code='ENOENT';throw e},
      existsSync: file => operationFiles.has(String(file)),
      readdirSync: dir => [...operationFiles.keys()].filter(file=>win32.dirname(file)===dir).map(file=>win32.basename(file)),
      writeFileSync(file, text, options) {
        if (options?.flag === 'wx' && operationFiles.has(String(file))) {const e=new Error('exists');e.code='EEXIST';throw e}
        if (failOperationWrite || (failIdentityWrite && String(text).includes('"helperIdentity"'))) throw new Error('simulated operation record write failure')
        operationFiles.set(String(file), String(text))
      },
      renameSync(from, to) { operationFiles.set(String(to), operationFiles.get(String(from))); operationFiles.delete(String(from)) },
    }
    if (specifier === 'node:net') return fakeNet
    if (specifier === 'node:path') return win32
    throw new Error(`Unexpected module in fake: ${specifier}`)
  }
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  fakeRequire.main = {}
  vm.runInNewContext(helperSource, {
    require: fakeRequire,
    module,
    exports: module.exports,
    process: fakeProcess,
    Buffer,
    Date: fakeDate,
    Promise,
    setTimeout(callback, ms) { clock += ms; callback(); return { unref() {} } },
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
  // 旧宿主（0.4.4）的交接里没有 opPath —— 真机 2026-10-22 因此死锁过。
  if (legacyHandoff) delete handoff.opPath
  return helperApi.performRestart(handoff, (line) => notes.push(line)).then(() => ({ noticesSent, noticeRecords:[...operationFiles.entries()].filter(([file])=>win32.basename(file).startsWith('notice-') && file.endsWith('.json')).map(([,value])=>JSON.parse(value)), killed, notes, launchEnvs, processes: [...processes.keys()], listeners: [...listeners], operation: legacyHandoff ? null : JSON.parse(operationFiles.get(opPath)), cimReadResult: helperApi.queryApplicationProcesses('app.exe') }))
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
assert(foreignListenerOnly.notes.some((line) => line.includes('its verified host has no listening port')), 'foreign listener is rejected by verified-host readiness filtering')

// A dynamic listener owned by the new main's verified host child is accepted.
const newHostReady = await runHelperScenario({ foreignPath: targetExe, foreignListener: false, startNewHost: true })
assert(newHostReady.notes.some((line) => line.includes('listening on port 19001')), 'new host descendant dynamic port is readiness')
assert.equal(newHostReady.launchEnvs[0].DSH_DESKTOP_RESTART_ID, 'restart-test-123', 'handoff nonce reaches the new host environment')
assert.equal(newHostReady.launchEnvs[0].ELECTRON_RUN_AS_NODE, undefined, 'Node mode is still removed')

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
  assert.deepEqual(preview.removed, [], 'missing owner proof is preview-only')
  assert.equal(preview.candidates.length, 0, 'recent child content write excludes active tree')
  assert.equal(preview.skipReason, 'owner-unknown', 'unknown owners are reported')

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
  assert(ownerUnknown.skipped.some((entry) => entry.name === basename(oldCandidate) && entry.reason === 'owner-unknown'), 'preview explains the owner skip')
  assert.equal(ownerUnknown.removed.length, 0, 'preview never deletes without owner proof')
  const ownerKnown = await sweepOrphanSnapshots({
    tempRoot,
    startedAtMs: Date.now() + 60_000,
    minAgeMs: 0,
    ownerCheck: { known: true, activeHosts: [] },
    statOf: async (target) => {
      const info = await stats.stat(target)
      return target === oldCandidate
        ? { isDirectory: () => true, birthtimeMs: oldCreated, ctimeMs: oldCreated, mtimeMs: oldCreated }
        : info
    },
  })
  assert(ownerKnown.removed.includes(basename(oldCandidate)), 'explicit owner proof enables deletion')
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
    newHostPortAccepted: newHostReady.notes.some((line) => line.includes('listening on port 19001')),
    operationWriteFailureStoppedNoProcesses: operationWriteFailure.killed.length === 0,
    identityWriteFailureStoppedNoProcesses: identityWriteFailure.killed.length === 0,
    incompleteCimQueryFailsClosed: incompleteCim.cimReadResult === null && incompleteCim.killed.length === 0,
  },
  sweep: {
    activeChildRewriteKeptRootMtime: true,
    recursiveChildMtimeExcludedActiveTree: true,
    unknownOwnerPreviewOnly: true,
    explicitEmptyOwnerSetAllowsInternalDelete: true,
    minAgeMs: MIN_ORPHAN_AGE_MS,
  },
}, null, 2))
