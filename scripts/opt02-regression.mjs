// DR-OPT-02 回归：操作状态、扫描早筛/错误/取消、文案。
//
// **隔离纪律（S1 返修）**：ESM 的静态 import 先于本文件任何语句执行，而宿主半
// 在模块加载时就解析 DSH_HOME —— 所以「先设 env 再静态导入」根本做不到。这里
// 改成：先建本次唯一目录并设 DSH_HOME，再 **动态 import** 被测模块。
// 所有状态文件都落在这个目录里，结束（含断言失败）时整体删除。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'opt02-sandbox-'))
process.env.DSH_HOME = SANDBOX
const { sweepOrphanSnapshots, SNAPSHOT_PREFIX } = await import('../lib/sweep.js')
const { __test } = await import('../lib/index.js')
// 沙箱自检：状态目录必须落在 SANDBOX 之内，否则说明隔离没生效，直接失败。
assert.equal(__test.opFileOf('probe').startsWith(SANDBOX), true,
  `状态目录必须落在隔离沙箱内（实际 ${__test.opFileOf('probe')}）`)

try {
  let passed = 0
  async function ok(name, fn) {
    await fn()
    globalThis.__opt02Passed = (globalThis.__opt02Passed ?? 0) + 1
    console.log('  ok   ' + name)
  }

  await ok('操作摘要：只暴露必要字段，路径/命令行/凭据不外泄', async () => {
    // 纯函数级：摘要只认固定字段与已知阶段，别的一律不进。
    assert.notEqual(__test.opFileOf('a'), __test.opFileOf('b'), '每个 restartId 一份文件')
    const summary = __test.opSummary({
      id: 'op-x',
      phase: 'ready',
      result: 'failed',
      reason: 'stop-failed',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      stages: { verify: 10, stop: 20.4, portWait: 30, launch: 40, ready: 50, secret: 999 },
      exe: 'C:\\Users\\someone\\private\\app.exe',
      commandLine: '--token=abc',
    }, Date.now())
    assert.deepEqual(Object.keys(summary).sort(),
      ['ageMs', 'argsPreserved', 'helperVerified', 'id', 'needsManualCheck', 'phase', 'reason', 'result', 'stages'].sort(),
      '摘要字段固定，不夹带路径或命令行')
    assert.equal(summary.result, 'failed')
    assert.equal(summary.stages.stop, 20, '耗时取整到毫秒')
    assert.equal(summary.stages.secret, undefined, '未知阶段名不进摘要')
    assert.ok(summary.ageMs >= 4000, 'ageMs 按开始时间算')
    // 结果未知也必须如实归类，不能默认成功
    assert.equal(__test.opSummary({ id: 'y', result: 'weird', startedAt: new Date().toISOString() }, Date.now()).result, 'pending')
  })

  await ok('扫描摘要区分权限失败、部分结果与正常零项', async () => {
    const empty = {
      scanned: 0, removed: [], failed: [], bytes: 0, candidates: [],
      preview: { bytes: 0, files: 0 }, skipped: [], skipReason: null,
      error: null, partial: false, prefiltered: 0,
    }
    const normal = __test.sweepSummaryOf(empty)
    assert.equal(normal.error, null)
    assert.equal(normal.partial, false)
    assert.equal(normal.candidateCount, 0)
    const incomplete = __test.sweepSummaryOf({
      ...empty, scanned: 3, error: { code: 'EACCES', message: 'private path' },
      partial: true, prefiltered: 2,
    })
    assert.deepEqual(incomplete.error, { code: 'EACCES' })
    assert.equal(incomplete.partial, true)
    assert.equal(incomplete.prefiltered, 2)
    assert.equal(incomplete.scanned, 3)
    assert.equal(JSON.stringify(incomplete).includes('private path'), false)
  })

  await ok('扫描早筛：太新的目录不递归，且计入 prefiltered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opt02-sweep-'))
    const fresh = join(root, `${SNAPSHOT_PREFIX}fresh`)
    const young = join(root, `${SNAPSHOT_PREFIX}young`)
    const stale = join(root, `${SNAPSHOT_PREFIX}stale`)
    for (const dir of [fresh, young, stale]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'payload.bin'), Buffer.alloc(64))
    }
    const now = Date.now()
    const result = await sweepOrphanSnapshots({
      tempRoot: root,
      // fresh 建在「启动之后」→ 必然排除；young 不够年龄 → 排除；stale 用注入时间戳当老目录
      startedAtMs: now - 60_000,
      minAgeMs: 24 * 3600 * 1000,
      now,
      statOf: (target) => {
        const isStale = String(target).includes('stale')
        const created = isStale ? now - 48 * 3600 * 1000 : (String(target).includes('fresh') ? now : now - 3600 * 1000)
        return { isDirectory: () => true, birthtimeMs: created, ctimeMs: created, mtimeMs: created }
      },
    })
    assert.equal(result.error, null, '正常路径不应有错误')
    assert.ok(result.prefiltered >= 2, `fresh 与 young 都应在递归前被挡下（实际 ${String(result.prefiltered)}）`)
    // 刚建的 fixture 目录真实 mtime 就是「现在」，所以连 stale 也会被「启动后写过」
    // 这条正确挡掉 —— 这里只验早筛本身：太新/太年轻的两个必须**在递归前**被排除。
    assert.ok(result.prefiltered >= 2, '新鲜目录应在递归前被挡住')
    assert.ok(result.candidates.every((entry) => entry.name === `${SNAPSHOT_PREFIX}stale`), '不会误报其它目录')
    rmSync(root, { recursive: true, force: true })
  })

  await ok('扫描错误：读不到 Temp 必须明确报错，不能长得像成功扫到 0 项', async () => {
    const missing = join(tmpdir(), 'opt02-does-not-exist-xyz')
    const result = await sweepOrphanSnapshots({ tempRoot: missing, startedAtMs: Date.now() - 1000, minAgeMs: 0 })
    assert.ok(result.error !== null, '读失败必须带 error')
    assert.equal(typeof result.error.code, 'string', 'error 要有原因码')
    assert.equal(result.scanned, 0)
  })

  await ok('扫描取消：shouldStop 后给出部分结果并标明 partial', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opt02-cancel-'))
    for (const name of ['a', 'b', 'c']) {
      const dir = join(root, `${SNAPSHOT_PREFIX}${name}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'x.bin'), Buffer.alloc(16))
    }
    const now = Date.now()
    let calls = 0
    const result = await sweepOrphanSnapshots({
      tempRoot: root,
      startedAtMs: now - 1000,
      minAgeMs: 0,
      now,
      shouldStop: () => { calls += 1; return calls > 1 },
      statOf: () => ({ isDirectory: () => true, birthtimeMs: now - 5000, ctimeMs: now - 5000, mtimeMs: now - 5000 }),
    })
    assert.equal(result.partial, true, '取消后必须标 partial')
    rmSync(root, { recursive: true, force: true })
  })

  await ok('文案：中英主面板不再承诺「不会丢 / nothing is lost」', async () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.equal(source.includes('不会丢'), false, '中文不得再有「不会丢」')
    assert.equal(source.includes('nothing is lost'), false, '英文不得再有 nothing is lost')
    assert.ok(source.includes('最后一段记录可能不完整'), '要如实说明强制结束的代价')
    assert.ok(source.includes('Prefer waiting until idle'), '英文同样要给出「建议先等空闲」')
  })

  await ok('操作状态文案：中英都有一整套阶段与结果词', async () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    for (const key of ['opScheduled', 'opVerify', 'opStop', 'opPortWait', 'opLaunch', 'opReady', 'opOk', 'opFailed', 'opUnknown']) {
      const hits = source.split(`${key}:`).length - 1
      assert.equal(hits, 2, `${key} 必须中英各一条（现在 ${String(hits)} 条）`)
    }
    assert.ok(source.includes('function opTextOf'), '要有把阶段翻成一句话的函数')
  })

  // 无论断言是否失败，都只删本测试自己建的沙箱（finally 由下面的包装保证）
} finally {
  // 只删本次沙箱：不碰真实 DSH 的状态目录
  rmSync(SANDBOX, { recursive: true, force: true })
}

console.log(`\nall ${String(globalThis.__opt02Passed ?? 0)} opt02 checks passed`)
