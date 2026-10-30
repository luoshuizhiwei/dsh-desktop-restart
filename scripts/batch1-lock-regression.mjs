import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

// Actual separate Node processes and exclusive filesystem creation, isolated DSH_HOME.
const home = mkdtempSync(join(process.env.DSHDR_AUTH_ARTIFACT_ROOT || tmpdir(), 'dshdr-lock-'))
const entry = new URL('../lib/index.js', import.meta.url).href
const program = `
  const {__test:t}=await import(${JSON.stringify(entry)});
  const result=t.acquireRestartLock(process.env.LOCK_TOKEN);
  console.log(JSON.stringify(result));
  if(result.ok){
    if(process.env.LOCK_HOLD==='1')await new Promise(resolve=>process.stdin.once('data',resolve));
    t.releaseRestartLock(process.env.LOCK_TOKEN);
  }
`
const env = {...process.env, DSH_HOME:home, DSH_PROFILE_DIR:join(home,'profile-A'), LOCK_TOKEN:'A', LOCK_HOLD:'1'}
const holder = spawn(process.execPath, ['--input-type=module','-e',program], {env,stdio:['pipe','pipe','pipe'],windowsHide:true})
let stderr=''
holder.stderr.on('data',data=>{stderr+=data})
let first=''
const ready = new Promise((resolve,reject)=>{
  holder.stdout.on('data',data=>{first+=data;if(first.includes('\n'))resolve()})
  holder.on('error',reject)
  holder.on('exit',code=>{if(!first)reject(new Error(`holder exited ${code}: ${stderr}`))})
})
const deadline=setTimeout(()=>holder.kill(),10000)
try {
  await ready
  assert.equal(JSON.parse(first.trim()).ok,true)
  const contender=spawnSync(process.execPath,['--input-type=module','-e',program],{
    env:{...env,DSH_PROFILE_DIR:join(home,'profile-B'),LOCK_TOKEN:'B',LOCK_HOLD:'0'},
    encoding:'utf8',windowsHide:true,timeout:8000,
  })
  assert.equal(contender.status,0,contender.stderr)
  assert.equal(JSON.parse(contender.stdout.trim()).status,409)
  const exited=once(holder,'exit')
  holder.stdin.end('release')
  assert.equal((await exited)[0],0,stderr)
  const lockPath=join(home,'desktop-restart','restart.lock')
  assert.equal(existsSync(lockPath),false)
  writeFileSync(lockPath,JSON.stringify({pid:holder.pid,at:new Date().toISOString(),token:'dead'}))
  const stale=spawnSync(process.execPath,['--input-type=module','-e',program],{
    env:{...env,LOCK_TOKEN:'C',LOCK_HOLD:'0'},encoding:'utf8',windowsHide:true,timeout:8000,
  })
  assert.equal(stale.status,0,stale.stderr)
  assert.equal(JSON.parse(stale.stdout.trim()).stale,true)
  assert.match(stale.stderr,/stale restart lock taken over/u)
  assert.equal(existsSync(lockPath),false)
  console.log('PASS BATCH1-1 native: two independent profile processes, one exclusive lock; contender=409; exited PID takeover logged; release verified')
} finally {
  clearTimeout(deadline)
  if(holder.exitCode===null)holder.stdin.end('release')
}
