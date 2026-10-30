import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {checkAuthCookiesInWindow} from '../lib/helper.cjs'
const base=process.env.DSHDR_AUTH_ARTIFACT_ROOT||tmpdir()
mkdirSync(base,{recursive:true})
const root=mkdtempSync(join(base,'dshdr-cookie-window-'))
const options={databasePath:join(root,'Cookies'),statePath:join(root,'health.json'),backupDir:join(root,'backups'),backup:true}
const oldSample={checkedAt:'2026-01-01T00:00:00Z',estimatedBytes:400,authCount:1,status:'normal'}
writeFileSync(options.statePath,JSON.stringify({sample:oldSample}))
let instance,exited=false
class HangingWorker extends Worker{
  constructor(){super('setInterval(()=>{},1000)',{eval:true,execArgv:[]});instance=this;this.once('exit',()=>{exited=true})}
}
const timed=await checkAuthCookiesInWindow(options,()=>{},{Worker:HangingWorker,timeoutMs:100})
assert.equal(timed.reason,'check-timeout');assert.equal(timed.cleanup.removed,0)
assert.equal(instance.threadId,-1);assert.equal(exited,true,'worker must exit before helper can proceed')
assert.deepEqual(timed.sample,oldSample)
assert.equal(JSON.parse(readFileSync(options.statePath,'utf8')).reason,'check-timeout')
console.log('PASS COOKIE BUDGET: stuck worker terminated and joined before return; old sample retained; source DB never opened')
class FailedWorker extends Worker{constructor(){super('throw new Error("isolated fixture failure")',{eval:true,execArgv:[]})}}
const failed=await checkAuthCookiesInWindow(options,()=>{},{Worker:FailedWorker,timeoutMs:3000})
assert.equal(failed.reason,'check-worker-failed');assert.deepEqual(failed.sample,oldSample)
class UnavailableWorker{constructor(){throw Object.assign(new Error('no worker'),{code:'ERR_WORKER_INIT_FAILED'})}}
const absent=await checkAuthCookiesInWindow(options,()=>{},{Worker:UnavailableWorker})
assert.equal(absent.errorCode,'ERR_WORKER_INIT_FAILED')
console.log('PASS COOKIE BUDGET: worker crash/init failure records unavailable and returns for relaunch')
let sqlite
try{sqlite=await import('node:sqlite')}catch(error){if(error.code!=='ERR_UNKNOWN_BUILTIN_MODULE')throw error}
if(sqlite&&typeof sqlite.backup==='function'){
  const db=new sqlite.DatabaseSync(options.databasePath)
  db.exec('CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB)')
  db.prepare('INSERT INTO cookies VALUES(?,?,?,?)').run('127.0.0.1','dsh-auth-fixture','test',Buffer.alloc(0));db.close()
  const result=await checkAuthCookiesInWindow(options)
  assert.equal(result.status,'normal');assert.equal(result.sample.authCount,1);assert.equal(result.backup.performed,true)
  assert.equal(readdirSync(options.backupDir).filter(name=>name.endsWith('.partial')).length,0,'only completed backups become restore candidates')
  const original=new sqlite.DatabaseSync(options.databasePath,{readOnly:true})
  assert.equal(original.prepare('SELECT count(*) AS n FROM cookies').get().n,1);original.close()
  const backup=new sqlite.DatabaseSync(join(options.backupDir,result.backup.backupFile),{readOnly:true})
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');backup.close()
  console.log('PASS COOKIE BUDGET: real worker + native SQLite read-only sample/consistent backup complete under default budget; user DB never accessed')
}else console.log('SKIP native worker SQLite sample: runtime lacks sqlite backup')

