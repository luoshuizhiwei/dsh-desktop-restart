import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { authCookieSample, checkAuthCookies } from '../lib/helper.cjs'

// Native isolated SQLite evidence only. Never references the user's Cookie DB.
const base = process.env.DSHDR_AUTH_ARTIFACT_ROOT || tmpdir()
mkdirSync(base, {recursive:true})
const root = mkdtempSync(join(base,'dshdr-auth-cookie-'))
let sqlite
try { sqlite = await import('node:sqlite') }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error }
export const sqliteSummary={suite:'native SQLite Cookie',status:'skipped',passed:0,skipped:1,node:process.version,reason:'node:sqlite + backup unavailable; requires Node >=22.16.0'}
if (!sqlite || typeof sqlite.backup !== 'function') console.log('SKIP native Cookie fixtures: node:sqlite + backup unavailable; requires Node >=22.16.0')
else {
  const {DatabaseSync} = sqlite
  const readonlySqlite=()=>({...sqlite,DatabaseSync:class extends DatabaseSync {constructor(file,options){assert.equal(options.readOnly,true);super(file,options)}}})
  const databasePath = join(root,'Cookies')
  const statePath = join(root,'health.json')
  const backupDir = join(root,'backups')
  let db=new DatabaseSync(databasePath)
  db.exec('CREATE TABLE cookies(host_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL)')
  const insert=db.prepare('INSERT INTO cookies VALUES (?,?,?,?)')
  for(let i=0;i<60;i++) insert.run('127.0.0.1','dsh-auth-'+String(i).padStart(43,'0'),'v'.repeat(173),Buffer.alloc(0))
  const sample=authCookieSample(db)
  assert.equal(sample.authCount,60)
  assert.equal(sample.estimatedBytes,14028)
  assert.ok(sample.estimatedBytes>=13878 && sample.estimatedBytes<=14178)
  assert.equal(sample.status,'near')
  console.log('AUTH COOKIE estimate: 60 records = 14028 bytes (85.62%); near; no decryption')
  // Isolate exact boundaries with a known 1-byte name and a variable plain value.
  const boundary=new DatabaseSync(':memory:')
  boundary.exec('CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB)')
  for(const [bytes,status] of [[13107,'normal'],[13108,'near'],[16384,'near'],[16385,'exceeded']]) {
    boundary.exec('DELETE FROM cookies')
    boundary.prepare('INSERT INTO cookies VALUES (?,?,?,?)').run('127.0.0.1','a','x'.repeat(bytes-352),Buffer.alloc(0))
    assert.equal(authCookieSample(boundary).status,status)
  }
  boundary.close()
  insert.run('127.0.0.1','other-cookie','keep',Buffer.alloc(0))
  insert.run('elsewhere.example','dsh-auth-foreign','keep',Buffer.alloc(0))
  insert.run('127.0.0.1','DSH-auth-not-ours','keep',Buffer.alloc(0))
  db.close()
  const options={databasePath,statePath,backupDir,clean:false}
  const first=await checkAuthCookies(options,()=>{},readonlySqlite)
  assert.equal(first.cleanup.performed,false);assert.equal(first.sample.authCount,60)
  assert.equal(JSON.parse(readFileSync(statePath,'utf8')).sample.authCount,60)
  const legacy=await checkAuthCookies({...options,clean:true})
  assert.equal(legacy.cleanup.removed,0);assert.equal(legacy.sample.authCount,60)
  const cleaned=await checkAuthCookies({...options,backup:true})
  assert.equal(cleaned.backup.performed,true);assert.equal(cleaned.cleanup.removed,0);assert.equal(cleaned.sample.authCount,60)
  db=new DatabaseSync(databasePath)
  assert.equal(db.prepare('SELECT count(*) AS n FROM cookies').get().n,63)
  db.close()
  const backup=new DatabaseSync(join(backupDir,cleaned.backup.backupFile),{readOnly:true})
  assert.equal(backup.prepare("SELECT count(*) AS n FROM cookies WHERE host_key='127.0.0.1' AND name GLOB 'dsh-auth-*'").get().n,60)
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');backup.close()
  for(let i=0;i<3;i++) {
    db=new DatabaseSync(databasePath);db.prepare('INSERT INTO cookies VALUES (?,?,?,?)').run('127.0.0.1','dsh-auth-new-'+i,'new',Buffer.alloc(0));db.close()
    assert.equal((await checkAuthCookies({...options,backup:true})).backup.performed,true)
  }
  assert.equal(readdirSync(backupDir).filter(n=>n.endsWith('.sqlite')).length,3)
  console.log('AUTH COOKIE clean: no Cookies removed, including legacy clean:true; all 63 rows intact; native backup valid; retained=3')
  // Backup failure never mutates the source.
  db=new DatabaseSync(databasePath);db.prepare('INSERT INTO cookies VALUES (?,?,?,?)').run('127.0.0.1','dsh-auth-protected','new',Buffer.alloc(0));db.close()
  const badBackup=join(root,'not-a-directory');writeFileSync(badBackup,'protected file')
  const failed=await checkAuthCookies({...options,backup:true,backupDir:badBackup})
  assert.equal(failed.status,'unavailable');assert.equal(failed.reason,'backup-failed');assert.equal(failed.cleanup.performed,false)
  db=new DatabaseSync(databasePath);assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE name='dsh-auth-protected'").get().n,1);db.close()
  // Real SQLite exclusive lock on an ISOLATED fixture, never on a user database.
  const locker=new DatabaseSync(databasePath)
  locker.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE')
  const locked=await checkAuthCookies({...options,clean:true})
  assert.equal(locked.status,'unavailable');assert.equal(locked.reason,'database-unavailable');assert.equal(locked.cleanup.performed,false)
  locker.exec('ROLLBACK');locker.close()
  // 2026-11-10：新增的「重启时清理旧登录令牌」——只在显式 pruneStale 时删，
  // 只删 127.0.0.1 上多余的 dsh-auth-*（保留最新 3 条），其它 Cookie 一个不动。
  // 此处数据库里有 64 条认证 Cookie（60 + new-0..2 + protected）。
  const pruned=await checkAuthCookies({...options,pruneStale:true},()=>{},()=>sqlite)
  assert.equal(pruned.backup.performed,true,'prune forces a backup even when backup is off (R01)')
  assert.equal(pruned.backup.forcedByPrune,true,'the backup exists because pruning needs it')
  assert.equal(pruned.cleanup.enabled,true)
  assert.equal(pruned.cleanup.performed,true,'prune runs in the downtime window')
  assert.equal(pruned.cleanup.removed,61,'64 auth cookies → keep newest 3, remove 61')
  assert.equal(pruned.cleanup.afterAuthCount,3)
  assert.equal(pruned.sample.authCount,3,'sample after prune reflects the real size')
  db=new DatabaseSync(databasePath)
  assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE name='other-cookie'").get().n,1,'unrelated Cookie untouched')
  assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE name='dsh-auth-foreign'").get().n,1,'other host untouched')
  assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE name='DSH-auth-not-ours'").get().n,1,'case-variant name untouched')
  assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE host_key='127.0.0.1' AND name LIKE 'dsh-auth-%' AND substr(name,1,9)='dsh-auth-'").get().n,3)
  db.close()
  // 没有新增条目时再跑一次：不报错、不删。
  const again=await checkAuthCookies({...options,pruneStale:true},()=>{},()=>sqlite)
  assert.equal(again.cleanup.performed,true);assert.equal(again.cleanup.removed,0,'idempotent when already pruned')
  // 2026-11-10 审查 R02：删除中途失败必须整体回滚，不能删掉一部分还报 0 条。
  db=new DatabaseSync(databasePath)
  for(let i=0;i<5;i++) db.prepare('INSERT INTO cookies VALUES (?,?,?,?)').run('127.0.0.1','dsh-auth-block-'+i,'v',Buffer.alloc(0))
  db.exec("CREATE TRIGGER dshdr_block BEFORE DELETE ON cookies BEGIN SELECT RAISE(ABORT,'blocked-for-test'); END")
  const blockedCountBefore=db.prepare("SELECT count(*) AS n FROM cookies").get().n
  db.close()
  const partial=await checkAuthCookies({...options,pruneStale:true},()=>{},()=>sqlite)
  assert.equal(partial.cleanup.performed,false,'a failed delete is not reported as success')
  db=new DatabaseSync(databasePath)
  assert.equal(db.prepare('SELECT count(*) AS n FROM cookies').get().n,blockedCountBefore,'rollback leaves every row intact')
  db.exec('DROP TRIGGER dshdr_block')
  db.close()
  // 2026-11-10 审查 R05：真实库有 creation_utc；构造 rowid 与创建时间相反的数据，
  // 断言按创建时间保留最新 3 条，而不是按 rowid。
  const skewPath=join(root,'skew')
  mkdirSync(skewPath,{recursive:true})
  const skewDbPath=join(skewPath,'Cookies')
  const skewDb=new DatabaseSync(skewDbPath)
  skewDb.exec('CREATE TABLE cookies(creation_utc INTEGER,host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB)')
  const skewInsert=skewDb.prepare('INSERT INTO cookies VALUES (?,?,?,?,?)')
  // rowid 1..5，creation_utc 依次递减：rowid 最大的反而是最旧的令牌。
  for(let i=0;i<5;i++) skewInsert.run(String(1000-i),'127.0.0.1','dsh-auth-skew-'+i,'v',Buffer.alloc(0))
  skewDb.close()
  const skewOptions={databasePath:skewDbPath,statePath:join(skewPath,'health.json'),backupDir:join(skewPath,'backups'),pruneStale:true}
  const skew=await checkAuthCookies(skewOptions,()=>{},()=>sqlite)
  assert.equal(skew.cleanup.performed,true)
  assert.equal(skew.cleanup.removed,2,'five rows → keep newest 3 by creation time')
  const skewAfter=new DatabaseSync(skewDbPath)
  const keptNames=skewAfter.prepare("SELECT name FROM cookies WHERE host_key='127.0.0.1' AND name LIKE 'dsh-auth-%' ORDER BY name").all().map(r=>r.name)
  skewAfter.close()
  assert.deepEqual(keptNames,['dsh-auth-skew-0','dsh-auth-skew-1','dsh-auth-skew-2'],'newest creation_utc wins, not rowid')
  console.log('AUTH COOKIE prune: sorts by creation_utc when rowid order is reversed')

  // 备份失败时绝不清理（宁可不删）。
  const skipOnBackupFailure=await checkAuthCookies({...options,pruneStale:true,backup:true,backupDir:badBackup},()=>{},()=>sqlite)
  assert.equal(skipOnBackupFailure.status,'unavailable')
  assert.equal(skipOnBackupFailure.cleanup.performed,false,'no prune without a successful backup')
  console.log('AUTH COOKIE prune: keeps newest 3, removes 61, other rows untouched, idempotent, skipped on backup failure')
  let opened=false
  const blocked=await checkAuthCookies({...options,blocked:true},()=>{},()=>{opened=true;throw new Error('must not load SQLite')})
  assert.equal(opened,false);assert.equal(blocked.reason,'old-instance-running')
  const unavailable=await checkAuthCookies(options,()=>{},()=>{const e=new Error('unsupported builtin');e.code='ERR_UNKNOWN_BUILTIN_MODULE';throw e})
  assert.equal(unavailable.reason,'sqlite-unavailable');assert.equal(unavailable.cleanup.performed,false)
  console.log('AUTH COOKIE failures: exclusive fixture lock/backup failure/old instance/old Node skip safely; no deletion')
  console.log('AUTH COOKIE native fixtures passed: '+root)
  Object.assign(sqliteSummary,{status:'passed',passed:1,skipped:0,reason:null})
}

console.log("SUITE SUMMARY "+JSON.stringify(sqliteSummary))
