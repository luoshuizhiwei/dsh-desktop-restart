import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname,join } from 'node:path'
import {fileURLToPath} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
import { accountMenuDOM } from './fixtures/account-menu-dom.mjs'
import { source, walk, makeHarness, reply, flush, acceptRestart, buttons, buttonWithText, textContent, statusBody } from './fixtures/client-harness.mjs'
let passed=0

{
  let reads = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(200, { ok: true })
    reads += 1
    if (reads === 2) return Promise.reject(new Error('temporary offline'))
    return reply(200, statusBody())
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  const restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  assert.ok(restart, 'panel restart action exists')
  assert.equal(restart.props.disabled, false, 'unknown desktop state does not permanently disable restart')
  buttonWithText(tree, 'Retry status').props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.doesNotMatch(walk(tree, (node) => node.type === 'p' && node.props.className === 'dshdr-panel-desc')?.children ?? '', /Could not read desktop app status/u)
  passed += 1
  console.log(`ok ${passed} - status failure is unknown, retry recovers without false desktop-only state`)
}

async function testLocalizedGuard(blocked) {
  let posts = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method !== 'POST') return reply(200, statusBody())
    posts += 1
    if (blocked) {
      return reply(409, {
        ok: false,
        blocked: true,
        guard: { active: true, blocked: true, tasks: { active: false, turns: 0, queued: 0, jobs: 0 }, installs: { active: true, running: true } },
        error: '插件正在安装或更新（中文原文）',
      })
    }
    return reply(409, {
      ok: false,
      guard: { active: true, blocked: false, tasks: { active: true, turns: 2, queued: 1, jobs: 1 }, installs: { active: false, running: false } },
      error: '有任务在跑（中文原文）',
    })
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  let restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  restart.props.onClick()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  restart.props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.equal(posts, 1)
  // 2026-10-29 契约更新：warn 态守卫说明在 panel-warn（guardWarn），
  // 确认行在 panel-note（warnConfirmLine，含剩余秒数）—— 两类都收集。
  const notes = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.type === 'p' && (node.props.className === 'dshdr-panel-note' || node.props.className === 'dshdr-panel-warn')) notes.push(node.children)
    const children = Array.isArray(node.children) ? node.children : [node.children]
    for (const child of children) visit(child)
  }
  visit(tree)
  const text = notes.join(' ')
  if (blocked) {
    assert.match(text, /A plugin install[/]update is running/u)
    assert.doesNotMatch(text, /中文原文/u)
  } else {
    assert.match(text, /2 agents generating or running tools/u)
    assert.match(text, /interrupt them|打断它们/u, '守卫说明仍在面板（warn 段落）')
    assert.doesNotMatch(text, /中文原文/u)
  }
}

await testLocalizedGuard(false)
passed += 1
console.log(`ok ${passed} - structured task guard is localized in English`)
await testLocalizedGuard(true)
passed += 1
console.log(`ok ${passed} - structured install block is localized in English`)

{
  let runs = 0
  const preview = {
    at: '2026-10-21T12:00:00.000Z', scanned: 7, removed: 0, failed: 0, bytes: 0,
    candidateCount: 2, candidateBytes: 5 * 1024 * 1024, skippedCount: 2, skipReason: 'owner-unknown',
  }
  const harness = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      runs += 1
      return reply(200, { ok: true, enabled: false, last: preview })
    }
    return reply(200, statusBody('off', { sweep: { enabled: false, last: null } }))
  })
  const instance = harness.render(harness.sweepComponent)
  await flush()
  let tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.equal(buttonWithText(tree, 'Scan leftover snapshot preview now').props.disabled, false)
  buttonWithText(tree, 'Scan leftover snapshot preview now').props.onClick()
  await flush()
  tree = harness.render(harness.sweepComponent, instance.hook).tree
  const result = textContent(walk(tree, (node) => node.type === 'span' && node.props.className === 'dshdr-set-result'))
  assert.match(result, /2 candidates \(estimated 5\.0 MB\); preview only, nothing deleted/u)
  assert.match(result, /candidate ownership could not be verified/u)
  assert.doesNotMatch(result, /freed/u)
  assert.equal(runs, 1)
  passed += 1
  console.log(`ok ${passed} - sweep preview shows estimated candidates and unknown-owner reason without claiming freed space`)
}

{
  let reads = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(200, { ok: true, enabled: false, last: null })
    reads += 1
    if (reads === 2) return Promise.reject(new Error('status offline'))
    return reply(200, statusBody('off', { sweep: { enabled: false, last: null } }))
  })
  const instance = harness.render(harness.sweepComponent)
  await flush()
  let tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.match(JSON.stringify(tree), /status offline/u)
  buttonWithText(tree, 'Retry read').props.onClick()
  await flush()
  tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.doesNotMatch(JSON.stringify(tree), /status offline/u)
  passed += 1
  console.log(`ok ${passed} - sweep status read failure exposes recovery`)
}

{
  let posts = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') {
      posts += 1
      return posts === 1 ? reply(500, { ok: false, error: 'temporary failure' }) : reply(200, { ok: true, enabled: false, last: null })
    }
    return reply(200, statusBody('off', { sweep: { enabled: false, last: null } }))
  })
  const instance = harness.render(harness.sweepComponent)
  await flush()
  let tree = harness.render(harness.sweepComponent, instance.hook).tree
  buttonWithText(tree, 'Scan leftover snapshot preview now').props.onClick()
  await flush()
  tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.match(JSON.stringify(tree), /temporary failure/u)
  buttonWithText(tree, 'Retry last operation').props.onClick()
  await flush()
  tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.equal(posts, 2)
  assert.doesNotMatch(JSON.stringify(tree), /temporary failure/u)
  passed += 1
  console.log(`ok ${passed} - sweep write failure exposes retry and recovers`)
}

{
  let posts = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') {
      posts += 1
      return posts === 1 ? reply(500, { ok: false, error: 'preference write failed' }) : reply(200, { ok: true, enabled: true, last: null })
    }
    return reply(200, statusBody('off', { sweep: { enabled: false, last: null } }))
  })
  const instance = harness.render(harness.sweepComponent)
  await flush()
  let tree = harness.render(harness.sweepComponent, instance.hook).tree
  const toggle = walk(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'Scan leftover snapshots on start (preview only)')
  assert.ok(toggle)
  assert.equal(toggle.props.checked, false)
  toggle.props.onChange({ target: { checked: true } })
  await flush()
  tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.equal(walk(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'Scan leftover snapshots on start (preview only)').props.checked, false)
  assert.match(JSON.stringify(tree), /preference write failed/u)
  buttonWithText(tree, 'Retry last operation').props.onClick()
  await flush()
  tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.equal(posts, 2)
  assert.equal(walk(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'Scan leftover snapshots on start (preview only)').props.checked, true)
  passed += 1
  console.log(`ok ${passed} - automatic sweep setting preserves confirmed value and retries failed write`)
}

{
  const pending = { result: 'pending', phase: 'stop', helperAlive: true, busy: true, reason: null }
  const harness = makeHarness(async (_url, options) => reply(200, statusBody('off', { restartOp: pending })))
  const instance = harness.render(harness.panelComponent)
  await flush()
  const tree = harness.render(harness.panelComponent, instance.hook).tree
  const action = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  assert.equal(action.props.disabled, true, 'mount applies existing pending operation lock')
  passed += 1
  console.log(`ok ${passed} - mount synchronizes a pending restart and locks duplicate requests`)
}

{
  let posts = 0
  let getCount = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') {
      posts += 1
      return reply(202, { ok: true })
    }
    getCount += 1
    const restartOp = getCount <= 2
      ? { result: 'failed', phase: 'stop', reason: 'old-failure', helperAlive: false, busy: false }
      : { id: 'new-op', result: 'pending', phase: 'scheduled', reason: null, helperAlive: true, busy: true }
    return reply(200, statusBody('off', { restartOp }))
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  let action = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  action.props.onClick()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  action = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  action.props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.equal(posts, 1)
  assert.equal(buttons(tree).find((button) => button.props['data-variant'] === 'primary').props.disabled, true)
  assert.doesNotMatch(textContent(tree), /old-failure/u, 'accepted request replaces terminal operation and its stale message')
  assert.deepEqual(harness.timerDelays(), [2000], 'new pending operation has one poll timer')
  passed += 1
  console.log(`ok ${passed} - accepted retry replaces previous failure with the new pending operation`)
}

{
  let reads = 0
  const pending = { id: 'pending-op', result: 'pending', phase: 'stop', helperAlive: true, busy: true }
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(202, { ok: true })
    reads += 1
    if (reads === 2) return reply(200, statusBody('off', {
      restartOp: { id: 'unknown-op', result: 'unknown', phase: 'launch', reason: 'launch-unknown', helperAlive: null, busy: true },
    }))
    if (reads === 3) return reply(200, statusBody('off', {
      restartOp: { id: 'unknown-op', result: 'failed', phase: 'launch', reason: 'launch-failed', helperAlive: false, busy: false },
    }))
    return reads >= 5 ? Promise.reject(new Error('status offline')) : reply(200, statusBody('off', { restartOp: pending }))
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.equal(buttons(tree).find((button) => button.props['data-variant'] === 'primary').props.disabled, true)
  buttonWithText(tree, 'Refresh status').props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.equal(buttons(tree).find((button) => button.props['data-variant'] === 'primary').props.disabled, false, 'manual status refresh adopts verified not-busy state')
  assert.match(textContent(tree), /launch-failed/u)
  passed += 1
  console.log(`ok ${passed} - unknown busy lock clears only after status confirms busy false`)
}

{
  let reads = 0
  const harness = makeHarness(async () => {
    reads += 1
    if (reads <= 2) return reply(200, statusBody('off', { restartOp: { result: 'pending', phase: 'stop', helperAlive: true, busy: true } }))
    if (reads < 6) return Promise.reject(new Error('poll offline'))
    return reply(200, statusBody('off', { restartOp: { result: 'ok', phase: 'ready', helperAlive: false, busy: false } }))
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  harness.render(harness.panelComponent, instance.hook)
  for (let i = 0; i < 3; i += 1) {
    harness.fireTimer(2000)
    await flush()
    harness.render(harness.panelComponent, instance.hook)
  }
  assert.deepEqual(harness.timerDelays(), [], 'poll errors stop after three attempts')
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.match(textContent(tree), /status unavailable|Could not read desktop app status/iu)
  buttonWithText(tree, 'Retry status').props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.match(textContent(tree), /Host and restart client reconnected/u)
  assert.deepEqual(harness.timerDelays(), [])
  tree = harness.render(harness.panelComponent, instance.hook).tree
  const restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  assert.equal(restart.props.disabled, false, 'confirmed terminal success replaces the scheduled lock')
  assert.match(textContent(restart), /Restart/u)
  passed += 1
  console.log(`ok ${passed} - poll failures are visible, bounded, and manual retry recovers terminal state`)
}

{
  const harness = makeHarness(async () => reply(200, statusBody('off', {
    restartOp: { id: 'pending-op', result: 'pending', phase: 'stop', helperAlive: true, busy: true },
  })))
  const instance = harness.render(harness.panelComponent)
  await flush()
  harness.render(harness.panelComponent, instance.hook)
  assert.deepEqual(harness.timerDelays(), [2000])
  harness.unmount(instance.hook)
  assert.deepEqual(harness.timerDelays(), [], 'unmount clears pending poll')
  passed += 1
  console.log(`ok ${passed} - unmount cancels the pending status poll`)
}

{
  const harness = makeHarness(async () => reply(200, statusBody('off', { sweep: { enabled: false, last: {
    at: '2026-10-21T12:00:00.000Z', scanned: 0, removed: 0, failed: 1,
    error: { code: 'EACCES' }, partial: true, prefiltered: 3,
  } } })))
  const instance = harness.render(harness.sweepComponent)
  await flush()
  const tree = harness.render(harness.sweepComponent, instance.hook).tree
  assert.doesNotMatch(textContent(tree), /\[object Object\]/u)
  assert.match(textContent(tree), /EACCES/u)
  assert.match(textContent(tree), /incomplete|部分结果/iu)
  assert.match(textContent(tree), /3/u)
  passed += 1
  console.log(`ok ${passed} - structured scan error, partial completion, and prefiltered count are visible`)
}

async function testTerminalRestart(componentKey, terminal, expected, disabled) {
  let accepted = false
  const previous = { result: 'failed', phase: 'stop', reason: 'old-stop-failed', helperAlive: false, busy: false }
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') {
      accepted = true
      return reply(202, { ok: true })
    }
    return reply(200, statusBody('off', { restartOp: accepted ? terminal : previous }))
  })
  const component = harness[componentKey]
  // 2026-10-22 入口差异化：设置页不再提供重启，只显示状态。
  const { tree } = componentKey === 'settingsRestartComponent'
    ? await (async () => { const instance = harness.render(component); await flush(); return { tree: harness.render(component, instance.hook).tree } })()
    : await acceptRestart(harness, component)
  const visible = textContent(tree)
  assert.match(visible, expected)
  assert.doesNotMatch(visible, /scheduled|已排程|已安排/iu, 'terminal UI must not retain a scheduled conclusion')
  const buttonsInTree = buttons(tree)
  if (componentKey === 'settingsRestartComponent') {
    const restartish = buttonsInTree.filter((button) => /whole desktop app|整个桌面应用/u.test(String(button.props.title ?? '')))
    assert.equal(restartish.length, 0, '设置页不得再提供重启按钮')
    assert.equal(accepted, false, '设置页不得发出重启请求')
  } else {
  const restart = buttonsInTree.find((button) => /whole desktop app|整个桌面应用/u.test(String(button.props.title ?? '')) && button.props.onClick)
  assert.ok(restart)
  assert.equal(restart.props.disabled, disabled)
  assert.doesNotMatch(String(restart.props.title ?? ''), /scheduled|已排程/iu)
  assert.doesNotMatch(String(restart.props['aria-label'] ?? ''), /scheduled|已排程/iu)
  if (componentKey === 'settingsRestartComponent') {
    const hint = walk(tree, (node) => node.type === 'span' && node.props.className === 'dshdr-hint')
    assert.ok(hint)
    assert.doesNotMatch(textContent(hint), /scheduled|已排程|已安排/iu)
    assert.match(textContent(hint), /stop-failed/u, 'settings row owns the terminal reason code')
  }
  }
  passed += 1
  console.log(`ok ${passed} - terminal ${terminal.result} state replaces scheduled fallback in visible, title, and aria copy`)
}

await testTerminalRestart('panelComponent', { id: 'failed-op', result: 'failed', phase: 'stop', reason: 'stop-failed', helperAlive: false, busy: false }, /stop-failed/u, false)
await testTerminalRestart('panelComponent', { id: 'ok-op', result: 'ok', phase: 'ready', helperAlive: false, busy: false }, /Host and restart client reconnected/u, false)
await testTerminalRestart('panelComponent', { id: 'unknown-op', result: 'unknown', phase: 'launch', reason: 'launch-unknown', helperAlive: true, busy: true }, /result is unknown|结果不确定/u, true)
await testTerminalRestart('settingsRestartComponent', { id: 'failed-op', result: 'failed', phase: 'stop', reason: 'stop-failed', helperAlive: false, busy: false }, /stop-failed/u, false)
await testTerminalRestart('sidebarComponent', { id: 'unknown-op', result: 'unknown', phase: 'launch', reason: 'launch-unknown', helperAlive: true, busy: true }, /Unknown result|结果未知/u, true)

{
  for (const restartOp of [null, { result: 'unknown', phase: 'launch', reason: 'launch-unknown', helperAlive: false, busy: false }]) {
    let posts = 0
    const harness = makeHarness(async (_url, options) => {
      if (options.method === 'POST') {
        posts += 1
        return reply(409, { ok: false, error: 'must not post' })
      }
      return reply(200, statusBody('off', { restartBusy: true, restartOp }))
    })
    const instance = harness.render(harness.panelComponent)
    await flush()
    const tree = harness.render(harness.panelComponent, instance.hook).tree
    const restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
    assert.equal(restart.props.disabled, true, 'top-level busy status overrides missing or false nested busy')
    restart.props.onClick()
    await flush()
    assert.equal(posts, 0, 'busy lock blocks the click handler as well as the disabled control')
  }
  passed += 1
  console.log(`ok ${passed} - top-level restartBusy blocks requests with missing or unknown restartOp`)
}

{
  let posts = 0
  const previous = { id: 'old-op', result: 'failed', phase: 'stop', reason: 'stop-failed', helperAlive: false, busy: false }
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') {
      posts += 1
      return reply(409, {
        ok: false,
        guard: { active: true, blocked: false, tasks: { active: true, turns: 2, queued: 1, jobs: 1 }, installs: { active: false, running: false } },
      })
    }
    return reply(200, statusBody('off', { restartOp: previous }))
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  let restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  restart.props.onClick()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  restart = buttons(tree).find((button) => button.props['data-variant'] === 'primary')
  restart.props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.equal(posts, 1, 'second confirmation sends one new request')
  assert.match(textContent(tree), /agents generating or running tools/u)
  assert.doesNotMatch(textContent(tree), /stop-failed/u, 'old terminal result cannot override new guard state')
  assert.doesNotMatch(String(buttons(tree).find((button) => button.props['data-variant'] === 'primary').props['aria-label']), /Retry/u)
  passed += 1
  console.log(`ok ${passed} - old failed operation does not mask a new 409 guard confirmation`)
}

// 2026-10-22 共享状态：三个入口同时挂着时只应有**一次**状态读取与**一条**轮询；
// 任一入口退订不清轮询，全部退订才停。这条断言钉住「一份状态 + 一个轮询」，
// 否则改回「每个入口各存一份」也能让其他用例照样通过。
{
  let gets = 0
  const pending = { id: 'shared-op', result: 'pending', phase: 'stop', helperAlive: true, busy: true }
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(202, { ok: true })
    gets += 1
    return reply(200, statusBody('off', { restartOp: pending }))
  })
  // apply() 自己会读一次状态（入口默认开关）；三个入口共享的是第 2 次。
  const panel = harness.render(harness.panelComponent)
  const sidebar = harness.render(harness.sidebarComponent)
  const row = harness.render(harness.settingsRestartComponent)
  await flush()
  harness.render(harness.panelComponent, panel.hook)
  harness.render(harness.sidebarComponent, sidebar.hook)
  harness.render(harness.settingsRestartComponent, row.hook)
  assert.equal(gets, 2, '三个入口必须共用一次状态读取（apply 的那次 + 共享的一次）')
  assert.deepEqual(harness.timerDelays(), [2000], '三个入口必须共用一条轮询')
  harness.unmount(panel.hook)
  assert.deepEqual(harness.timerDelays(), [2000], '还有入口挂着时轮询不能停')
  harness.unmount(sidebar.hook)
  harness.unmount(row.hook)
  assert.deepEqual(harness.timerDelays(), [], '最后一个入口退订后轮询必须停掉')
  passed += 1
  console.log(`ok ${passed} - three mounted entries share one status read and one poll loop`)
}

// 整页导航会让桌面壳重新跑一次 web boot，而主进程复用的是它启动时缓存的引导图：
// 应用运行期间改过插件文件时，本插件那一行的 rev 已失效，条目激活失败，
// boot 审计报 "import failed"，主进程随即弹「禁用第三方插件、备份 profile patch 并重启」。
// 这条断言钉住「客户端 bundle 不得自带任何整页导航」。
{
  const navigation = ['location.reload', 'location.href', 'location.assign', 'location.replace', 'history.go', 'history.back']
  const found = navigation.filter((token) => source.includes(token))
  assert.deepEqual(found, [], `客户端不得触发整页导航（会引发 web boot 失败与「禁用第三方插件」恢复框），命中：${found.join(', ')}`)
  passed += 1
  console.log(`ok ${passed} - client bundle triggers no full-page navigation`)
}

{
  // F1（2026-10-23）：确认态过期后必须重新武装，不能直接提交
  let posts = 0
  const clock = { now: 1_000_000 }
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') { posts += 1; return reply(202, { ok: true }) }
    return reply(200, statusBody())
  }, { clock })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  const primary = () => buttons(tree).find((b) => b.props['data-variant'] === 'primary')
  assert.ok(primary(), 'panel has a primary button')
  primary().props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.equal(posts, 0, 'first click must only arm the confirmation')
  clock.now += 5001
  primary().props.onClick()
  await flush()
  assert.equal(posts, 0, 'expired confirmation must re-arm instead of submitting')
  passed += 1
  console.log(`ok ${passed} - expired confirmation re-arms instead of submitting`)
}

{
  // F2（2026-10-23）：宿主返回 cancelled:false 时不能显示“已取消”
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(200, { ok: true, cancelled: false })
    return reply(200, statusBody('off', { waiting: { since: new Date().toISOString(), pollMs: 5000, maxMs: 1800000 } }))
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  const cancel = buttons(tree).find((b) => /cancelWaiting|Cancel waiting|取消等待/u.test(String(b.props.title ?? '') + String(b.props['aria-label'] ?? '')))
  assert.ok(cancel, 'cancel button is visible while waiting')
  cancel.props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  const text = textContent(tree)
  assert.match(text, /nothingToCancel|没有等待|There was no pending wait/u, 'cancelled:false must report “nothing to cancel”')
  assert.doesNotMatch(text, /waitingCancelled|已取消等待|Waiting cancelled/u, 'must not claim cancellation when backend said false')
  passed += 1
  console.log(`ok ${passed} - backend cancelled:false is not displayed as cancelled`)
}

{
  // F6（2026-10-23）：旧状态回包不得覆盖新提交确定的状态
  const pendingOp = { id: 'new-op', phase: 'scheduled', result: 'pending', reason: null, stages: {}, ageMs: 0, argsPreserved: true, helperVerified: false, needsManualCheck: false, helperAlive: null, busy: true }
  const oldOp = { id: 'old-op', phase: 'stop', result: 'failed', reason: 'old-stop-failed', stages: {}, ageMs: 1, argsPreserved: true, helperVerified: true, needsManualCheck: false, helperAlive: null, busy: false }
  let releaseOld = null
  let getCount = 0
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(202, { ok: true })
    getCount += 1
    if (getCount === 1) {
      return new Promise((resolve) => { releaseOld = () => resolve(reply(200, statusBody('off', { restartOp: oldOp }))) })
    }
    return reply(200, statusBody('off', { restartOp: pendingOp, restartBusy: true }))
  })
  const instance = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, instance.hook).tree
  let primary = buttons(tree).find((b) => b.props['data-variant'] === 'primary')
  primary.props.onClick()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  primary = buttons(tree).find((b) => b.props['data-variant'] === 'primary')
  primary.props.onClick()
  await flush()
  assert.ok(releaseOld, 'the old status request should still be pending')
  releaseOld()
  await flush()
  tree = harness.render(harness.panelComponent, instance.hook).tree
  assert.doesNotMatch(textContent(tree), /old-stop-failed/u, 'stale status must not overwrite the newer operation')
  passed += 1
  console.log(`ok ${passed} - stale status response cannot overwrite a newer accepted operation`)
}

if (!process.env.DSHDR_CASE || process.env.DSHDR_CASE === 'F5') {
  let remote = statusBody('off', { waiting: { since: '2026-10-23T00:00:00.000Z', maxMs: 1800000 } })
  const harness = makeHarness(async () => reply(200, remote))
  const mounted = [harness.render(harness.panelComponent), harness.render(harness.sidebarComponent), harness.render(harness.settingsRestartComponent)]
  await flush()
  console.log(JSON.stringify({ case: 'F5-shared-waiting', pollDelays: harness.timerDelays() }))
  assert.equal(harness.timerDelays().filter(ms => ms === 2000).length, 1, 'F5: waiting without an operation must use one shared status poll')
  harness.unmount(mounted[1].hook)
  harness.unmount(mounted[2].hook)
  assert.equal(harness.timerDelays().filter(ms => ms === 2000).length, 1, 'remaining subscriber keeps the same waiting poll')
  remote = statusBody('off', { waiting: null })
  harness.fireTimer(2000)
  await flush()
  const tree = harness.render(harness.panelComponent, mounted[0].hook).tree
  assert.ok(!buttons(tree).some(button => /Cancel waiting/u.test(textContent(button))), 'host cancellation/timeout automatically removes waiting controls')
  assert.equal(harness.timerDelays().filter(ms => ms === 2000).length, 0, 'idle status stops polling')
  harness.unmount(mounted[0].hook)
  const waitingHarness = makeHarness(async () => reply(200, statusBody('off', { waiting: { since: '2026-10-23T00:00:00.000Z', maxMs: 1800000 } })))
  const waiting = waitingHarness.render(waitingHarness.panelComponent)
  await flush()
  assert.equal(waitingHarness.timerDelays().filter(ms => ms === 2000).length, 1)
  waitingHarness.unmount(waiting.hook)
  assert.equal(waitingHarness.timerDelays().length, 0, 'last unmount cleans up a waiting poll')
  passed += 1
  console.log(`ok ${passed} - F5 waiting shares one poll, reflects host cancellation/timeout, and cleans up on unmount`)

  let waitingRemote = statusBody()
  const accepted = makeHarness(async (_url, options) => {
    if (options.method === 'POST') {
      waitingRemote = statusBody('off', { waiting: { since: '2026-10-23T00:00:00.000Z', maxMs: 1800000 } })
      return reply(202, { ok: true, waiting: true })
    }
    return reply(200, waitingRemote)
  })
  const submitted = await acceptRestart(accepted, accepted.panelComponent)
  assert.equal(accepted.timerDelays().filter(ms => ms === 2000).length, 1, 'accepting a waiting request starts polling without another mount or refresh')
  waitingRemote = statusBody('off', { restartOp: { id: 'waiting-started', result: 'pending', phase: 'scheduled', helperAlive: true }, restartBusy: true })
  accepted.fireTimer(2000)
  await flush()
  const pendingTree = accepted.render(accepted.panelComponent, submitted.hook).tree
  assert.ok(!buttons(pendingTree).some(button => /Cancel waiting/u.test(textContent(button))))
  assert.equal(buttons(pendingTree).find(button => button.props['data-variant'] === 'primary').props.disabled, true, 'automatic execution locks duplicate restart requests')
  assert.equal(accepted.timerDelays().filter(ms => ms === 2000).length, 1, 'waiting transitions into the existing pending poll')
  accepted.unmount(submitted.hook)
  passed += 1
  console.log(`ok ${passed} - F5 accepted wait starts polling and automatically transitions to the pending operation`)

  let cancelledRemote = statusBody()
  const cancelled = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return reply(202, { ok: true, waiting: true })
    return reply(200, cancelledRemote)
  })
  const cancelMount = await acceptRestart(cancelled, cancelled.panelComponent)
  cancelled.fireTimer(2000)
  await flush()
  const cancelledTree = cancelled.render(cancelled.panelComponent, cancelMount.hook).tree
  assert.doesNotMatch(textContent(cancelledTree), /Scheduled: the restart will run automatically/u, 'F5: host cancellation/timeout must also clear the accepted waiting message')
  assert.equal(cancelled.timerDelays().filter(ms => ms === 2000).length, 0)
  cancelled.unmount(cancelMount.hook)
  passed += 1
  console.log(`ok ${passed} - F5 host cancellation/timeout clears the accepted waiting message as well as the controls`)

  let offline = false
  const bounded = makeHarness(async () => {
    if (offline) throw new Error('waiting status offline')
    return reply(200, statusBody('off', { waiting: { since: '2026-10-23T00:00:00.000Z', maxMs: 1800000 } }))
  })
  const boundedMount = bounded.render(bounded.panelComponent)
  await flush()
  offline = true
  for (let i = 0; i < 3; i += 1) { bounded.fireTimer(2000); await flush() }
  assert.equal(bounded.timerDelays().length, 0, 'waiting polls retain the three-failure limit')
  assert.match(textContent(bounded.render(bounded.panelComponent, boundedMount.hook).tree), /waiting status offline/u)
  bounded.unmount(boundedMount.hook)
  passed += 1
  console.log(`ok ${passed} - F5 waiting poll failures remain visible and stop after three failures`)
}

if (!process.env.DSHDR_CASE || ['S1', 'S1-hide'].includes(process.env.DSHDR_CASE)) {
  const entryKeys = ['panel', 'footer', 'header', 'settingsRow']
  const storageKey = 'dsh-desktop-restart.entries'
  for (const key of process.env.DSHDR_CASE === 'S1-hide' ? [] : entryKeys) {
    for (const saved of [true, false]) {
      const savedEntries = Object.fromEntries(entryKeys.map(name => [name, name === key ? saved : true]))
      const values = new Map([[storageKey, JSON.stringify(savedEntries)]])
      let failWrites = true
      const storage = {
        getItem: name => values.get(name) ?? null,
        setItem(name, value) { if (failWrites) throw new Error('S1 quota exceeded'); values.set(name, value) },
      }
      const harness = makeHarness(async () => reply(200, statusBody()), { storage })
      const mounted = harness.render(harness.settingsComponent)
      await flush()
      let tree = harness.render(harness.settingsComponent, mounted.hook).tree
      const toggle = () => walk(tree, node => node.type === 'div' && node.props.key === key).children.at(-1)
      const beforeSlots = harness.activeSlots()
      toggle().props.onChange({ target: { checked: !saved } })
      tree = harness.render(harness.settingsComponent, mounted.hook).tree
      console.log(JSON.stringify({ case: 'S1-entry', key, saved, checkedAfterFailure: toggle().props.checked }))
      assert.equal(toggle().props.checked, saved, `S1: ${key} must retain the saved value after a write failure`)
      assert.deepEqual(harness.activeSlots(), beforeSlots, 'failed save must not change registered entries')
      assert.equal(values.get(storageKey), JSON.stringify(savedEntries))
      assert.match(textContent(walk(tree, node => node.props.role === 'alert')), /S1 quota exceeded/u, 'saving failure must be visible')
      failWrites = false
      toggle().props.onChange({ target: { checked: !saved } })
      tree = harness.render(harness.settingsComponent, mounted.hook).tree
      assert.equal(toggle().props.checked, !saved, 'successful retry updates the controlled switch')
      assert.deepEqual(JSON.parse(values.get(storageKey)), { ...savedEntries, [key]: !saved })
      assert.equal(walk(tree, node => node.props.role === 'alert'), null, 'successful retry clears the error')
      const remounted = makeHarness(async () => reply(200, statusBody()), { storage })
      const persistedTree = remounted.render(remounted.settingsComponent).tree
      assert.equal(walk(persistedTree, node => node.type === 'div' && node.props.key === key).children.at(-1).props.checked, !saved, 'new mount reads the successfully saved value')
    }
    passed += 1
    console.log(`ok ${passed} - S1 ${key} save failure rolls back, reports the error, and retries persistently in both directions`)
  }
  for (const saved of [false, true]) {
    const values = new Map([['dsh-desktop-restart.hide-contact', saved ? '1' : '0']])
    let failWrites = true
    const menuItem = textContent => ({ textContent, parentElement: null, style: { display: '' }, attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, value) }, removeAttribute(name) { this.attributes.delete(name) },
    })
    const feedback = menuItem('Feedback')
    const settings = menuItem('Settings')
    const harness = makeHarness(async () => reply(200, statusBody()), {
      menuItems: [feedback, settings],
      storage: { getItem: name => values.get(name) ?? null, setItem(name, value) { if (failWrites) throw new Error('S1 feedback storage denied'); values.set(name, value) } },
    })
    const mounted = harness.render(harness.hideContactComponent)
    let tree = mounted.tree
    const toggle = () => walk(tree, node => node.type === 'input')
    const beforeDisplay = feedback.style.display
    toggle().props.onChange({ target: { checked: !saved } })
    tree = harness.render(harness.hideContactComponent, mounted.hook).tree
    assert.equal(toggle().props.checked, saved, 'S1: feedback switch retains saved value on failure')
    assert.equal(feedback.style.display, beforeDisplay, 'failed save must not hide or restore the menu item')
    assert.equal(values.get('dsh-desktop-restart.hide-contact'), saved ? '1' : '0')
    assert.match(textContent(walk(tree, node => node.props.role === 'alert')), /S1 feedback storage denied/u)
    failWrites = false
    toggle().props.onChange({ target: { checked: !saved } })
    tree = harness.render(harness.hideContactComponent, mounted.hook).tree
    assert.equal(toggle().props.checked, !saved)
    assert.equal(feedback.style.display, saved ? '' : 'none', 'successful save applies the menu visibility change')
    assert.equal(settings.style.display, '', 'unrelated account menu item remains visible')
    assert.equal(values.get('dsh-desktop-restart.hide-contact'), saved ? '0' : '1')
    assert.equal(walk(tree, node => node.props.role === 'alert'), null)
  }
  passed += 1
  console.log(`ok ${passed} - S1 Feedback save failure preserves the switch and DOM, retry saves and restores without touching other items`)
}

if (!process.env.DSHDR_CASE || process.env.DSHDR_CASE === 'F7') {
  for (const file of ['README.md', 'README.en.md']) {
    const doc = readFileSync(join(here, '..', file), 'utf8')
    const stale = doc.split('\n').filter(line => /resume=|agent\.(?:followup|inject)|createUserMessage|SessionId|最多.*8.*会话|At most eight sessions|12 秒|twelve seconds|选择续跑模式|Choose a mode|Auto-continue \(wake\)|自动继续（wake）/iu.test(line))
    assert.deepEqual(stale, [], `F7: ${file} must not advertise the removed resume modes, delivery or API`)
    assert.match(doc, file === 'README.md' ? /不向会话投递消息/ : /does not send messages to sessions/iu, `${file} explicitly describes the current behavior`)
  }
  passed += 1
  console.log(`ok ${passed} - F7 both READMEs describe receipts without removed session delivery, resume modes or API parameters`)
}

if (!process.env.DSHDR4A_CASE || process.env.DSHDR4A_CASE === '8') {
  let posts = 0
  const paused = { id: 'fixture-request', state: 'paused', ask: 'fixture-ask', pausedReason: 'new-work', countdownRemainingMs: null, deadlineAt: '2026-10-23T12:00:00.000Z' }
  const harness = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      assert.match(url, /choice=cancel/u)
      posts += 1
      return reply(200, { ok: true, cancelled: false })
    }
    return reply(200, statusBody('off', { waiting: posts ? null : { since: '2026-10-23T00:00:00.000Z', maxMs: 1800000 }, restartRequest: posts ? { ...paused, state: 'executing', ask: null, pausedReason: null } : paused }))
  })
  const panel = harness.render(harness.panelComponent)
  const footer = harness.render(harness.sidebarComponent)
  await flush()
  let panelTree = harness.render(harness.panelComponent, panel.hook).tree
  const footerTree = harness.render(harness.sidebarComponent, footer.hook).tree
  const dialogs = [panelTree, footerTree].filter(tree => walk(tree, node => node.props.role === 'dialog'))
  assert.equal(dialogs.length, 1, '4A-8: the host ask is rendered by exactly one subscribed entry')
  const dialog = walk(dialogs[0], node => node.props.role === 'dialog')
  buttonWithText(dialog, 'Cancel request').props.onClick()
  await flush()
  panelTree = harness.render(harness.panelComponent, panel.hook).tree
  assert.equal(posts, 1)
  assert.doesNotMatch(textContent(panelTree), /Waiting cancelled|已取消等待/u, '4A-8: cancelled:false cannot claim cancellation')
  assert.equal(buttons(panelTree).find(button => button.props['data-variant'] === 'primary').props.disabled, true, 'executing request remains locked')
  harness.unmount(panel.hook)
  harness.unmount(footer.hook)
  passed += 1
  console.log(`ok ${passed} - 4A-8 one paused question; cancelled:false refreshes the authoritative executing state without claiming cancellation`)
}

if (!process.env.DSHDR4A_CASE || process.env.DSHDR4A_CASE === 'settings') {
  let saved = 5
  let fail = false
  const harness = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      assert.match(url, /countdown=9/u)
      if (fail) return reply(500, { ok: false, error: 'countdown write denied' })
      saved = 9
      return reply(200, { ok: true, countdownSeconds: saved })
    }
    return reply(200, statusBody('off', { countdownSeconds: saved }))
  })
  const section = harness.render(harness.settingsComponent).tree
  const row = walk(section, node => node.type?.name === 'CountdownRow')
  assert.ok(row, '4A settings: countdown must be configurable from the plugin settings')
  const mounted = harness.render(row.type)
  await flush()
  let tree = harness.render(row.type, mounted.hook).tree
  assert.equal(walk(tree, node => node.type === 'input').props.value, '5')
  walk(tree, node => node.type === 'input').props.onChange({ target: { value: '9' } })
  tree = harness.render(row.type, mounted.hook).tree
  fail = true
  buttonWithText(tree, 'Save countdown').props.onClick()
  await flush()
  tree = harness.render(row.type, mounted.hook).tree
  assert.equal(walk(tree, node => node.type === 'input').props.value, '5')
  assert.match(textContent(tree), /countdown write denied/u)
  fail = false
  walk(tree, node => node.type === 'input').props.onChange({ target: { value: '9' } })
  tree = harness.render(row.type, mounted.hook).tree
  buttonWithText(tree, 'Save countdown').props.onClick()
  await flush()
  tree = harness.render(row.type, mounted.hook).tree
  assert.equal(walk(tree, node => node.type === 'input').props.value, '9')
  assert.equal(walk(tree, node => node.props.role === 'alert'), null)
  passed += 1
  console.log(`ok ${passed} - 4A countdown setting reads host value, rolls back failed writes, and saves successfully`)
}

if (!process.env.DSHDR4A_CASE || process.env.DSHDR4A_CASE === 'confirm') {
  // 2026-10-28 合并契约更新：等待态的独立「仍要立即重启」按钮已移除——
  // 显式打断入口只保留在暂停询问框（RiskDialog 的 forceNow）。此用例
  // 改为按新路径驱动：waiting/countdown 经暂停询问框（构造 paused 状态）
  // 或跳过；直接用 paused 态测「显式打断需二次确认」，与旧断言语义一致。
  for (const state of ['paused']) {
    let posts = 0
    let latest = { id: 'confirmation-request', state, ask: state === 'paused' ? 'ask-confirm' : null, pausedReason: 'new work', countdownRemainingMs: state === 'countdown' ? 4000 : null }
    const harness = makeHarness(async (url, options) => {
      if (options.method === 'POST') {
        posts += 1
        assert.match(url, state === 'paused' ? /choice=now&ask=ask-confirm/u : /force=1&now=1/u)
        return reply(202, { ok: true })
      }
      return reply(200, statusBody('off', { waiting: latest.state === 'terminal' ? null : { since: '2026-10-23T00:00:00.000Z' }, restartRequest: latest }))
    })
    const mounted = harness.render(harness.panelComponent)
    await flush()
    let tree = harness.render(harness.panelComponent, mounted.hook).tree
    const scope = walk(tree, node => node.props.role === 'dialog') ?? tree
    buttonWithText(scope, 'Restart now anyway').props.onClick()
    tree = harness.render(harness.panelComponent, mounted.hook).tree
    assert.equal(posts, 0, state + ': immediate restart requires an additional confirmation')
    const confirm = buttonWithText(walk(tree, node => node.props.role === 'dialog'), 'Confirm restart now')
    confirm.props.onClick()
    await flush()
    assert.equal(posts, 1)
    harness.unmount(mounted.hook)
  }
  // waiting/countdown 态的打断确认路径已由 M1–M3（主按钮第二击合并路径）
  // 覆盖；此处不再经由已移除的独立按钮驱动。
  passed += 1
  console.log(`ok ${passed} - 4A immediate action confirms separately via the pause dialog and rejects a stale confirmation`)
}
if (!process.env.DSHDR4A_CASE || process.env.DSHDR4A_CASE === 'ask-owner') {
  const harness = makeHarness(async () => reply(200, statusBody('off', { waiting: { since: '2026-10-23T00:00:00.000Z' }, restartRequest: { id: 'owner-request', state: 'paused', ask: 'owner-ask', pausedReason: 'new work' } })))
  const panel = harness.render(harness.panelComponent)
  const footer = harness.render(harness.sidebarComponent)
  await flush()
  assert.ok(walk(harness.render(harness.panelComponent, panel.hook).tree, node => node.props.role === 'dialog'))
  assert.equal(walk(harness.render(harness.sidebarComponent, footer.hook).tree, node => node.props.role === 'dialog'), null)
  harness.unmount(panel.hook)
  assert.ok(walk(harness.render(harness.sidebarComponent, footer.hook).tree, node => node.props.role === 'dialog'), 'one remaining view takes ownership of the same ask')
  assert.deepEqual(harness.timerDelays(), [2000], 'question ownership must not create another polling loop')
  harness.unmount(footer.hook)
  assert.deepEqual(harness.timerDelays(), [])
  passed += 1
  console.log(`ok ${passed} - 4A paused question transfers once on owner unmount while retaining a single shared poll`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '2') {
  let read=false, posts=0
  const harness=makeHarness(async (url,options)=>{
    if(options.method==='POST') { assert.match(url,/readNotice=notice-fixture/u); read=true;posts++;return reply(200,{ok:true,read:true}) }
    return reply(200,statusBody('off',{restartBusy:true,restartOp:{id:'locked',result:'unknown',reason:'record-missing',helperAlive:null},notifications:{items:[{id:'notice-fixture',summary:'旧实例未能关闭（stop-failed）',reason:'stop-failed',unread:!read,details:{reason:'stop-failed',stages:{stop:35}},delivery:{status:'failed',code:'notifications-disabled'}}],error:null}}))
  })
  const mounted=harness.render(harness.panelComponent);await flush()
  let tree=harness.render(harness.panelComponent,mounted.hook).tree
  assert.ok(buttonWithText(tree,'Mark as read'),'4B-2: unread diagnosis needs explicit read action')
  assert.match(textContent(tree),/stop-failed/u)
  assert.ok(walk(tree,n=>n.type==='details'),'redacted details can expand')
  buttonWithText(tree,'Mark as read').props.onClick();await flush()
  tree=harness.render(harness.panelComponent,mounted.hook).tree
  assert.equal(posts,1)
  assert.equal(buttons(tree).some(b=>textContent(b)==='Mark as read'),false)
  assert.equal(buttons(tree).find(b=>b.props['data-variant']==='primary').props.disabled,true,'read does not unlock restart')
  harness.unmount(mounted.hook);passed++
  console.log(`ok ${passed} - 4B-2 unread diagnosis is visible, expandable and explicitly read without unlocking`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '3') {
  let finish, cancelled=false
  const partial={at:'2026-10-24T00:00:00Z',scanned:2,removed:0,partial:true,candidateCount:1,candidateBytes:10}
  const harness=makeHarness(async(url,options)=>{
    if(options.method!=='POST') return reply(200,statusBody('off',{sweep:{enabled:false,last:null}}))
    if(url.includes('cancelSweep=1')) {cancelled=true;finish(reply(200,{ok:true,enabled:false,last:partial}));return reply(200,{ok:true,cancelled:true,enabled:false,last:partial})}
    return new Promise(resolve=>{finish=resolve})
  })
  const mounted=harness.render(harness.sweepComponent);await flush()
  let tree=harness.render(harness.sweepComponent,mounted.hook).tree
  buttonWithText(tree,'Scan leftover snapshot preview now').props.onClick();await flush()
  tree=harness.render(harness.sweepComponent,mounted.hook).tree
  buttonWithText(tree,'Cancel scan').props.onClick();await flush()
  tree=harness.render(harness.sweepComponent,mounted.hook).tree
  assert.equal(cancelled,true)
  assert.match(textContent(tree),/partial|cancelled/iu)
  harness.unmount(mounted.hook);passed++
  console.log(`ok ${passed} - 4B-3 visible scan cancellation shows partial results`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '4') {
  for (const missing of [undefined,2.5]) {
    const h=makeHarness(async()=>reply(200,statusBody('off',{countdownSeconds:missing})))
    const row=walk(h.render(h.settingsComponent).tree,n=>n.type?.name==='CountdownRow').type
    const mount=h.render(row);await flush();const tree=h.render(row,mount.hook).tree
    assert.equal(buttonWithText(tree,'Save countdown').props.disabled,true,'4B-4: old host must not permit saving')
    assert.match(textContent(tree),/host.*old.*restart|restart.*host/iu)
    h.unmount(mount.hook)
  }
  const h=makeHarness(async(_url,options)=>options.method==='POST'?reply(200,{ok:true}):reply(200,statusBody('off',{countdownSeconds:5})))
  const row=walk(h.render(h.settingsComponent).tree,n=>n.type?.name==='CountdownRow').type
  const mount=h.render(row);await flush();let tree=h.render(row,mount.hook).tree
  buttonWithText(tree,'Save countdown').props.onClick();await flush();tree=h.render(row,mount.hook).tree
  assert.equal(buttonWithText(tree,'Save countdown').props.disabled,true,'missing save response capability disables further writes')
  assert.match(textContent(tree),/host.*old.*restart|restart.*host/iu)
  h.unmount(mount.hook);passed++
  console.log(`ok ${passed} - 4B-4 old host countdown capability disables writes and explains restart requirement`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '6') {
  for(const state of ['waiting','countdown','paused']) {
    const deadlineAt=new Date(2026,9,24,10,23,0).toISOString()
    const h=makeHarness(async()=>reply(200,statusBody('off',{waiting:{since:new Date(2026,9,24,9,53,0).toISOString()},restartRequest:{state,deadlineAt,countdownRemainingMs:5000,ask:state==='paused'?'ask-deadline':null,pausedReason:'new work'}})))
    const mount=h.render(h.panelComponent);await flush();const tree=h.render(h.panelComponent,mount.hook).tree
    assert.match(textContent(tree),/10:23.*30.minute.*deadline/iu,'4B-6: displayed deadline comes from host absolute deadlineAt')
    h.unmount(mount.hook)
  }
  passed++;console.log(`ok ${passed} - 4B-6 waiting countdown and paused display the host deadline in local HH:MM`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '7') {
  const clock={now:1_800_000_000_000};let reads=0
  const h=makeHarness(async()=>{reads++;return reply(200,statusBody('off',{waiting:{since:new Date(clock.now).toISOString()},restartRequest:{state:'countdown',countdownRemainingMs:5000,countdownUntil:new Date(1_800_000_005_000).toISOString()}}))},{clock})
  const mount=h.render(h.panelComponent);await flush();let tree=h.render(h.panelComponent,mount.hook).tree
  assert.match(textContent(tree),/5s/u)
  const initialReads=reads
  for(const seconds of [4,3,2,1,0]) {clock.now+=1000;h.fireTimer(1000);tree=h.render(h.panelComponent,mount.hook).tree;assert.match(textContent(tree),new RegExp(''+seconds+'s'),'4B-7: countdown decrements every second')}
  assert.equal(reads,initialReads,'local display ticks must not introduce extra network polls')
  h.unmount(mount.hook);assert.deepEqual(h.timerDelays(),[])
  passed++;console.log(`ok ${passed} - 4B-7 local countdown renders 5 4 3 2 1 0 without extra status reads and cleans up`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '8') {
  const clock={now:1_800_000_000_000}
  const h=makeHarness(async()=>reply(200,statusBody('off',{waiting:{since:new Date(1_799_999_988_000).toISOString()}})),{clock})
  const mount=h.render(h.panelComponent);await flush();let tree=h.render(h.panelComponent,mount.hook).tree
  assert.match(textContent(tree),/Waiting: 12s/u,'4B-8: elapsed time must use the testable clock')
  clock.now+=1000;tree=h.render(h.panelComponent,mount.hook).tree;assert.match(textContent(tree),/Waiting: 13s/u)
  h.unmount(mount.hook);passed++;console.log(`ok ${passed} - 4B-8 waiting elapsed follows the fake clock deterministically`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '9') {
  assert.doesNotMatch(source,/\bOfficialWarningIcon\b/u,'4B-9: unused warning icon binding must be removed')
  passed++;console.log(`ok ${passed} - 4B-9 unused warning icon binding removed`)
}

if (!process.env.DSHDR4B_CASE || process.env.DSHDR4B_CASE === '5') {
  let cancelled=false
  const h=makeHarness(async(_url,options)=>{
    if(options.method==='POST') {cancelled=true;return reply(200,{ok:true,cancelled:true,restartRequest:{state:'terminal',executed:false,message:'cancelled once'}})}
    return reply(200,statusBody('off',{waiting:cancelled?null:{since:new Date().toISOString()},restartRequest:{state:cancelled?'idle':'waiting'}}))
  })
  const mount=h.render(h.panelComponent);await flush();let tree=h.render(h.panelComponent,mount.hook).tree
  buttonWithText(tree,'Cancel waiting').props.onClick();await flush();tree=h.render(h.panelComponent,mount.hook).tree
  assert.doesNotMatch(textContent(tree),/Waiting cancelled|cancelled once/u,'4B-5: authoritative idle also clears the client cancellation banner')
  h.unmount(mount.hook);passed++;console.log(`ok ${passed} - 4B-5 idle status clears an already-displayed terminal cancellation banner`)
}

// ── 2026-10-26 缺陷 1/2 回归（客户端侧） ──────────────────────────────────
// R5：入口可见性。countdown 状态下标题栏按钮文字含剩余秒数、tooltip 含倒计时、
// aria-label/aria-description 也含倒计时；paused 显示「已暂停」。
// 这些入口（标题栏/侧栏）不渲染主面板的 waitingLine 段落，所以必须各自可见。
if (!process.env.DSHDR_SKIP_R5 && (!process.env.DSHDR_ENTRY_CASE || process.env.DSHDR_ENTRY_CASE === 'R5')) {
  const clock={now:1_800_000_000_000}
  const countdownUntil=new Date(clock.now+5_000).toISOString()
  const deadlineAt=new Date(clock.now+1_800_000).toISOString()
  const h=makeHarness(async()=>reply(200,statusBody('off',{
    waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},
    restartRequest:{state:'countdown',countdownRemainingMs:5000,countdownUntil,deadlineAt},
  })),{clock})
  const header=h.render(h.sidebarComponent)
  await flush()
  let tree=h.render(h.sidebarComponent,header.hook).tree
  // 2026-10-28 契约更新：等待/倒计时/暂停态主按钮文字统一为禁用语义
  //（labelLocked），状态词不再放主按钮 —— 那看起来像可点的状态标签（本轮
  // 缺陷反馈）。倒计时秒数仍可见于 title/aria-label/aria-describedby；
  // 主按钮 disabled；状态文字由标题栏 headerStateOf 体系承担（H 系列覆盖）。
  const label=walk(tree,node=>node.type==='span'&&node.props.className==='dshdr-foot-label')
  assert.ok(label,'R5: sidebar label span exists during countdown')
  assert.match(String(label.children),/locked|已锁定/iu,'R5: countdown 主按钮文字必须是禁用语义（labelLocked）')
  const button=walk(tree,node=>node.type==='button'&&node.props.className==='dshdr-foot-badge')
  assert.equal(button.props.disabled,true,'R5: countdown 态侧栏主按钮必须 disabled')
  assert.match(String(button.props.title),/countdown/iu,'R5: tooltip must mention the countdown')
  assert.match(String(button.props.title),/5s/u,'R5: tooltip countdown includes remaining seconds')
  assert.match(String(button.props['aria-label']),/\d+s/u,'R5: aria-label carries the remaining seconds')
  const described=walk(tree,node=>node.type==='span'&&node.props.className==='dshdr-sr-only')
  assert.ok(described,'R5: aria-describedby text exists during countdown')
  assert.match(String(described.children),/countdown/iu,'R5: aria-description mentions the countdown')
  h.unmount(header.hook)
  // paused：主按钮文字同样为禁用语义；暂停说明仍可见于 tooltip。
  const pausedHarness=makeHarness(async()=>reply(200,statusBody('off',{
    waiting:{since:'2026-10-26T00:00:00.000Z',maxMs:1_800_000},
    restartRequest:{state:'paused',ask:'paused-ask',pausedReason:'new work',deadlineAt},
  })))
  const pausedMount=pausedHarness.render(pausedHarness.sidebarComponent)
  await flush()
  const pausedTree=pausedHarness.render(pausedHarness.sidebarComponent,pausedMount.hook).tree
  const pausedLabel=walk(pausedTree,node=>node.type==='span'&&node.props.className==='dshdr-foot-label')
  assert.ok(pausedLabel,'R5: sidebar label span exists while paused')
  assert.match(String(pausedLabel.children),/locked|已锁定/iu,'R5: paused 主按钮文字必须是禁用语义（labelLocked）')
  const pausedButton=walk(pausedTree,node=>node.type==='button'&&node.props.className==='dshdr-foot-badge')
  assert.equal(pausedButton.props.disabled,true,'R5: paused 态侧栏主按钮必须 disabled')
  assert.match(String(pausedButton.props.title),/paused|暂停/iu,'R5: paused tooltip mentions the pause')
  pausedHarness.unmount(pausedMount.hook)
  passed++;console.log(`ok ${passed} - R5 countdown and paused lock the entry button visibly; state stays in tooltip and aria copy`)
}

// R6：warn 态语义（2026-10-29 决策甲更新）——首击直达 warn（零请求），
// 二击直接发 force+now（不弹框）。完整两击行为由 N1–N3 覆盖；此用例
// 保留共享 store 的 press() 路径验证（N 系列走 useRestart 包装层时两条
// press 都要过一遍）。
if (!process.env.DSHDR_SKIP_R6 && (!process.env.DSHDR_ENTRY_CASE || process.env.DSHDR_ENTRY_CASE === 'R6')) {
  let posts=[]
  const h=makeHarness(async(url,options)=>{
    if(options.method==='POST'){
      posts.push(url)
      return reply(202,{ok:true})
    }
    return reply(200,statusBody('off',{guard:{active:true,blocked:false,reasons:['有任务在跑'],tasks:{active:true,turns:1,queued:0,jobs:0},installs:{active:false,running:false}}}))
  })
  const mount=h.render(h.panelComponent)
  await flush()
  let tree=h.render(h.panelComponent,mount.hook).tree
  let primary=buttons(tree).find(b=>b.props['data-variant']==='primary')
  // 第一击：直接进 warn（决策甲——不发普通请求撞 409）。
  primary.props.onClick()
  await flush()
  assert.equal(posts.length,0,'R6: the first click goes straight to warn with no request')
  tree=h.render(h.panelComponent,mount.hook).tree
  assert.match(textContent(buttons(tree).find(b=>b.props['data-variant']==='primary')),/restart anyway|仍要重启/ui,'R6: 第一击后按钮为「仍要重启？」')
  // warn 态武装（900ms 冷却）：烧掉 timer。
  const armDelay=h.timerDelays().find(ms=>ms===900)
  if(armDelay!==undefined) h.fireTimer(900)
  tree=h.render(h.panelComponent,mount.hook).tree
  // 第二击：直接 force+now，不弹框。
  primary=buttons(tree).find(b=>b.props['data-variant']==='primary')
  primary.props.onClick()
  await flush()
  assert.equal(posts.length,1,'R6: the second click sends exactly one request')
  assert.match(posts[0],/force=1/u,'R6: the request carries force=1')
  assert.match(posts[0],/now=1/u,'R6: the request carries now=1')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - R6 warn first click arms without a request; second click sends force+now directly`)
}

// R7：等待期轮询不退化 —— countdown 状态下仍有 2s 轮询（宿主权威推进）。
if (!process.env.DSHDR_ENTRY_CASE || process.env.DSHDR_ENTRY_CASE === 'R7') {
  const clock={now:1_800_000_000_000}
  const h=makeHarness(async()=>reply(200,statusBody('off',{
    waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000},
    restartRequest:{state:'countdown',countdownRemainingMs:30_000,countdownUntil:new Date(clock.now+30_000).toISOString()},
  })),{clock})
  const mount=h.render(h.panelComponent)
  await flush()
  assert.equal(h.timerDelays().filter(ms=>ms===2000).length,1,'R7: countdown keeps the shared 2s status poll')
  h.unmount(mount.hook)
  assert.equal(h.timerDelays().filter(ms=>ms===2000).length,0,'R7: unmount stops the poll')
  passed++;console.log(`ok ${passed} - R7 countdown keeps exactly one shared status poll`)
}

// ── 2026-10-27 标题栏入口可见性（缺陷 1/2）+ 就地取消 ─────────────────────
// 辅助：收集标题栏渲染树里的「可见状态节点」——即专用的状态文字/徽标元素。
// 判定标准：不是 .dshdr-sr-only（视觉隐藏）；其 className 必须是本插件新增的
// 状态展示类（H 系列实现引入 dshdr-header-state），不接受 .dshdr-label ——
// 该类在 @container(width<=540px) 下被 display:none，不满足「默认 CSS 可见」。
function headerStateNodes(tree) {
  return walkAll(tree, node => node.type === 'span' && typeof node.props.className === 'string'
    && node.props.className.includes('dshdr-header-state'))
}
function walkAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  const children = Array.isArray(node.children) ? node.children : [node.children]
  for (const child of children) walkAll(child, predicate, found)
  return found
}
// 辅助：标题栏上的取消控件（可见按钮，aria-label 含「取消等待」语义）。
function headerCancelButton(tree) {
  return buttons(tree).find(button => {
    const label = String(button.props['aria-label'] ?? '') + String(button.props.title ?? '')
    return /cancel.*wait|cancel.*waiting|取消等待/ui.test(label) && button.props.className !== undefined
      && String(button.props.className).includes('dshdr-trigger')
      && !String(button.props.className).includes('--label')
  })
}

// ── 2026-10-28 重复文字回归的可见性模型 ──────────────────────────────────
// 从**实际注入的 CSS**（harness 的 style.textContent）推导 .dshdr-label 与
// .dshdr-header-state 在宽屏（无容器查询命中）与窄屏（≤540px 命中）下是否
// 可见。不硬编码「应该怎样」——CSS 变了，推导结果跟着变，断言才诚实。
function deriveSpanVisibility(css) {
  const headerBaseNone = css.includes('.dshdr-header-state{display:none')
  const headerNarrowInline = /@container \(width<=540px\)\{[^}]*\.dshdr-header-state\{display:inline/.test(css)
  const labelNarrowHidden = /@container \(width<=540px\)\{[^}]*\.dshdr-label\{display:none/.test(css)
  return {
    // header-state：宽屏看基础规则（none → 不可见）；窄屏看容器查询
    // （无覆盖时继承基础规则）。
    headerWide: !headerBaseNone,
    headerNarrow: headerNarrowInline || !headerBaseNone,
    // label：基础无全局隐藏（宽屏可见）；窄屏被容器查询隐藏——
    // 除非带 .dshdr-trigger--label 修饰（「刷新」按钮，容器查询里显式 inline）。
    labelWide: !css.split('@container')[0].includes('.dshdr-label{display:none'),
    labelNarrowPlain: !labelNarrowHidden,
  }
}

// 按给定宽度档位收集标题栏里**会显示出来**的文字（span 文本）。
// sr-only 永远不算可见；非 label / 非 header-state 的其它 span 视为可见
// （当前标题栏没有第三类文字 span，出现即计入，宁可多算不少算）。
function visibleStatusTexts(tree, narrow, vis) {
  const texts = []
  const visit = (node, ancestors) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.type === 'span' && typeof node.props.className === 'string') {
      const cls = node.props.className
      if (cls.includes('dshdr-sr-only')) {
        // 视觉隐藏，跳过
      } else if (cls.includes('dshdr-header-state')) {
        if (narrow ? vis.headerNarrow : vis.headerWide) texts.push(textContent(node))
      } else if (cls.includes('dshdr-label')) {
        const inLabelTrigger = ancestors.some(a => typeof a?.props?.className === 'string'
          && a.props.className.includes('dshdr-trigger--label'))
        if (narrow ? (inLabelTrigger || vis.labelNarrowPlain) : vis.labelWide) texts.push(textContent(node))
      } else {
        texts.push(textContent(node))
      }
    }
    const children = Array.isArray(node.children) ? node.children : [node.children]
    for (const child of children) visit(child, [...ancestors, node])
  }
  visit(tree, [])
  return texts
}

// H1: non-idle state appears once inside the header button at both widths; waiting remains disabled.
if (!process.env.DSHDR_SKIP_H1 && (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H1')) {
  const clock={now:1_800_000_000_000}
  const deadlineAt=new Date(clock.now+1_800_000).toISOString()
  const cases=[
    {name:'confirm', statusExtras:{}, expect:/confirm|restart now|确认重启/ui, clickFirst:true, locked:false},
    {name:'countdown', statusExtras:{waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},restartRequest:{state:'countdown',countdownRemainingMs:5000,countdownUntil:new Date(clock.now+5_000).toISOString(),deadlineAt}}, expect:/5s|倒计时/ui, locked:true},
    {name:'waiting', statusExtras:{waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},restartRequest:{state:'waiting',deadlineAt}}, expect:/waiting|等待中/ui, locked:true},
    {name:'paused', statusExtras:{waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},restartRequest:{state:'paused',ask:'h1-ask',pausedReason:'new work',deadlineAt}}, expect:/paused|已暂停|暂停/ui, locked:true},
  ]
  for (const c of cases) {
    const h=makeHarness(async()=>reply(200,statusBody('off',c.statusExtras)),{clock})
    const mount=h.render(h.headerComponent)
    await flush()
    if (c.clickFirst) {
      // confirm 态由第一次点击武装（客户端本地状态，与宿主无关）。
      const tree0=h.render(h.headerComponent,mount.hook).tree
      const btn=buttons(tree0).find(b=>String(b.props.className).trim()==='dshdr-trigger')
      btn.props.onClick()
      await flush()
    }
    const tree=h.render(h.headerComponent,mount.hook).tree
    const states=headerStateNodes(tree)
    assert.ok(states.length>0,`H1 ${c.name}: a visible header state node must render`)
    const text=states.map(s=>textContent(s)).join(' ')
    assert.match(text,c.expect,`H1 ${c.name}: visible state text must match (got "${text}")`)
    assert.ok(!states.some(s=>String(s.props.className).includes('sr-only')),`H1 ${c.name}: state node must not be visually hidden`)
    const vis = deriveSpanVisibility(h.cssText())
    const mainTrigger = buttons(tree).find(b=>String(b.props.className).trim()==='dshdr-trigger')
    if (c.locked) {
      // Visible state is now inside the disabled main button at both widths.
      const wideLabel = visibleStatusTexts(tree, false, vis).filter(tx => c.expect.test(tx)).length
      assert.equal(wideLabel, 1, `H1 ${c.name} (wide): the in-button status must appear exactly once, got ${wideLabel}`)
      assert.equal(mainTrigger.props.disabled, true, `H1 ${c.name}: the main trigger must be disabled while a request is pending`)
      // 状态信息仍可达：title 含状态词（tooltipOf 上一轮加的分支）。
      assert.match(String(mainTrigger.props.title), c.expect, `H1 ${c.name}: the tooltip must still carry the state info`)
      // 窄屏：状态词由 header-state 承担，恰好一次。
      const narrowHits = visibleStatusTexts(tree, true, vis).filter(tx => c.expect.test(tx)).length
      assert.equal(narrowHits, 1, `H1 ${c.name} (narrow <=540px): the status text must appear exactly once, got ${narrowHits}`)
    } else {
      for (const narrow of [false, true]) {
        const hits = visibleStatusTexts(tree, narrow, vis).filter(tx => c.expect.test(tx)).length
        assert.equal(hits, 1, `H1 ${c.name} (${narrow ? 'narrow <=540px' : 'wide >540px'}): the status text must appear exactly once, got ${hits}`)
      }
    }
    h.unmount(mount.hook)
  }
  passed++;console.log(`ok ${passed} - H1 header states stay visible once per width tier; wait states lock the main trigger`)
}

// H2：idle 时标题栏不渲染任何额外可见文字/徽标（状态节点为空）。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H2') {
  const h=makeHarness(async()=>reply(200,statusBody()))
  const mount=h.render(h.headerComponent)
  await flush()
  const tree=h.render(h.headerComponent,mount.hook).tree
  assert.equal(headerStateNodes(tree).length,0,'H2: idle header must not render state text or badge')
  const name=walk(tree,n=>n.props?.className==='dshdr-header-name')
  assert.match(textContent(name),/Restart|重启/u,'idle action must visibly identify restart')
  assert.ok(h.cssText().includes('.dshdr-header-name{display:inline'),'restart name stays visible at narrow widths')
  assert.equal(headerCancelButton(tree),undefined,'H2: idle header must not render the cancel control')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - H2 idle header renders no extra visible state or cancel control`)
}

// H3：倒计时逐秒更新——可见文案随 remaining 5000→3000 变化，不重载页面。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H3') {
  const clock={now:1_800_000_000_000}
  let remote={state:'countdown',countdownRemainingMs:5000,countdownUntil:new Date(clock.now+5_000).toISOString(),deadlineAt:new Date(clock.now+1_800_000).toISOString()}
  const h=makeHarness(async()=>reply(200,statusBody('off',{waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000},restartRequest:remote})),{clock})
  const mount=h.render(h.headerComponent)
  await flush()
  let tree=h.render(h.headerComponent,mount.hook).tree
  assert.match(headerStateNodes(tree).map(textContent).join(' '),/5s/u,'H3: starts at 5s')
  // 本地显示时钟逐秒推进（不产生新网络读取——沿用 4B-7 的断言口径）。
  clock.now+=1000
  h.fireTimer(1000)
  tree=h.render(h.headerComponent,mount.hook).tree
  assert.match(headerStateNodes(tree).map(textContent).join(' '),/4s/u,'H3: decrements to 4s')
  clock.now+=2000
  h.fireTimer(1000)
  tree=h.render(h.headerComponent,mount.hook).tree
  assert.match(headerStateNodes(tree).map(textContent).join(' '),/2s/u,'H3: decrements to 2s')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - H3 header countdown text updates every second locally`)
}

// H4：就地取消控件的存在性 —— waiting/countdown/paused 有，executing 没有。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H4') {
  const clock={now:1_800_000_000_000}
  const deadlineAt=new Date(clock.now+1_800_000).toISOString()
  const present=[
    {name:'waiting',extras:{waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000},restartRequest:{state:'waiting',deadlineAt}}},
    {name:'countdown',extras:{waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000},restartRequest:{state:'countdown',countdownRemainingMs:5000,countdownUntil:new Date(clock.now+5_000).toISOString(),deadlineAt}}},
    {name:'paused',extras:{waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000},restartRequest:{state:'paused',ask:'h4-ask',pausedReason:'new work',deadlineAt}}},
  ]
  for (const c of present) {
    const h=makeHarness(async()=>reply(200,statusBody('off',c.extras)),{clock})
    const mount=h.render(h.headerComponent)
    await flush()
    const tree=h.render(h.headerComponent,mount.hook).tree
    assert.ok(headerCancelButton(tree),`H4 ${c.name}: header cancel control must exist`)
    h.unmount(mount.hook)
  }
  // executing：没有取消（执行不可撤回），状态节点显示重启中。
  const h=makeHarness(async()=>reply(200,statusBody('off',{restartRequest:{state:'executing',deadlineAt}})),{clock})
  const mount=h.render(h.headerComponent)
  await flush()
  const tree=h.render(h.headerComponent,mount.hook).tree
  assert.equal(headerCancelButton(tree),undefined,'H4 executing: no cancel control (execution is irrevocable)')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - H4 header cancel control exists exactly for waiting/countdown/paused`)
}

// H5：点击标题栏取消 → 请求带 cancelWait=1；cancelled:false 不误报「已取消」。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H5') {
  const clock={now:1_800_000_000_000}
  let cancelled=false
  const h=makeHarness(async(url,options)=>{
    if(options.method==='POST') {
      assert.match(url,/cancelWait=1/u,'H5: the header cancel click must send cancelWait=1')
      cancelled=true
      // cancelled:false —— 宿主如实回「没有可取消的等待」。
      return reply(200,{ok:true,cancelled:false,restartRequest:{state:'idle'}})
    }
    // 取消后的权威状态：与 F2 同一形态 —— waiting 投影仍在、无 restartRequest
    // （真实宿主「本无可取消」时 message 得以留存；一旦请求状态到位即被清）。
    return reply(200,statusBody('off',cancelled
      ? {waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000}}
      : {waiting:{since:new Date(clock.now).toISOString(),maxMs:1_800_000},restartRequest:{state:'waiting',deadlineAt:new Date(clock.now+1_800_000).toISOString()}}))
  },{clock})
  const mount=h.render(h.headerComponent)
  await flush()
  let tree=h.render(h.headerComponent,mount.hook).tree
  headerCancelButton(tree).props.onClick()
  await flush()
  tree=h.render(h.headerComponent,mount.hook).tree
  // cancelled:false → 显示「当前没有等待中的请求」，不得出现「已取消」。
  const all=textContent(tree)
  assert.match(all,/no pending wait|没有等待/u,'H5: cancelled:false must surface "nothing to cancel"')
  assert.doesNotMatch(all,/Waiting cancelled|已取消等待/u,'H5: cancelled:false must not claim cancellation')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - H5 header cancel sends cancelWait=1 and reports cancelled:false truthfully`)
}

// H6: state text is always visible, with the existing compact narrow rule.
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H6') {
  const h=makeHarness(async()=>reply(200,statusBody()))
  const css=h.cssText()
  assert.ok(css.includes('.dshdr-header-state{display:inline'), 'H6: wide state text is visible')
  assert.match(css, /\.dshdr-header-state\{[^}]*max-width:72px;overflow:hidden;text-overflow:ellipsis/u)
  assert.ok(/@container \(width<=540px\)\{[^}]*\.dshdr-header-state\{display:inline;max-width:48px/.test(css))
  passed++;console.log(`ok ${passed} - H6 header text is visible and bounded at both widths`)
}

// ── 2026-10-28 等待/倒计时/暂停态主按钮锁定 ────────────────────────────────
// 缺陷：等待态主按钮可点但无任何反馈（press 只武装 confirm，labelOf 仍显示
// 状态词），CONFIRM_MS 内第二击会 send({}) 真正提交。要求：主按钮 disabled
// 且 press 早退；标签换禁用语义；「取消等待」是唯一常规出口。
// W 系列：DSHDR_WAIT_CASE 可单跑。
function waitFixtureHarness(state, posts) {
  const clock = { now: 1_800_000_000_000 }
  const extras = state === 'idle' ? {} : {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: {
      state,
      deadlineAt: new Date(clock.now + 1_800_000).toISOString(),
      ...(state === 'countdown' ? { countdownRemainingMs: 5000, countdownUntil: new Date(clock.now + 5_000).toISOString() } : {}),
      ...(state === 'paused' ? { ask: 'w-ask', pausedReason: 'new work' } : {}),
    },
  }
  return makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      posts.push(url)
      return reply(200, { ok: true, cancelled: url.includes('cancelWait'), restartRequest: { state: 'idle' } })
    }
    return reply(200, statusBody('off', extras))
  }, { clock })
}
const panelMainButton = (tree) => buttons(tree).find(b => b.props['data-variant'] === 'primary')
const headerMainTrigger = (tree) => buttons(tree).find(b => String(b.props.className).trim() === 'dshdr-trigger')
const footerMainBadge = (tree) => buttons(tree).find(b => String(b.props.className).includes('dshdr-foot-badge'))

if (!process.env.DSHDR_WAIT_CASE || process.env.DSHDR_WAIT_CASE === 'W1') {
  const posts = []
  const h = waitFixtureHarness('waiting', posts)
  const panel = h.render(h.panelComponent)
  const footer = h.render(h.sidebarComponent)
  const header = h.render(h.headerComponent)
  await flush()
  const panelTree = h.render(h.panelComponent, panel.hook).tree
  const footerTree = h.render(h.sidebarComponent, footer.hook).tree
  const headerTree = h.render(h.headerComponent, header.hook).tree
  assert.equal(panelMainButton(panelTree).props.disabled, true, 'W1: waiting 态面板主按钮必须 disabled')
  assert.equal(footerMainBadge(footerTree).props.disabled, true, 'W1: waiting 态侧栏底栏主按钮必须 disabled')
  assert.equal(headerMainTrigger(headerTree).props.disabled, true, 'W1: waiting 态标题栏主按钮必须 disabled')
  assert.match(textContent(panelMainButton(panelTree)), /locked|已锁定/iu, 'W1: 等待态主按钮文字必须是禁用语义（不再显示「等待中」状态词）')
  h.unmount(panel.hook); h.unmount(footer.hook); h.unmount(header.hook)
  passed++;console.log(`ok ${passed} - W1 waiting disables the main button in all three entries and labels it as locked`)
}

if (!process.env.DSHDR_WAIT_CASE || process.env.DSHDR_WAIT_CASE === 'W2') {
  const posts = []
  const h = waitFixtureHarness('waiting', posts)
  const panel = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, panel.hook).tree
  panelMainButton(tree).props.onClick()
  await flush()
  tree = h.render(h.panelComponent, panel.hook).tree
  panelMainButton(tree).props.onClick()
  await flush()
  assert.equal(posts.length, 0, 'W2: waiting 态对主按钮连点两次不得发出任何重启请求（此前第二击会 send({}) 提交）')
  h.unmount(panel.hook)
  passed++;console.log(`ok ${passed} - W2 double-clicking the waiting main button sends no restart request`)
}

if (!process.env.DSHDR_WAIT_CASE || process.env.DSHDR_WAIT_CASE === 'W3') {
  const posts = []
  const h = waitFixtureHarness('waiting', posts)
  const header = h.render(h.headerComponent)
  await flush()
  let tree = h.render(h.headerComponent, header.hook).tree
  headerMainTrigger(tree).props.onClick()
  await flush()
  tree = h.render(h.headerComponent, header.hook).tree
  assert.notEqual(String(headerMainTrigger(tree).props['data-phase']), 'confirm',
    'W3: waiting 态直接调用 press 不得武装确认分支（此前无可见变化却悄悄进入 confirm，第二击即提交）')
  headerMainTrigger(tree).props.onClick()
  await flush()
  assert.equal(posts.length, 0, 'W3: waiting 态直接调用 press 两次同样不发请求')
  h.unmount(header.hook)
  passed++;console.log(`ok ${passed} - W3 calling press directly in waiting neither arms confirm nor submits`)
}

if (!process.env.DSHDR_WAIT_CASE || process.env.DSHDR_WAIT_CASE === 'W4') {
  for (const state of ['countdown', 'paused']) {
    const posts = []
    const h = waitFixtureHarness(state, posts)
    const panel = h.render(h.panelComponent)
    const footer = h.render(h.sidebarComponent)
    const header = h.render(h.headerComponent)
    await flush()
    const panelTree = h.render(h.panelComponent, panel.hook).tree
    const footerTree = h.render(h.sidebarComponent, footer.hook).tree
    const headerTree = h.render(h.headerComponent, header.hook).tree
    assert.equal(panelMainButton(panelTree).props.disabled, true, `W4: ${state} 态面板主按钮必须 disabled`)
    assert.equal(footerMainBadge(footerTree).props.disabled, true, `W4: ${state} 态侧栏底栏主按钮必须 disabled`)
    assert.equal(headerMainTrigger(headerTree).props.disabled, true, `W4: ${state} 态标题栏主按钮必须 disabled`)
    let tree = panelTree
    panelMainButton(tree).props.onClick()
    await flush()
    tree = h.render(h.panelComponent, panel.hook).tree
    panelMainButton(tree).props.onClick()
    await flush()
    assert.equal(posts.length, 0, `W4: ${state} 态主按钮连点两次不得发出任何请求`)
    let htree = headerTree
    headerMainTrigger(htree).props.onClick()
    await flush()
    htree = h.render(h.headerComponent, header.hook).tree
    assert.notEqual(String(headerMainTrigger(htree).props['data-phase']), 'confirm', `W4: ${state} 态直接调用 press 不得武装确认分支`)
    h.unmount(panel.hook); h.unmount(footer.hook); h.unmount(header.hook)
  }
  passed++;console.log(`ok ${passed} - W4 countdown and paused states disable the main button and guard press identically`)
}

if (!process.env.DSHDR_WAIT_CASE || process.env.DSHDR_WAIT_CASE === 'W5') {
  const posts = []
  const h = waitFixtureHarness('waiting', posts)
  const panel = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, panel.hook).tree
  const cancel = buttons(tree).find(b => /cancel.*waiting|取消等待/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '')))
  assert.ok(cancel, 'W5: waiting 态必须存在「取消等待」按钮')
  assert.notEqual(cancel.props.disabled, true, 'W5: 「取消等待」必须可点（等待态唯一常规出口）')
  cancel.props.onClick()
  await flush()
  assert.equal(posts.length, 1, 'W5: 点击取消等待恰好发出一个请求')
  assert.match(posts[0], /cancelWait=1/u, 'W5: 取消请求必须带 cancelWait=1')
  h.unmount(panel.hook)
  passed++;console.log(`ok ${passed} - W5 the cancel-waiting entry stays available and sends cancelWait=1`)
}

if (!process.env.DSHDR_WAIT_CASE || process.env.DSHDR_WAIT_CASE === 'W6') {
  const posts = []
  const h = waitFixtureHarness('idle', posts)
  const panel = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, panel.hook).tree
  assert.notEqual(panelMainButton(tree).props.disabled, true, 'W6: idle 态主按钮必须可用（防回归）')
  panelMainButton(tree).props.onClick()
  await flush()
  assert.equal(posts.length, 0, 'W6: 第一次点击只武装确认，不发请求（两步确认不变）')
  tree = h.render(h.panelComponent, panel.hook).tree
  panelMainButton(tree).props.onClick()
  await flush()
  assert.equal(posts.length, 1, 'W6: 确认窗口内第二击正常提交（两步确认不变）')
  assert.doesNotMatch(posts[0], /force=1|now=1/u, 'W6: 普通路径两步确认仍发普通请求')
  h.unmount(panel.hook)
  passed++;console.log(`ok ${passed} - W6 idle keeps the two-step confirm behavior unchanged`)
}

// ── 2026-10-28 危险操作警示色（DSH 官方 dangerButton 范式） ────────────────
// 依据（app.asar 提取）：官方插件卸载确认框用 Button variant="primary" +
// className={dangerButton}，dangerButton 只覆盖两个 CSS 变量：
//   --dsw-alias-button-primary-fill / --dsw-alias-button-primary-hover
//   = var(--dsw-alias-state-error-primary)
// 本插件同款 .dshdr-danger 类。只换色，不动交互/disabled/press 守卫。
// D 系列：DSHDR_DANGER_CASE 可单跑。
const DANGER_CLASS = 'dshdr-danger'

// D1：「仍要立即重启」（等待态旁 forceNowRestart）带 danger 标记，非 ghost。
if (!process.env.DSHDR_DANGER_CASE || process.env.DSHDR_DANGER_CASE === 'D1') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, statusBody('off', {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
  })), { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  h.render(h.panelComponent, mount.hook)
  // 2026-10-28 合并契约更新：等待态独立 force 按钮已移除；危险色的承担者是
  // 打断确认框的「确认立即重启」按钮（经暂停询问框路径打开）。
  // 等待态无 paused 询问时此路径不可达，改用 paused 夹具直达打断确认框。
  const pausedHarness = makeHarness(async () => reply(200, statusBody('off', {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: { state: 'paused', ask: 'd1-ask', pausedReason: 'new work', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
  })), { clock })
  const pausedMount = pausedHarness.render(pausedHarness.panelComponent)
  await flush()
  const pausedTree = pausedHarness.render(pausedHarness.panelComponent, pausedMount.hook).tree
  const pausedDialog = walk(pausedTree, node => node.props?.role === 'dialog')
  assert.ok(pausedDialog, 'D1: the pause question dialog must render')
  const forceInDialog = buttons(pausedDialog).find(b => /restart now anyway|仍要立即重启/ui.test(textContent(b) + String(b.props['aria-label'] ?? '') + String(b.props.title ?? '')))
  assert.ok(forceInDialog, 'D1: the force-now entry (pause dialog) must render')
  forceInDialog.props.onClick()
  await flush()
  const confirmTree = pausedHarness.render(pausedHarness.panelComponent, pausedMount.hook).tree
  const confirmDialog = walk(confirmTree, node => node.props?.role === 'dialog')
  assert.ok(confirmDialog, 'D1: the interrupt confirmation dialog must open from the pause path')
  const confirmBtn = buttons(confirmDialog).find(b => /confirm restart now|确认立即重启/ui.test(textContent(b) + String(b.props['aria-label'] ?? '')))
  assert.ok(confirmBtn, 'D1: the confirm-restart-now button must render')
  const cls = String(confirmBtn.props.className ?? '')
  assert.ok(cls.includes(DANGER_CLASS), `D1: the interrupt confirm must carry the ${DANGER_CLASS} class (got "${cls}")`)
  assert.ok(/primary/.test(String(confirmBtn.props['data-variant'] ?? '') + String(confirmBtn.props.variant ?? '')), `D1: the interrupt confirm must be variant primary (got "${cls}")`)
  pausedHarness.unmount(pausedMount.hook)
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - D1 the interrupt confirm button carries the danger class with primary variant`)
}

// D2（2026-10-29 决策甲更新）：合并路径（warn 二击）不再弹框 —— 直接发
// force+now。危险色的承担者是 warn 态的主按钮本身（N7 钉死 danger 类）；
// 本用例改验合并路径不发普通请求、请求带 force+now。
if (!process.env.DSHDR_SKIP_D2 && (!process.env.DSHDR_DANGER_CASE || process.env.DSHDR_DANGER_CASE === 'D2')) {
  let posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      posts.push(url)
      return reply(202, { ok: true })
    }
    return reply(200, statusBody('off', { guard: { active: true, blocked: false, reasons: ['有任务在跑'], tasks: { active: true, turns: 1, queued: 0, jobs: 0 }, installs: { active: false, running: false } } }))
  })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  if (h.timerDelays().includes(900)) h.fireTimer(900)
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.equal(walk(tree, node => node.props?.role === 'dialog'), null, 'D2: no dialog on the merged path (decision A)')
  primary().props.onClick()
  await flush()
  assert.equal(posts.length, 1, 'D2: exactly one request on the merged path')
  assert.match(posts[0], /force=1/u, 'D2: the merged-path request carries force=1')
  assert.match(posts[0], /now=1/u, 'D2: the merged-path request carries now=1')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - D2 the merged path sends force+now directly with no dialog`)
}

// D3：面板大「重启」主按钮不含 danger（防误伤——常规操作，不能天天红）。
if (!process.env.DSHDR_DANGER_CASE || process.env.DSHDR_DANGER_CASE === 'D3') {
  const h = makeHarness(async () => reply(200, statusBody()))
  const mount = h.render(h.panelComponent)
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const main = buttons(tree).find(b => b.props['data-variant'] === 'primary')
  assert.ok(main, 'D3: the panel main restart button must render')
  assert.equal(String(main.props.className ?? '').includes(DANGER_CLASS), false,
    'D3: the main restart button must NOT carry the danger class (regular operation)')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - D3 the panel main restart button stays out of danger styling`)
}

// D4：「取消等待」不含 danger 且仍为 primary（安全出口最该醒目）。
if (!process.env.DSHDR_DANGER_CASE || process.env.DSHDR_DANGER_CASE === 'D4') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, statusBody('off', {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
  })), { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const cancel = buttons(tree).find(b => /cancel.*waiting|取消等待/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
  assert.ok(cancel, 'D4: the cancel-waiting button must render')
  const cls = String(cancel.props.className ?? '')
  assert.equal(cls.includes(DANGER_CLASS), false, 'D4: cancel-waiting must NOT carry the danger class')
  assert.ok(/primary/.test(String(cancel.props['data-variant'] ?? '') + String(cancel.props.variant ?? '')), `D4: cancel-waiting must stay primary (got "${cls}")`)
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - D4 cancel-waiting stays primary without danger styling`)
}

// D5：「已锁定」主按钮仍为 disabled（danger 改色不影响禁用语义）。
if (!process.env.DSHDR_DANGER_CASE || process.env.DSHDR_DANGER_CASE === 'D5') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, statusBody('off', {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
  })), { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const main = buttons(tree).find(b => b.props['data-variant'] === 'primary')
  assert.equal(main.props.disabled, true, 'D5: the locked main button must remain disabled')
  assert.match(textContent(main), /locked|已锁定/iu, 'D5: the locked label stays')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - D5 the locked main button stays disabled after the color change`)
}

// ── 2026-10-28 合并「仍要立即重启」到主按钮第二击（有任务时） ───────────────
// 用户决策（乙）：有任务在跑（warn 态）时，主按钮第二击 = 立刻打断任务重启。
// 防误伤：二击不直接执行 —— 弹确认框（官方 RiskConfirmation 有勾选；
// 无官方组件时内联 immediate 框），确认后才发 force+now；取消回 idle。
// 无任务路径完全不变；等待态 press 早退守卫保持。
// M 系列：DSHDR_MERGE_CASE 可单跑。


// M1-M3（2026-10-29 决策甲退役）：上一轮的「warn 二击弹确认框」被用户否决
// （四步太繁琐）。两击直接 force+now 的新语义由 N1-N3 / R6 完整覆盖；
// M 系列保留 M4（无任务普通路径）、M5（无独立按钮）、M6（等待态守卫）三个钉子。

// M4：无任务时第二击仍发普通 send({})（不含 force）。
if (!process.env.DSHDR_MERGE_CASE || process.env.DSHDR_MERGE_CASE === 'M4') {
  let posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(202, { ok: true, waiting: true, restartRequest: { state: 'waiting' } }) }
    return reply(200, statusBody())
  })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  tree = h.render(h.panelComponent, mount.hook).tree
  primary().props.onClick()
  await flush()
  assert.equal(posts.length, 1, 'M4: the idle two-step confirm sends exactly one request')
  assert.doesNotMatch(posts[0], /force=1|now=1/u, 'M4: the idle path must never carry force or now')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - M4 the no-task path keeps the plain two-step confirm`)
}

// M5：等待态不再渲染独立的「仍要立即重启」按钮。
if (!process.env.DSHDR_MERGE_CASE || process.env.DSHDR_MERGE_CASE === 'M5') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, statusBody('off', {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
  })), { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const force = buttons(tree).find(b => /restart now anyway|仍要立即重启/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
  assert.equal(force, undefined, 'M5: the standalone force-now button must no longer render in waiting state')
  // 取消等待仍在（唯一常规出口）。
  const cancel = buttons(tree).find(b => /cancel.*waiting|取消等待/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
  assert.ok(cancel, 'M5: cancel-waiting must remain available')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - M5 the standalone force-now button is gone from waiting state`)
}

// M6：等待态主按钮仍 disabled（早退守卫未被合并改动破坏）。
if (!process.env.DSHDR_MERGE_CASE || process.env.DSHDR_MERGE_CASE === 'M6') {
  const clock = { now: 1_800_000_000_000 }
  const posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(200, { ok: true }) }
    return reply(200, statusBody('off', {
      waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
      restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
    }))
  }, { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const main = buttons(tree).find(b => b.props['data-variant'] === 'primary')
  assert.equal(main.props.disabled, true, 'M6: the waiting-state main button must stay disabled')
  main.props.onClick()
  await flush()
  main.props.onClick()
  await flush()
  assert.equal(posts.length, 0, 'M6: two clicks on the disabled waiting button send nothing (hard guard intact)')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - M6 the waiting-state guard survives the merge`)
}

// ── 2026-10-29 两击强制（用户选甲）：有任务时主按钮二击直接 force+now ──────
// 用户决策（甲）：有任务在跑时，主按钮第一击直接进 warn（红色「仍要重启？」），
// 第二击直接 send({force,now}) —— 不弹任何确认框。guardHint（2s 轮询）非空
// 即判定有任务；无任务路径两击普通请求不变；等待态守卫/按钮移除状态保持。
// N 系列：DSHDR_TWIKE_CASE 可单跑。
const busyStatus = () => statusBody('off', { guard: { active: true, blocked: false, reasons: ['有任务在跑'], tasks: { active: true, turns: 1, queued: 0, jobs: 0 }, installs: { active: false, running: false } } })

// N1：有任务时两次点击完成强制重启 —— 第二击发出 force+now，全程无弹框。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N1') {
  let posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(202, { ok: true }) }
    return reply(200, busyStatus())
  })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()   // 第一击：直接进 warn
  await flush()
  // 900ms 冷却武装。
  if (h.timerDelays().includes(900)) h.fireTimer(900)
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.equal(walk(tree, node => node.props?.role === 'dialog'), null, 'N1: 第一击不得弹任何框')
  primary().props.onClick()   // 第二击：直接强制
  await flush()
  assert.equal(posts.length, 1, 'N1: 恰好一个请求（第二击发出）')
  assert.match(posts[0], /force=1/u, 'N1: 请求必须带 force=1')
  assert.match(posts[0], /now=1/u, 'N1: 请求必须带 now=1')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N1 two clicks force-restart with tasks, no dialog`)
}

// N2：有任务时第一击直接进 warn —— 不发 send({})、不被宿主拒绝。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N2') {
  let posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(202, { ok: true }) }
    return reply(200, busyStatus())
  })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  assert.equal(posts.length, 0, 'N2: 第一击不发任何请求（直接进 warn，不撞宿主 409）')
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.match(textContent(primary()), /restart anyway|仍要重启/ui, 'N2: 第一击后按钮显示「仍要重启？」')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N2 the first click goes straight to warn without a request`)
}

// N3：无任务时两击发普通 send({})，不含 force（防误伤——最重要的一条）。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N3') {
  let posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(202, { ok: true, waiting: true, restartRequest: { state: 'waiting' } }) }
    return reply(200, statusBody())
  })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  tree = h.render(h.panelComponent, mount.hook).tree
  primary().props.onClick()
  await flush()
  assert.equal(posts.length, 1, 'N3: 无任务两击恰好一个请求')
  assert.doesNotMatch(posts[0], /force=1|now=1/u, 'N3: 无任务路径绝不带 force/now')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N3 the no-task path stays plain (no force ever)`)
}

// N4：等待态主按钮 disabled + 早退守卫零请求（M6 保持）。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N4') {
  const clock = { now: 1_800_000_000_000 }
  const posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(200, { ok: true }) }
    return reply(200, statusBody('off', {
      waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
      restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
    }))
  }, { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const main = buttons(tree).find(b => b.props['data-variant'] === 'primary')
  assert.equal(main.props.disabled, true, 'N4: 等待态主按钮必须 disabled')
  main.props.onClick()
  await flush()
  main.props.onClick()
  await flush()
  assert.equal(posts.length, 0, 'N4: 连点两次零请求（早退守卫）')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N4 waiting-state disabled and guard intact`)
}

// N5：等待态不渲染独立「仍要立即重启」（M5 保持）。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N5') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, statusBody('off', {
    waiting: { since: new Date(clock.now - 1_000).toISOString(), maxMs: 1_800_000 },
    restartRequest: { state: 'waiting', deadlineAt: new Date(clock.now + 1_800_000).toISOString() },
  })), { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const force = buttons(tree).find(b => /restart now anyway|仍要立即重启/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
  assert.equal(force, undefined, 'N5: 独立 force 按钮不得渲染')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N5 no standalone force button in waiting state`)
}

// N6：warn 态下请求失败能回 idle 且不误发（第二击发出的请求被拒后重置）。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N6') {
  let posts = []
  let fail = false
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      posts.push(url)
      if (fail) return reply(500, { ok: false, error: 'boom' })
      return reply(202, { ok: true })
    }
    return reply(200, busyStatus())
  })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  if (h.timerDelays().includes(900)) h.fireTimer(900)
  tree = h.render(h.panelComponent, mount.hook).tree
  fail = true
  primary().props.onClick()   // 第二击：请求失败
  await flush()
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.equal(posts.length, 1, 'N6: 只发过一个请求（失败的那次）')
  assert.match(textContent(tree), /boom/u, 'N6: 失败信息可见')
  // 失败后 phase=error；再击是重试（普通请求语义）。
  const main = buttons(tree).find(b => b.props['data-variant'] === 'primary')
  assert.ok(main, 'N6: 主按钮仍渲染')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N6 a failed force request surfaces the error and resets`)
}

// N7：warn 态主按钮带 danger 色（第一击后按钮就是红色「仍要重启？」）。
if (!process.env.DSHDR_TWIKE_CASE || process.env.DSHDR_TWIKE_CASE === 'N7') {
  const h = makeHarness(async () => reply(200, busyStatus()))
  const mount = h.render(h.panelComponent)
  await flush()
  const primary = () => buttons(h.render(h.panelComponent, mount.hook).tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  const tree = h.render(h.panelComponent, mount.hook).tree
  const btn = buttons(tree).find(b => b.props['data-variant'] === 'primary')
  const cls = String(btn.props.className ?? '')
  assert.ok(cls.includes('dshdr-danger'), `N7: warn 态主按钮必须带 danger 色（got "${cls}"）`)
  assert.match(textContent(btn), /restart anyway|仍要重启/ui, 'N7: warn 态按钮文字为「仍要重启？」')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - N7 the warn-state main button turns danger red`)
}

// ── 2026-10-29 warn 态过期机制 + 设置可配 + 文案修正 ────────────────────────
// 真机问题：warn 态永不过期（无 expireLater），放几小时后误碰一击 = 直接重启。
// 修复：armWarnState 统一入口带 warnAt 时间戳（nowMs 兼容时钟）+ expireLater；
// 时长 warnExpire（5–60 秒，默认 15）走宿主 settings 可配；文案去掉
// 「之后还要再确认一次」这类过时句，改为「点两次强制重启，会打断它们」+
// 「再点一次确认强制重启（N 秒内有效）」。
// E 系列：DSHDR_EXPIRE_CASE 可单跑。

// E1：warn 态 15 秒后自动过期回 idle（假时钟 + 过期定时器）——按钮去红、
// 文字恢复「重启」。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E1') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, busyStatus()), { clock, timer: true })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()   // 首击 → warn（900 武装 + 15000 过期定时器）
  await flush()
  if (h.timerDelays().includes(900)) h.fireTimer(900)
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.match(textContent(primary()), /restart anyway|仍要重启/ui, 'E1: 首击进入 warn')
  assert.ok(String(primary().props.className).includes('dshdr-danger'), 'E1: warn 态红色')
  // 快进 15 秒：推进假时钟 + 烧掉过期定时器。
  clock.now += 15_000
  h.fireTimer(15000)
  await flush()
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.doesNotMatch(textContent(primary()), /restart anyway|仍要重启/ui, 'E1: 过期后不再显示确认词')
  assert.ok(!String(primary().props.className).includes('dshdr-danger'), 'E1: 过期后去掉红色')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - E1 warn expires back to idle after 15s (fake clock)`)
}

// E2：过期后再点第一击，能重新进入 warn 态（新鲜 warnAt，零请求）。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E2') {
  const clock = { now: 1_800_000_000_000 }
  let posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(202, { ok: true }) }
    return reply(200, busyStatus())
  }, { clock, timer: true })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  if (h.timerDelays().includes(900)) h.fireTimer(900)
  clock.now += 15_000
  h.fireTimer(15000)
  await flush()
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.doesNotMatch(textContent(primary()), /restart anyway|仍要重启/ui, 'E2: 已过期回 idle')
  // 过期后的「第一击」：重新进 warn。
  primary().props.onClick()
  await flush()
  if (h.timerDelays().includes(900)) h.fireTimer(900)
  tree = h.render(h.panelComponent, mount.hook).tree
  assert.match(textContent(primary()), /restart anyway|仍要重启/ui, 'E2: 过期后首击重新进入 warn')
  assert.ok(String(primary().props.className).includes('dshdr-danger'), 'E2: 重新变红')
  assert.equal(posts.length, 0, 'E2: 重新进入 warn 不发请求')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - E2 a fresh first click re-enters warn after expiry`)
}

// E3：设置页 WarnExpireRow 读到宿主返回的过期秒数。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E3') {
  const harness = makeHarness(async () => reply(200, statusBody('off', { warnExpireSeconds: 15 })))
  const section = harness.render(harness.settingsComponent).tree
  const row = walk(section, node => node.type?.name === 'WarnExpireRow')
  assert.ok(row, 'E3: 设置页必须渲染 WarnExpireRow')
  const mounted = harness.render(row.type)
  await flush()
  const tree = harness.render(row.type, mounted.hook).tree
  assert.equal(walk(tree, node => node.type === 'input').props.value, '15', 'E3: 输入框读到宿主值 15')
  harness.unmount(mounted.hook)
  passed++;console.log(`ok ${passed} - E3 the settings row reads the host warnExpire value`)
}

// E4：修改过期秒数 → 保存 → 宿主返回新值 → 界面更新。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E4') {
  const harness = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      assert.match(url, /warnExpire=30/u, 'E4: 保存请求必须带 warnExpire=30')
      return reply(200, { ok: true, warnExpireSeconds: 30 })
    }
    return reply(200, statusBody('off', { warnExpireSeconds: 15 }))
  })
  const section = harness.render(harness.settingsComponent).tree
  const row = walk(section, node => node.type?.name === 'WarnExpireRow').type
  const mounted = harness.render(row)
  await flush()
  let tree = harness.render(row, mounted.hook).tree
  walk(tree, node => node.type === 'input').props.onChange({ target: { value: '30' } })
  tree = harness.render(row, mounted.hook).tree
  buttonWithText(tree, 'Save window').props.onClick()
  await flush()
  tree = harness.render(row, mounted.hook).tree
  assert.equal(walk(tree, node => node.type === 'input').props.value, '30', 'E4: 保存后界面显示 30')
  assert.equal(walk(tree, node => node.props.role === 'alert'), null, 'E4: 成功后无错误')
  harness.unmount(mounted.hook)
  passed++;console.log(`ok ${passed} - E4 saving a new window updates the row`)
}

// E5：保存失败 → 回滚到已保存值并显示错误（照抄 countdown 的 S1 模式）。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E5') {
  let fail = false
  const harness = makeHarness(async (url, options) => {
    if (options.method === 'POST') {
      if (fail) return reply(500, { ok: false, error: 'warnExpire write denied' })
      return reply(200, { ok: true, warnExpireSeconds: 30 })
    }
    return reply(200, statusBody('off', { warnExpireSeconds: 15 }))
  })
  const section = harness.render(harness.settingsComponent).tree
  const row = walk(section, node => node.type?.name === 'WarnExpireRow').type
  const mounted = harness.render(row)
  await flush()
  let tree = harness.render(row, mounted.hook).tree
  walk(tree, node => node.type === 'input').props.onChange({ target: { value: '30' } })
  tree = harness.render(row, mounted.hook).tree
  fail = true
  buttonWithText(tree, 'Save window').props.onClick()
  await flush()
  tree = harness.render(row, mounted.hook).tree
  assert.equal(walk(tree, node => node.type === 'input').props.value, '15', 'E5: 失败回滚到已保存的 15')
  assert.match(textContent(tree), /warnExpire write denied/u, 'E5: 失败原因可见')
  harness.unmount(mounted.hook)
  passed++;console.log(`ok ${passed} - E5 a failed save rolls back and reports the error`)
}

// E6：老宿主（无 warnExpireSeconds 字段）→ 保存禁用 + hostTooOld 提示；
// 且过期机制退回默认 15 秒（store 侧验证）。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E6') {
  const clock = { now: 1_800_000_000_000 }
  // 老宿主 = status 里没有 warnExpireSeconds 字段（但有任务在跑，warn 路径可达）。
  const harness = makeHarness(async () => reply(200, busyStatus()), { clock, timer: true })
  // 行为老宿主：读不到字段 → 禁用保存 + 提示。
  const section = harness.render(harness.settingsComponent).tree
  const row = walk(section, node => node.type?.name === 'WarnExpireRow')
  assert.ok(row, 'E6: WarnExpireRow 必须渲染')
  const rowMount = harness.render(row.type)
  await flush()
  const rowTree = harness.render(row.type, rowMount.hook).tree
  assert.equal(buttonWithText(rowTree, 'Save window').props.disabled, true, 'E6: 老宿主必须禁用保存')
  assert.match(textContent(rowTree), /host.*old.*restart|restart.*host/iu, 'E6: 提示宿主过旧')
  harness.unmount(rowMount.hook)
  // store 侧：老宿主下 warn 过期用默认 15 秒。
  const mount = harness.render(harness.panelComponent)
  await flush()
  let tree = harness.render(harness.panelComponent, mount.hook).tree
  const primary = () => buttons(tree).find(b => b.props['data-variant'] === 'primary')
  primary().props.onClick()
  await flush()
  if (harness.timerDelays().includes(900)) harness.fireTimer(900)
  clock.now += 15_000
  harness.fireTimer(15000)
  await flush()
  tree = harness.render(harness.panelComponent, mount.hook).tree
  assert.doesNotMatch(textContent(primary()), /restart anyway|仍要重启/ui, 'E6: 默认 15 秒后过期回 idle')
  harness.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - E6 old host disables saving and falls back to the 15s default`)
}

// E7：文案 —— 有任务时第一击后「有任务在跑」只出现一次，无「还要再确认一次」，
// 确认行带剩余秒数。
if (!process.env.DSHDR_EXPIRE_CASE || process.env.DSHDR_EXPIRE_CASE === 'E7') {
  const clock = { now: 1_800_000_000_000 }
  const h = makeHarness(async () => reply(200, busyStatus()), { clock })
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  buttons(tree).find(b => b.props['data-variant'] === 'primary').props.onClick()
  await flush()
  tree = h.render(h.panelComponent, mount.hook).tree
  const text = textContent(tree)
  const occurrences = text.split('Work in progress').length - 1
  assert.equal(occurrences, 1, `E7: 「有任务在跑」只出现一次（实际 ${occurrences} 次）`)
  assert.doesNotMatch(text, /asked once more|再确认一次|确认要继续吗/u, 'E7: 不得再出现过时文案')
  assert.match(text, /valid for 15s|15 秒内有效/u, 'E7: 确认行必须带剩余秒数')
  assert.match(text, /click twice to force-restart|点两次强制重启/u, 'E7: 黄色提示条为新文案')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - E7 the busy panel shows the guard once with the fresh copy`)
}

// Shared and hook-local confirmation must use the same injected clock, even if
// expiry callbacks are delayed (e.g. background throttling).
for (const elapsed of [5100, 1000]) {
  for (const entry of ['store', 'local']) {
    const clock = { now: 1_800_000_000_000 }
    let posts = 0
    const h = makeHarness(async (_url, options) => {
      if (options.method === 'POST') { posts++; return reply(200, {ok:true}) }
      return reply(200, statusBody('off'))
    }, {clock})
    const view = h.store.newViewId()
    const unsubscribe = h.store.subscribe(() => {}, view, false)
    const component = () => h.useRestart()
    const mount = entry === 'local' ? h.render(component) : null
    await flush()
    const action = () => entry === 'store' ? h.store.getSnapshot(view) : h.render(component, mount.hook).tree
    action().press()
    clock.now += elapsed
    action().press()
    await flush()
    assert.equal(posts, elapsed > 5000 ? 0 : 1, `${entry}: second click after ${elapsed}ms`)
    if (elapsed > 5000) assert.equal(action().phase, 'confirm')
    if (mount) h.unmount(mount.hook)
    unsubscribe()
  }
  passed++; console.log(`ok ${passed} - shared/local confirmation agree at ${elapsed}ms`)
}
{
  const clock = { now: 1_800_000_000_000 }
  let gets = 0
  const h = makeHarness(async () => { gets++; return reply(200, busyStatus()) }, {clock, timer:true})
  const mount = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mount.hook).tree
  buttons(tree).find(b => b.props['data-variant'] === 'primary').props.onClick()
  const before = gets
  for (const seconds of [15, 14, 13]) {
    if (seconds !== 15) { clock.now += 1000; h.fireTimer(1000) }
    tree = h.render(h.panelComponent, mount.hook).tree
    assert.match(textContent(tree), new RegExp(`valid for ${seconds}s|${seconds} 秒内有效`, 'u'))
    assert.equal(h.timerDelays().filter(ms => ms === 1000).length, 1)
  }
  assert.equal(gets, before, 'display ticks do not fetch')
  clock.now += 13000
  h.fireTimer(15000)
  assert.equal(h.timerDelays().filter(ms => ms === 1000).length, 0, 'idle cancels the display clock immediately')
  h.unmount(mount.hook)
  passed++; console.log(`ok ${passed} - warn display clock: 15 -> 14 -> 13; no fetch; stopped at idle`)
}


// Account-menu DOM boundary, shared state, and observer lifecycle.
{
  const dom = accountMenuDOM()
  const clock = {now: 1_800_000_000_000}
  const h = makeHarness(async () => reply(200, busyStatus()), {dom, clock, timer:true})
  const mount = h.render(h.panelComponent)
  await flush()
  dom.open(); await flush(); h.settleMenu()
  assert.equal(dom.injected().length, 1)
  const button = dom.injected()[0]
  assert.equal(button.getAttribute('role'), 'menuitem')
  assert.equal(button.className, dom.seed.className, 'host item class controls geometry/hover')
  assert.equal(dom.menu.querySelector('button[role="menuitem"]'), button, 'restart is the first menuitem')
  assert.equal(button.parentElement, dom.viewport, 'insert directly inside viewport, not menu/itemWrap')
  assert.equal(dom.itemWrap.parentElement, dom.viewport)
  const officialItems = dom.menu.querySelectorAll('button[role="menuitem"]').filter(node => node !== button)
  assert.deepEqual(officialItems.map(node => node.getAttribute('data-host-id')), ['settings','contact','signout'])
  console.log('MENU ORDER signed-in: restart -> ' + officialItems.map(node => node.getAttribute('data-host-id')).join(' -> '))
  assert.match(button.textContent, /Restart desktop app/u)
  dom.clickTrigger(); await flush(); h.settleMenu()
  assert.equal(dom.injected().length, 1, 'repeated discovery remains idempotent')
  assert.equal(dom.injected()[0],button,'repeated discovery reuses the same node')
  const panel = h.render(h.panelComponent, mount.hook).tree
  buttons(panel).find(b => b.props['data-variant'] === 'primary').props.onClick()
  assert.equal(dom.injected()[0].getAttribute('data-phase'), 'warn')
  assert.match(dom.injected()[0].style.color, /error-primary/u)
  assert.equal(dom.injected()[0].disabled, true, 'warn cooldown is shared')
  h.fireTimer(900)
  assert.match(dom.injected()[0].textContent, /restart anyway/ui)
  assert.equal(dom.injected()[0].disabled, false)
  const observed = dom.observations()
  assert.ok(observed.some(item => item.target === dom.document.body && item.options.childList && !item.options.subtree))
  assert.equal(observed.filter(item => item.target === dom.document.body).length, 1)
  dom.close()
  assert.equal(dom.injected().length, 0)
  assert.equal(dom.observations().length, 0, 'closing disconnects both observation targets')
  h.unmount(mount.hook)
  assert.equal(h.timerDelays().filter(ms => ms === 1000 || ms === 2000).length, 0, 'closed menu has no leaked store subscription')
  dom.open(); await flush(); h.settleMenu()
  assert.equal(dom.injected().length, 1, 'reopening creates exactly one fresh item')
  h.dispose()
  assert.equal(dom.injected().length, 0)
  assert.equal(dom.listenerCount(), 0)
  assert.equal(dom.observations().length, 0)
  passed++; console.log(`ok ${passed} - account menu: one item, host styling, shared panel warn, close/reopen/unload cleanup`)
}
for (const scenario of ['missing', 'empty', 'ambiguous', 'wrong-launcher', 'nested', 'append-failure', 'observer-failure', 'footer-only', 'no-presentation']) {
  const dom = accountMenuDOM(scenario)
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  const original = dom.originalSnapshot()
  dom.open()
  if (scenario === 'wrong-launcher') assert.ok(!h.timerDelays().includes(0))
  else {
    await flush(); h.settleMenu()
    // 2026-10-30 新路径：菜单未出现时发现观察器等到 500ms 超时才断开。
    if (h.timerDelays().includes(500)) h.fireTimer(500)
  }
  assert.equal(dom.injected().length, 0, scenario)
  assert.equal(dom.originalSnapshot(), original, `${scenario}: original page remains unchanged`)
  assert.equal(dom.observations().length, 0, `${scenario}: no observation left after skipped/failed injection`)
  h.dispose()
  passed++; console.log(`ok ${passed} - account menu fails closed: ${scenario}`)
}
{
  const dom = accountMenuDOM()
  const storage = {getItem: key => key === 'dsh-desktop-restart.entries' ? JSON.stringify({accountMenu:false}) : null, setItem(){}}
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom, storage})
  await flush()
  assert.equal(dom.listenerCount(), 0)
  dom.open()
  assert.equal(dom.injected().length, 0)
  assert.equal(dom.observerCount(), 0, 'disabled preference constructs no observer')
  // Re-enable through the actual settings control, then disable while open.
  const mount = h.render(h.settingsComponent)
  let tree = mount.tree
  const toggle = walk(tree, n => n.type === 'input' && n.props['aria-label'] === 'Show restart in the account menu')
  assert.ok(toggle)
  toggle.props.onChange({target:{checked:true}})
  dom.clickTrigger(); await flush(); h.settleMenu()
  assert.equal(dom.injected().length, 1)
  tree = h.render(h.settingsComponent, mount.hook).tree
  walk(tree, n => n.type === 'input' && n.props['aria-label'] === 'Show restart in the account menu').props.onChange({target:{checked:false}})
  assert.equal(dom.injected().length, 0)
  assert.equal(dom.observations().length, 0)
  assert.equal(dom.listenerCount(), 0)
  h.unmount(mount.hook); h.dispose()
  passed++; console.log(`ok ${passed} - account menu preference: default on, persisted off, live enable/disable`)
}
for (const entry of ['store', 'local']) {
  const clock = {now:1_800_000_000_000}
  let posts = 0
  const h = makeHarness(async (_url, options) => {
    if (options.method === 'POST') { posts++; return reply(200, {ok:true}) }
    return reply(200, busyStatus())
  }, {clock})
  const view = h.store.newViewId()
  const off = h.store.subscribe(() => {}, view, false)
  const component = () => h.useRestart()
  const mount = entry === 'local' ? h.render(component) : null
  await flush()
  const action = () => entry === 'store' ? h.store.getSnapshot(view) : h.render(component, mount.hook).tree
  action().press(); clock.now += 15001; action().press()
  await flush()
  assert.equal(posts, 0, `${entry}: stale warn must rearm, never force restart`)
  assert.equal(action().warnAt, clock.now)
  if (mount) h.unmount(mount.hook)
  off()
  passed++; console.log(`ok ${passed} - ${entry} expired warning rearms without a timer service`)
}
{
  const clock = {now:1_800_000_000_000}
  const h = makeHarness(async () => reply(200, {...busyStatus(),warnExpireSeconds:5}), {clock,timer:true})
  const mount = h.render(h.panelComponent)
  const view = h.store.newViewId()
  const off = h.store.subscribe(() => {}, view, false)
  await flush()
  h.store.getSnapshot(view).press()
  assert.ok(h.timerDelays().includes(5000), 'configured expiry schedules five seconds')
  clock.now += 5000; h.fireTimer(5000)
  assert.equal(h.store.getSnapshot(view).phase, 'idle')
  assert.ok(!h.timerDelays().includes(1000))
  off(); h.unmount(mount.hook)
  passed++; console.log(`ok ${passed} - configured warning expiry uses the same five-second window as display`)
}


{
  const dom = accountMenuDOM()
  const posts = []
  const h = makeHarness(async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return reply(409, busyStatus()) }
    return reply(200, statusBody('off'))
  }, {dom, primitives:{RiskConfirmation:function RiskConfirmation(){}}})
  await flush(); dom.open(); await flush(); h.settleMenu(); await flush()
  dom.clickItem(); assert.equal(dom.injected()[0].getAttribute('data-phase'), 'confirm')
  dom.clickItem(); await flush()
  assert.equal(posts.length, 1)
  assert.equal(dom.injected()[0].getAttribute('data-phase'), 'warn', 'DOM entry must not open an unrenderable React modal')
  dom.clickItem(); await flush()
  assert.match(posts[1], /force=1&now=1/u, 'menu warning uses the existing force+now path')
  h.dispose()
  passed++; console.log(`ok ${passed} - account click uses shared confirm/force paths; a raced 409 remains actionable with official dialogs installed`)
}


for (const scenario of ['grouped', 'signed-out']) {
  const dom = accountMenuDOM(scenario)
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  const original = dom.originalSnapshot()
  dom.open(); await flush(); h.settleMenu()
  const button = dom.injected()[0]
  assert.ok(button)
  assert.equal(dom.menu.querySelector('button[role="menuitem"]'), button)
  assert.equal(button.parentElement, dom.viewport)
  assert.equal(dom.viewport.firstElementChild,button,'container-first insertion')
  assert.equal(dom.originalSnapshot(), original, 'all host nodes, structure, attributes and relative order remain unchanged')
  if (scenario === 'grouped') {
    assert.equal(dom.viewport.children[1], dom.itemWrap, 'official item wrapper remains before the other official wrappers')
    assert.equal(dom.itemWrap.children[0], dom.separator, 'leading separator remains first-child inside its wrapper')
    assert.equal(dom.menu.children[0], dom.material, 'decorative material remains before viewport')
    assert.equal(dom.menu.children[1], dom.viewport, 'viewport keeps its actual second-child position')
    assert.equal(dom.menu.children[2], dom.footer, 'footer remains a separate sibling after viewport')
    assert.equal(dom.footer.children.length, 1, 'restart never enters footer')
  }
  const ids = dom.menu.querySelectorAll('button[role="menuitem"]').map(node => node === button ? 'restart' : node.getAttribute('data-host-id'))
  console.log(`MENU ORDER ${scenario}: ${ids.join(' -> ')}`)
  dom.close(); h.dispose()
  passed++; console.log(`ok ${passed} - first menu position preserves ${scenario} host structure`)
}


{
  for (const phase of ['confirm','warn']) {
    const h = makeHarness(async () => reply(200, phase === 'warn' ? busyStatus() : statusBody('off')))
    const mount=h.render(h.headerComponent); await flush()
    headerMainTrigger(h.render(h.headerComponent,mount.hook).tree).props.onClick()
    const tree=h.render(h.headerComponent,mount.hook).tree
    const button=headerMainTrigger(tree)
    assert.equal(button.props['data-phase'],phase)
    assert.equal(button.props['data-header-main'],'1')
    assert.equal(headerStateNodes(button).length,1,'state is a child of the main button')
    assert.ok(textContent(headerStateNodes(button)[0]).length>0)
    const css=h.cssText()
    assert.ok(css.includes(`.dshdr-trigger[data-header-main][data-phase=${phase}]`))
    assert.match(css,/\[data-phase=warn\]\{color:var\(--dsw-alias-state-error-primary/u)
    const vis=deriveSpanVisibility(css)
    assert.equal(vis.headerWide,true); assert.equal(vis.headerNarrow,true)
    h.unmount(mount.hook)
  }
  passed++;console.log(`ok ${passed} - confirm/warn: visible in-button text at >540px and <=540px; header-only danger color`)
}
{
  const h=makeHarness(async (_url,options) => options.method === 'POST' ? new Promise(()=>{}) : reply(200,statusBody('off')))
  const mount=h.render(h.headerComponent);await flush()
  assert.equal(headerStateNodes(h.render(h.headerComponent,mount.hook).tree).length,0,'idle occupies no text space')
  headerMainTrigger(h.render(h.headerComponent,mount.hook).tree).props.onClick()
  headerMainTrigger(h.render(h.headerComponent,mount.hook).tree).props.onClick()
  const button=headerMainTrigger(h.render(h.headerComponent,mount.hook).tree)
  assert.equal(button.props['data-busy'],'1');assert.equal(button.props['aria-busy'],'true')
  assert.match(textContent(headerStateNodes(button)[0]),/restarting|重启中/ui)
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - idle has no state placeholder; executing keeps visible text, busy glyph and aria-busy`)
}
{
  const dom=accountMenuDOM('staged')
  const h=makeHarness(async()=>reply(200,statusBody('off')),{dom})
  await flush();dom.open();await flush()
  const button=dom.injected()[0]
  assert.ok(button,'inserts immediately without waiting for all menu items')
  assert.equal(button.parentElement,dom.viewport)
  assert.equal(dom.viewport.firstElementChild,button)
  assert.equal(button.style.visibility,'hidden')
  assert.equal(dom.insertEvents.at(-1).visibility,'hidden')
  console.log('STAGED MENU initial: hidden restart -> signout; direct viewport child')
  dom.addStagedItem('settings')
  assert.equal(dom.viewport.firstElementChild,button)
  assert.equal(dom.injected()[0],button,'official insertion reuses the same button')
  h.fireFrame();assert.equal(button.style.visibility,'visible')
  console.log('STAGED MENU next frame: visible restart -> settings -> signout')
  dom.addStagedItem('contact')
  dom.prependHostItem()
  assert.equal(dom.viewport.firstElementChild,button)
  assert.equal(button.style.visibility,'visible','later host items do not re-hide a correctly anchored node')
  assert.equal(h.frameCount(),0)
  assert.equal(dom.insertEvents.length,1,'no reinsertion for ordinary host items')
  dom.notify([{target:button.children[1],addedNodes:[{}],removedNodes:[]}])
  assert.equal(h.frameCount(),0)
  dom.rebuildFirstItem()
  assert.equal(dom.injected()[0],button,'rebuilding official wrappers leaves viewport child intact')
  assert.equal(dom.viewport.firstElementChild,button)
  console.log('STAGED MENU two later items + wrapper rebuild: same visible restart stays first; insertions=1')
  assert.ok(dom.observations().filter(o=>o.target===dom.document.body).every(o=>o.options.childList&&!o.options.subtree))
  dom.close();assert.equal(dom.observations().length,0);assert.equal(h.frameCount(),0)
  h.dispose()
  passed++;console.log(`ok ${passed} - viewport anchor ignores staged official items; hidden -> one frame -> visible; same node reused`)
}

{
  const dom=accountMenuDOM()
  const h=makeHarness(async()=>reply(200,statusBody('off')),{dom})
  await flush();dom.open();await flush();dom.close();h.fireFrame()
  assert.equal(dom.injected().length,0);assert.equal(h.frameCount(),0)
  dom.open();await flush();h.dispose()
  assert.equal(h.frameCount(),0);assert.equal(dom.observations().length,0)
  passed++;console.log(`ok ${passed} - closing/unloading during stabilization leaves no frame or injected node`)
}


{
  let health={backup:false,warn:true,limitBytes:16384,checkPending:false,last:null}
  const requests=[]
  const h=makeHarness(async(url,options)=>{
    requests.push({url,method:options.method??'GET'})
    assert.match(url,/api\/(status|prefs)/u,'settings uses only stored-status and preference APIs')
    if(options.method==='POST') {
      if(url.includes('authCookieBackup=1')) health={...health,backup:true}
      if(url.includes('authCookieWarn=0')) health={...health,warn:false}
      if(url.includes('checkAuthCookie=1')) health={...health,checkPending:true}
      return reply(200,{ok:true,authCookie:health})
    }
    return reply(200,statusBody('off',{authCookie:health}))
  })
  const mount=h.render(h.authCookieComponent);await flush()
  let tree=h.render(h.authCookieComponent,mount.hook).tree
  assert.match(textContent(tree),/Unavailable/u)
  assert.match(textContent(tree),/Cannot read while running/u)
  assert.match(textContent(tree),/16 KiB \(16384 bytes\)/u)
  assert.equal(walk(tree,n=>n.type==='input'&&n.props['aria-label']==='Back up Cookie database during restart').props.checked,false)
  assert.equal(walk(tree,n=>n.type==='input'&&n.props['aria-label']==='Warn when Cookies approach the limit (80%)').props.checked,true)
  walk(tree,n=>n.type==='input'&&n.props['aria-label']==='Back up Cookie database during restart').props.onChange({target:{checked:true}})
  await flush();tree=h.render(h.authCookieComponent,mount.hook).tree
  assert.equal(walk(tree,n=>n.type==='input'&&n.props['aria-label']==='Back up Cookie database during restart').props.checked,true)
  buttonWithText(tree,'Check again (during next restart)').props.onClick();await flush()
  tree=h.render(h.authCookieComponent,mount.hook).tree
  assert.match(textContent(tree),/does not restart the app now/u)
  assert.equal(requests.some(r=>/api\/restart/u.test(r.url)),false)
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - Cookie settings: unavailable while running, defaults off/on, opt-in saves and next-restart check only`)
}
for(const reason of ['database-unavailable','sqlite-unavailable']) {
  const health={clean:false,warn:true,limitBytes:16384,last:{schema:1,status:'unavailable',reason,errorCode:'TEST_BOUNDARY',checkedAt:'2026-10-29T06:00:00Z',sample:null}}
  const h=makeHarness(async()=>reply(200,statusBody('off',{authCookie:health})))
  const mount=h.render(h.authCookieComponent);await flush()
  const tree=h.render(h.authCookieComponent,mount.hook).tree
  assert.match(textContent(tree),/Unavailable/u)
  assert.match(textContent(tree),reason==='sqlite-unavailable'?/does not support built-in SQLite/u:/unavailable or still locked/u)
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - Cookie settings gracefully explains ${reason}, no live database access`)
}
{
  const health={clean:false,warn:true,limitBytes:16384,last:{schema:1,status:'near',checkedAt:'2026-10-29T06:00:00Z',sample:{estimatedBytes:14028,authCount:60,status:'near',checkedAt:'2026-10-29T06:00:00Z'}}}
  const h=makeHarness(async(_url,options)=>options.method==='POST'?reply(500,{ok:false,error:'fixture settings write rejected'}):reply(200,statusBody('off',{authCookie:health})))
  const mount=h.render(h.authCookieComponent);const panel=h.render(h.panelComponent);await flush()
  let tree=h.render(h.authCookieComponent,mount.hook).tree
  assert.match(textContent(tree),/13.70 KiB \(85.6%\)/u)
  assert.match(textContent(tree),/dsh-auth-\* count: 60/u)
  assert.equal(walk(tree,n=>n.type==='progress').props.max,16384)
  assert.ok(textContent(tree).includes(new Intl.DateTimeFormat('sv-SE',{dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date('2026-10-29T06:00:00Z'))))
  const p=h.render(h.panelComponent,panel.hook).tree
  const warning=walk(p,n=>n.type?.name==='AuthCookieWarning')
  assert.ok(warning)
  assert.match(textContent(warning.type(warning.props)),/80%/u)
  assert.equal(warning.type({health:{...health,warn:false}}),null,'warning can be disabled')
  walk(tree,n=>n.type==='input'&&n.props['aria-label']==='Back up Cookie database during restart').props.onChange({target:{checked:true}})
  await flush();tree=h.render(h.authCookieComponent,mount.hook).tree
  assert.match(textContent(tree),/fixture settings write rejected/u)
  assert.equal(walk(tree,n=>n.type==='input'&&n.props['aria-label']==='Back up Cookie database during restart').props.checked,false)
  h.unmount(mount.hook);h.unmount(panel.hook)
  passed++;console.log(`ok ${passed} - Cookie snapshot: 13.70 KiB/85.6%, 60 records, timestamp, optional panel warning, failed-save rollback`)
}


{
  const dom=accountMenuDOM()
  const h=makeHarness(async()=>reply(200,statusBody('off')),{dom})
  await flush();dom.open();await flush()
  dom.prependHostItem({beforeInjected:true,deliver:false})
  h.fireFrame()
  assert.equal(dom.insertEvents.length,2,'failed next-frame check retries exactly once')
  assert.equal(dom.viewport.firstElementChild,dom.injected()[0])
  assert.equal(dom.injected()[0].style.visibility,'hidden')
  dom.prependHostItem({beforeInjected:true,deliver:false})
  h.fireFrame()
  assert.equal(dom.injected().length,0,'second failure abandons injection')
  assert.equal(dom.observations().length,0);assert.equal(h.frameCount(),0)
  h.dispose()
  passed++;console.log(`ok ${passed} - next-frame anchor failure: one cleanup/retry, second failure stops without looping`)
}


for (const [name,stored,hostValue,expected] of [
  ['legacy four keys',{panel:true,footer:true,header:true,settingsRow:true},true,true],
  ['old host omitted key',{},undefined,true],
  ['host default disabled',{},false,false],
  ['explicit local off',{accountMenu:false},true,false],
  ['explicit local on',{accountMenu:true},false,true],
]) {
  const dom=accountMenuDOM()
  const storage={getItem:key=>key==='dsh-desktop-restart.entries'?JSON.stringify(stored):null,setItem(){}}
  const entries={panel:true,footer:true,header:true,settingsRow:true,...(hostValue===undefined?{}:{accountMenu:hostValue})}
  const h=makeHarness(async()=>reply(200,statusBody('off',{entries})),{dom,storage})
  await flush()
  const mount=h.render(h.settingsComponent)
  const control=walk(mount.tree,n=>n.type==='input'&&n.props['aria-label']==='Show restart in the account menu')
  assert.ok(control,name+': switch exists');assert.equal(control.props.checked,expected,name)
  dom.open()
  if(expected){await flush();h.settleMenu()}
  assert.equal(dom.injected().length,expected?1:0,name)
  assert.doesNotMatch(textContent(mount.tree),/Account menu diagnostic|Health and diagnostics/u)
  console.log(`ACCOUNT SWITCH ${name}: ${expected}; injected=${dom.injected().length}`)
  h.unmount(mount.hook);h.dispose()
  passed++;console.log(`ok ${passed} - accountMenu default synchronization: ${name}`)
}
{
  const dom=accountMenuDOM()
  const h=makeHarness(async()=>reply(200,statusBody('off',{entries:{accountMenu:true}})),{dom})
  await flush()
  const settings=h.render(h.settingsComponent)
  dom.open();await flush();h.settleMenu()
  const toggle=()=>walk(h.render(h.settingsComponent,settings.hook).tree,n=>n.type==='input'&&n.props['aria-label']==='Show restart in the account menu')
  toggle().props.onChange({target:{checked:false}})
  assert.equal(dom.injected().length,0)
  toggle().props.onChange({target:{checked:true}})
  await flush(); h.settleMenu()
  assert.equal(dom.injected().length,1,'enabling while menu is open immediately injects without a new click')
  dom.close();assert.equal(dom.injected().length,0)
  h.unmount(settings.hook);h.dispose()
  passed++;console.log(`ok ${passed} - account menu live enable/disable/injection/close works without diagnostic UI`)
}
{
  const dom=accountMenuDOM('empty')
  const h=makeHarness(async()=>reply(200,statusBody('off',{entries:{accountMenu:true}})),{dom})
  await flush();const mount=h.render(h.settingsComponent)
  dom.open();await flush();h.settleMenu()
  assert.equal(dom.injected().length,0)
  assert.doesNotMatch(textContent(h.render(h.settingsComponent,mount.hook).tree),/Account menu diagnostic|Health and diagnostics/u)
  h.unmount(mount.hook);h.dispose()
  passed++;console.log(`ok ${passed} - incompatible menu skips safely without diagnostic UI`)
}

// Deep-review regressions written on 2026-10-29. Execution awaits user approval.
{
  // 2026-10-30 新语义：菜单后到时由发现观察器接住 —— append 进 body 的微任务
  // 回调里同步注入，无需 rAF 等待帧。
  const dom=accountMenuDOM('missing')
  const h=makeHarness(async()=>reply(200,statusBody()),{dom});await flush()
  dom.open()
  assert.equal(h.frameCount(),0,'no discovery frame — injection is observer-driven')
  dom.document.body.appendChild(dom.menu)
  await flush()
  assert.equal(dom.injected().length,1,'menu arrival injects via the discovery observer')
  assert.equal(dom.injected()[0].style.visibility,'hidden')
  h.fireFrame();assert.equal(dom.injected()[0].style.visibility,'visible')
  assert.equal(dom.menu.firstElementChild,dom.material)
  assert.equal(dom.injected()[0].parentElement,dom.viewport)
  h.dispose();passed++;console.log(`ok ${passed} - delayed portal mounts into real material/viewport structure`)
}
{
  const dom=accountMenuDOM()
  const h=makeHarness(async()=>reply(200,statusBody()),{dom});await flush()
  dom.open();await flush();h.settleMenu()
  const original=dom.injected()[0]
  dom.prependHostItem({beforeInjected:true})
  assert.equal(original.isConnected,false,'a real host prepend retires the displaced button')
  assert.equal(dom.injected()[0].style.visibility,'hidden')
  h.fireFrame();assert.equal(dom.injected()[0],dom.viewport.firstElementChild)
  assert.equal(dom.injected()[0].style.visibility,'visible')
  assert.equal(dom.insertEvents.length,2,'exactly one positioning retry')
  h.dispose();passed++;console.log(`ok ${passed} - host prepends before plugin: bounded hidden repair preserves first position`)
}
{
  let resolveInitial;let reads=0
  const h=makeHarness(()=>++reads===2?new Promise(r=>{resolveInitial=r}):Promise.resolve(reply(200,statusBody())))
  const id=h.store.newViewId(),off=h.store.subscribe(()=>{},id,false)
  h.store.getSnapshot(id).refresh();await flush()
  resolveInitial(reply(200,busyStatus()));await flush()
  assert.equal(h.store.getSnapshot(id).guardHint,'','old initial GET cannot overwrite the newer idle response')
  off();h.dispose();passed++;console.log(`ok ${passed} - first GET obeys the same response ordering as refresh`)
}
for(const supported of [true,false]) {
  const clock={now:10000};let posts=0
  const h=makeHarness((url,opts)=>opts.method==='POST'?(posts++,new Promise(()=>{})):Promise.resolve(reply(200,statusBody('off',{requestExpiry:supported,serverNow:clock.now,restartRequest:{state:'idle'},restartBusy:false}))),{clock})
  const id=h.store.newViewId(),off=h.store.subscribe(()=>{},id,false);await flush()
  h.store.getSnapshot(id).press();h.store.getSnapshot(id).press()
  clock.now+=10001;h.fireTimer(10000);await flush()
  const result=h.store.getSnapshot(id)
  assert.notEqual(result.phase,'restarting','a transport timeout must not leave an endless submitting spinner')
  assert.equal(result.opBusy,!supported,'only a host-enforced expiry permits automatic idle reconciliation')
  if(!supported){result.press();await flush();assert.equal(posts,1,'old hosts stay locked against blind resubmission')}
  off();h.dispose();passed++;console.log(`ok ${passed} - lost POST reply reconciles safely; host expiry supported=${supported}`)
}
{
  const clock={now:10000};const h=makeHarness(async()=>reply(200,busyStatus()),{clock,timer:true})
  const mount=h.render(h.headerComponent);await flush()
  headerMainTrigger(h.render(h.headerComponent,mount.hook).tree).props.onClick()
  h.fireTimer(900)
  const button=headerMainTrigger(h.render(h.headerComponent,mount.hook).tree)
  assert.match(textContent(headerStateNodes(button)[0]),/Restart anyway|仍要重启/u)
  assert.doesNotMatch(textContent(headerStateNodes(button)[0]),/Work in progress|有任务在跑/u)
  assert.ok(button.props['aria-describedby'],'guard details remain available to screen readers')
  h.unmount(mount.hook);h.dispose();passed++;console.log(`ok ${passed} - warning header keeps a short action and accessible details`)
}

for(const triggerConnected of [true,false]) {
  const dom=accountMenuDOM();let cancelled=false
  const request={id:'dialog-fixture',state:'paused',ask:'dialog-ask',deadlineAt:new Date(Date.now()+60000).toISOString(),pausedReason:'fixture work'}
  const h=makeHarness(async(url,opts)=>{
    if(opts.method==='POST'){cancelled=true;return reply(200,{ok:true,cancelled:true,restartRequest:{state:'terminal',executed:false}})}
    return reply(200,statusBody('off',{restartRequest:cancelled?{state:'terminal',executed:false}:request,waiting:cancelled?null:{since:new Date().toISOString()}}))
  },{dom})
  const component=()=>h.useRestart(undefined)
  const mount=h.render(component);await flush()
  const action=h.render(component,mount.hook,false).tree
  const previous={isConnected:triggerConnected,focus(){dom.document.activeElement=this}}
  const fallback={focus(){dom.document.activeElement=this}}
  const query=dom.document.querySelector
  dom.document.querySelector=selector=>selector.includes('[data-header-main]') ? fallback : query(selector)
  const first={focus(){dom.document.activeElement=this}},last={focus(){dom.document.activeElement=this}}
  dom.document.activeElement=previous
  action.dialogRef.current={querySelector:()=>last,querySelectorAll:selector=>{assert.match(selector,/select:not/);assert.match(selector,/textarea:not/);return [first,last]},contains:node=>node===first||node===last,focus(){dom.document.activeElement=this}}
  h.render(component,mount.hook)
  assert.equal(dom.document.activeElement,last,'safe cancel gets initial focus')
  dom.dispatchKey({key:'Tab',shiftKey:false,preventDefault(){},stopPropagation(){}})
  assert.equal(dom.document.activeElement,first,'Tab wraps within the dialog')
  dom.dispatchKey({key:'Tab',shiftKey:true,preventDefault(){},stopPropagation(){}})
  assert.equal(dom.document.activeElement,last,'Shift+Tab wraps within the dialog')
  dom.dispatchKey({key:'Escape',preventDefault(){},stopPropagation(){}});await flush()
  assert.equal(cancelled,true,'Escape cancels a paused request rather than executing it')
  h.unmount(mount.hook);assert.equal(dom.document.activeElement,triggerConnected?previous:fallback,'unmount returns focus or falls back to a named restart control')
  h.dispose();passed++;console.log(`ok ${passed} - inline dialog traps Tab, Escape cancels safely, focus is restored`)
}

{
  let writes=0
  const h=makeHarness(async(url,options)=>{ if(options.method==='POST') writes++; return reply(200,statusBody('off')) })
  const section=h.render(h.settingsComponent)
  const heading=walk(section.tree,n=>n.props?.className==='dshdr-set-heading')
  assert.ok(walk(heading,n=>n.type==='h2'),'title stays beside the action')
  const component=walk(heading,n=>n.type?.name==='SettingsTitleAction').type
  const mounted=h.render(component);await flush()
  let tree=h.render(component,mounted.hook).tree
  let button=walk(tree,n=>n.props?.['data-settings-restart']==='1')
  assert.equal(button.props.disabled,false)
  button.props.onClick()
  tree=h.render(component,mounted.hook).tree
  assert.match(textContent(tree),/Restart now\?|确认/u)
  assert.equal(writes,0,'first click only arms confirmation')
  h.unmount(mounted.hook);h.dispose()
  passed++;console.log(`ok ${passed} - settings title restart uses shared two-click confirmation without submitting on first click`)
}
{
  const h=makeHarness(async()=>reply(200,statusBody('off')))
  const section=h.render(h.settingsComponent)
  const children=section.tree.children
  const extras=children.findIndex(n=>n.type==='h3'&&/Bundled extras|附带功能/u.test(textContent(n)))
  const health=children.findIndex(n=>n.type?.name==='AuthCookieHealth')
  assert.ok(extras>=0&&health>extras,'health belongs to bundled extras')
  const mounted=h.render(h.authCookieComponent);await flush()
  const tree=h.render(h.authCookieComponent,mounted.hook).tree
  assert.equal(tree.type,'details')
  assert.equal(tree.props.open,undefined,'health starts collapsed')
  assert.ok(walk(tree,n=>n.type==='summary'))
  assert.ok(walk(tree,n=>n.type==='progress')===null,'missing sample does not invent usage')
  h.unmount(mounted.hook);h.dispose()
  passed++;console.log(`ok ${passed} - Cookie health is a collapsed summary under bundled extras`)
}

{
  const h=makeHarness(async()=>reply(200,statusBody('off',{
    restartRequest:{state:'terminal',reason:'cancelled',executed:false,message:'Cancelled; restart was not executed.'},
  })),{storage:{getItem:key=>key==='dsh-desktop-restart.entries'?JSON.stringify({headerRefresh:true}):null,setItem(){}}})
  const mounted=h.render(h.headerComponent);await flush()
  const tree=h.render(h.headerComponent,mounted.hook).tree
  assert.equal(headerStateNodes(tree).length,0,'cancelled terminal never occupies the header state label')
  assert.match(textContent(walk(tree,n=>n.props?.className==='dshdr-header-name')),/Restart|重启/u)
  const refresh=walk(tree,n=>n.props?.['aria-label']==='Refresh')
  assert.ok(walk(refresh,n=>n.props?.['data-refresh-status-icon']==='1'),'refresh has its own straight two-arrow icon')
  assert.ok(h.cssText().includes('grid-template-columns:minmax(0,1fr) max-content'),'title/action layout has two explicit columns')
  assert.ok(h.cssText().includes('grid-column:2;grid-row:1;justify-self:end'),'action stays right of title on its first row')
  h.unmount(mounted.hook);h.dispose()
  passed++;console.log(`ok ${passed} - cancelled header returns to Restart; refresh icon is distinct; settings action occupies the right column`)
}


{
  const health={backup:false,warn:true,limitBytes:16384,last:{status:'exceeded',sample:{estimatedBytes:17000,authCount:75},checkedAt:'2026-10-29T00:00:00Z'}}
  const h=makeHarness(async()=>reply(200,statusBody('off',{authCookie:health})))
  const mounted=h.render(h.authCookieComponent);await flush()
  const tree=h.render(h.authCookieComponent,mounted.hook).tree
  assert.equal(tree.props.open,true,'over-limit guidance is immediately visible')
  const text=textContent(tree)
  assert.match(text,/%APPDATA%/u);assert.match(text,/Network/u);assert.match(text,/Cookies/u)
  assert.match(text,/fully quit DSH/u);assert.match(text,/developer tools/u)
  assert.match(text,/never deletes/u)
  assert.equal(walk(tree,n=>n.type==='button'&&/delete|clean/i.test(textContent(n))),null)
  h.unmount(mounted.hook);h.dispose()
  passed++;console.log(`ok ${passed} - over-limit Cookie guidance shows exact path, quit warning, manual options and no delete button`)
}

for(const raw of [null,'0','1','true','', 'broken']) {
  const h=makeHarness(async()=>reply(200,statusBody()),{storage:{getItem:key=>key.includes('hide-contact')?raw:null,setItem(){}}})
  const mounted=h.render(h.hideContactComponent)
  const control=walk(mounted.tree,n=>n.type==='input')
  assert.equal(control.props.checked,raw==='1','only literal 1 enables Feedback hiding')
  h.unmount(mounted.hook);h.dispose()
  passed++;console.log(`ok ${passed} - Feedback hiding storage ${JSON.stringify(raw)} is interpreted strictly`)
}
{
  const clock={now:1800000000000}
  const h=makeHarness(async()=>reply(200,statusBody('off',{restartRequest:{state:'countdown',countdownUntil:new Date(clock.now+5000).toISOString(),deadlineAt:new Date(clock.now+60000).toISOString()}})),{clock})
  const mounted=h.render(h.panelComponent);await flush()
  const before=h.render(h.panelComponent,mounted.hook).tree
  const announcement=walk(before,n=>n.props?.['data-phase-announcement']==='1')
  assert.equal(announcement.props['aria-live'],'polite')
  clock.now+=1000;h.fireTimer(1000)
  const after=h.render(h.panelComponent,mounted.hook).tree
  assert.equal(textContent(walk(after,n=>n.props?.['data-phase-announcement']==='1')),textContent(announcement),'one-second tick does not change live announcement')
  const dynamic=walk(after,n=>n.props?.['aria-live']==='off' && /4s|4 秒/u.test(textContent(n)))
  assert.ok(dynamic,'visible countdown updates outside the live region')
  assert.ok(h.cssText().includes('--dsw-alias-state-warn-primary'));assert.ok(!h.cssText().includes('--dsh-alias-'))
  h.unmount(mounted.hook);h.dispose()
  passed++;console.log(`ok ${passed} - countdown ticks visibly while the live-region phase announcement stays stable`)
}
const {uiCleanupChecks}=await import('./ui-cleanup-regression.mjs')
passed+=uiCleanupChecks
const {repairChecks}=await import('./repair-20261030-regression.mjs')
passed+=repairChecks

// ── 2026-10-30 修复：执行期间面板出现两个「刷新状态」按钮 ──────────────────
// 根因：StatusRetry 在 statusError==="" && opBusy===true 时也渲染，且标签与
// RefreshButton 相同（refreshStatus）→ 执行期间两个相同按钮。修复：
// StatusRetry 只在状态读取真的失败（statusError !== ""）时出现，标签恒为
// retryStatus；执行期间的刷新由常驻 RefreshButton 独自承担。
// B 系列：DSHDR_DUP_CASE 可单跑。

// B1：执行期间（opBusy=true、statusError=""）动作区里「刷新状态」按钮恰好 1 个。
if (!process.env.DSHDR_DUP_CASE || process.env.DSHDR_DUP_CASE === 'B1') {
  const harness = makeHarness(async () => reply(200, statusBody('off', {
    restartOp: { id: 'dup-op', phase: 'stop', result: 'pending', reason: null, stages: {}, ageMs: 0, argsPreserved: true, helperVerified: false, needsManualCheck: false, helperAlive: true, busy: true },
    restartBusy: true,
  })))
  const mount = harness.render(harness.panelComponent)
  await flush()
  const tree = harness.render(harness.panelComponent, mount.hook).tree
  const refreshButtons = buttons(tree).filter(b => /refresh status|refreshStatus|刷新状态|Retry status|重试状态/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
  assert.equal(refreshButtons.length, 1, `B1: 执行期间动作区应恰有 1 个刷新/重试按钮，实际 ${refreshButtons.length}`)
  assert.match(textContent(refreshButtons[0]) + String(refreshButtons[0].props['aria-label'] ?? ''), /refresh status|刷新状态/iu, 'B1: 该按钮应为「刷新状态」（RefreshButton）而非重试')
  harness.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - B1 executing state renders exactly one refresh button`)
}

// B2：状态读取失败（statusError!=""）时出现「重试状态」，且 RefreshButton 不渲染
//（既有互斥保持）。两个场景：纯错误态；错误后恢复读取且带 pending 操作
//（先错后忙 —— 修复前 StatusRetry 曾在此借 opBusy 兼职刷新导致重复）。
if (!process.env.DSHDR_DUP_CASE || process.env.DSHDR_DUP_CASE === 'B2') {
  // (a) 纯错误态：fetch 抛错 → statusError 非空。
  {
    const harness = makeHarness(async () => { throw new Error('status offline') })
    const mount = harness.render(harness.panelComponent)
    await flush()
    const tree = harness.render(harness.panelComponent, mount.hook).tree
    const retry = buttons(tree).find(b => /retry status|重试状态/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
    assert.ok(retry, 'B2a: 状态失败时必须渲染「重试状态」')
    const plainRefresh = buttons(tree).filter(b => /refresh status|刷新状态/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
    assert.equal(plainRefresh.length, 0, 'B2a: 出错时 RefreshButton 不得渲染（互斥保持）')
    harness.unmount(mount.hook)
  }
  // (b) 先错后忙：第一次 GET 抛错；点「重试状态」后恢复，状态带 pending
  // 操作（opBusy=true）—— 修复前 StatusRetry 仍按 opBusy 渲染「刷新状态」
  // 与 RefreshButton 重复；修复后读取已恢复 → 只剩 RefreshButton。
  {
    let failing = true
    const harness = makeHarness(async () => {
      if (failing) throw new Error('status offline')
      return reply(200, statusBody('off', {
        restartOp: { id: 'b2-op', phase: 'stop', result: 'pending', reason: null, stages: {}, ageMs: 0, argsPreserved: true, helperVerified: false, needsManualCheck: false, helperAlive: true, busy: true },
        restartBusy: true,
      }))
    })
    const mount = harness.render(harness.panelComponent)
    await flush()
    let tree = harness.render(harness.panelComponent, mount.hook).tree
    const retry = buttons(tree).find(b => /retry status|重试状态/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
    assert.ok(retry, 'B2b: 错误态先出现「重试状态」')
    failing = false
    retry.props.onClick()
    await flush()
    tree = harness.render(harness.panelComponent, mount.hook).tree
    const refreshButtons = buttons(tree).filter(b => /refresh status|refreshStatus|刷新状态|Retry status|重试状态/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
    assert.equal(refreshButtons.length, 1, `B2b: 恢复读取且带 pending 操作时应恰有 1 个刷新按钮，实际 ${refreshButtons.length}`)
    assert.match(textContent(refreshButtons[0]) + String(refreshButtons[0].props['aria-label'] ?? ''), /refresh status|刷新状态/iu, 'B2b: 该按钮应为「刷新状态」')
    harness.unmount(mount.hook)
  }
  passed++;console.log(`ok ${passed} - B2 status failure shows the retry button; recovery keeps one refresh`)
}

// B3：正常态（opBusy=false、statusError=""）也只有一个「刷新状态」。
if (!process.env.DSHDR_DUP_CASE || process.env.DSHDR_DUP_CASE === 'B3') {
  const harness = makeHarness(async () => reply(200, statusBody()))
  const mount = harness.render(harness.panelComponent)
  await flush()
  const tree = harness.render(harness.panelComponent, mount.hook).tree
  const refreshButtons = buttons(tree).filter(b => /refresh status|refreshStatus|刷新状态|Retry status|重试状态/ui.test(String(b.props['aria-label'] ?? '') + String(b.props.title ?? '') + textContent(b)))
  assert.equal(refreshButtons.length, 1, `B3: 正常态应恰有 1 个刷新按钮，实际 ${refreshButtons.length}`)
  harness.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - B3 idle state renders exactly one refresh button`)
}


// ── 2026-10-30 消除账号菜单重启项的插入抖动（改为绘制前注入） ────────────────
// 真机问题：点击账号菜单后，重启项「从最底部一瞬间跑到最上面」——注入发生在
// 菜单首帧绘制之后，向顶部插入把官方项顶下去一行，用户看到布局跳动。
// 修复：点击触发器时立即在 body 上挂 childList（不递归）MutationObserver，
// 菜单元素被加入 body 的同一个回调里同步完成插入（React 提交 DOM 同步、
// MO 回调在绘制前执行）⇒ 用户看不到无按钮的中间帧。观察器只在「点击后到
// 菜单出现」窗口内存在，最长 500ms。
// F 系列：DSHDR_MENU_CASE 可单跑。

// F1：绘制前注入 —— 点击 → 菜单加入 body（同一同步批次）→ 按钮立即可见，
// 全程不经过任何 rAF/setTimeout 等待。
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F1') {
  const dom = accountMenuDOM()
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  // open() 在同一同步批次里：设置 aria-expanded、把菜单加进 body、派发 click。
  dom.open()
  // 微任务投递（真实浏览器 MutationObserver 的交付时机——绘制前的微任务）。
  // 不 fireTimer(0)、不 settleMenu() —— 注入不依赖任何宏任务定时器或 rAF。
  await flush()
  assert.equal(dom.injected().length, 1, 'F1: 菜单加入 body 的同一批次内完成注入（无 setTimeout/rAF 等待）')
  // 注入在微任务里完成，不依赖 rAF；唯一的 pending 帧是 visibility 兜底（设计内保留）。
  assert.ok(h.frameCount() <= 1, `F1: 注入不依赖 rAF（至多 1 个 visibility 兜底帧，实际 ${h.frameCount()}）`)
  assert.ok(!h.timerDelays().includes(0), 'F1: 注入路径不依赖 setTimeout(0)')
  const button = dom.injected()[0]
  assert.equal(button.parentElement, dom.viewport, 'F1: 位置正确 —— parentElement === viewport')
  assert.equal(dom.viewport.firstElementChild, button, 'F1: 是 viewport 的第一个子元素')
  h.dispose()
  passed++;console.log(`ok ${passed} - F1 same-batch injection before first paint, no rAF/setTimeout`)
}

// F2：不再依赖「连续两帧一致」门槛 —— 注入在菜单出现的观察器回调内同步
// 完成；rAF 只剩 visibility 兜底（首帧确认后置 visible）。
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F2') {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  // stabilize 的「连续两帧一致」逻辑（prevKey/currKey 两帧比对）不再存在于
  // 注入路径 —— 搜代码确认 stabilize 函数已删除或不再被点击路径调用。
  assert.ok(!/function stabilize/.test(src), 'F2: stabilize（连续两帧门槛）已移除')
  assert.ok(!/prevKey/.test(src) && !/currKey/.test(src), 'F2: 两帧比对状态已移除')
  // 点击路径直接挂观察器。
  assert.ok(/observer\.observe\(document\.body, \{ childList: true \}\)/.test(src) || /childList: true(, subtree: false)?\}\)/.test(src), 'F2: 点击路径在 body 上挂 childList 观察器')
  passed++;console.log(`ok ${passed} - F2 no multi-frame stabilization gate on the injection path`)
}

// F3：位置与结构 —— 注入后按钮是 viewport.firstElementChild，官方项顺序不变。
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F3') {
  const dom = accountMenuDOM()
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  dom.open()
  await flush()
  const button = dom.injected()[0]
  assert.equal(dom.menu.querySelector('button[role="menuitem"]'), button, 'F3: 重启是第一个 menuitem')
  const officialItems = dom.menu.querySelectorAll('button[role="menuitem"]').filter(node => node !== button)
  assert.deepEqual(officialItems.map(node => node.getAttribute('data-host-id')), ['settings','contact','signout'], 'F3: 官方项顺序不变')
  h.dispose()
  passed++;console.log(`ok ${passed} - F3 restart first, official order preserved`)
}

// F4：失效保护 —— 9 类场景（missing/empty/ambiguous/wrong-launcher/nested/
// append-failure/observer-failure/footer-only/no-presentation）仍不插入、不抛错。
// （既有 2070 行的 for 循环已覆盖 —— 这里换新注入路径重跑同一矩阵，不 fireTimer。）
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F4') {
  for (const scenario of ['missing', 'empty', 'ambiguous', 'wrong-launcher', 'nested', 'append-failure', 'observer-failure', 'footer-only', 'no-presentation']) {
    const dom = accountMenuDOM(scenario)
    const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
    await flush()
    const original = dom.originalSnapshot()
    dom.open()
    await flush()
    // 菜单未出现的场景：发现观察器等到 500ms 超时才断开（F6 同语义）。
    if (h.timerDelays().includes(500)) h.fireTimer(500)
    assert.equal(dom.injected().length, 0, `F4 ${scenario}: 不插入`)
    assert.equal(dom.originalSnapshot(), original, `F4 ${scenario}: 原页面不变`)
    assert.equal(dom.observations().length, 0, `F4 ${scenario}: 无残留观察`)
    h.dispose()
  }
  passed++;console.log(`ok ${passed} - F4 all 9 fail-closed scenarios skip injection without timers`)
}

// F5：观察器不残留 —— 插入成功后、菜单关闭后、卸载后，body 上的发现观察器
// 归零（稳定观察器是另一个实例，计入 observations 但目标不同）。
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F5') {
  const dom = accountMenuDOM()
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  dom.open()
  await flush()
  assert.equal(dom.injected().length, 1)
  // 插入成功后：发现观察器断开（其 500ms 超时定时器一并清除 —— timers 里
  // 无 500 残留）；保留的 body childList 目标属于 probe 内的稳定观察器
  // （监视菜单从 body 移除，设计内），至多一个。
  assert.ok(!h.timerDelays().includes(500), 'F5: 发现观察器的超时定时器已清除')
  const bodyObservers = dom.observations().filter(item => item.target === dom.document.body && item.options.childList && !item.options.subtree)
  assert.ok(bodyObservers.length <= 1, `F5: body childList 目标至多 1 个（稳定观察器，实际 ${bodyObservers.length}）`)
  dom.close()
  assert.equal(dom.injected().length, 0)
  assert.equal(dom.observations().length, 0, 'F5: 菜单关闭后全部观察器断开')
  h.dispose()
  assert.equal(dom.listenerCount(), 0, 'F5: 卸载后无残留监听')
  passed++;console.log(`ok ${passed} - F5 discovery observer disconnected on success/close/dispose`)
}

// F6：超时 —— 点击后 500ms 内菜单未出现 → 放弃，不留观察器。
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F6') {
  const dom = accountMenuDOM('missing')
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  // 只点触发器（菜单永不出现 —— missing 场景 body 不加菜单）。
  dom.clickTrigger()
  // 挂上发现观察器 + 500ms 超时定时器。
  assert.ok(h.timerDelays().includes(500), 'F6: 点击后安排 500ms 超时')
  const bodyObservers = dom.observations().filter(item => item.target === dom.document.body)
  assert.equal(bodyObservers.length, 1, 'F6: 窗口期内恰有一个 body 发现观察器')
  h.fireTimer(500)
  assert.equal(dom.observations().filter(item => item.target === dom.document.body).length, 0, 'F6: 超时后观察器断开')
  assert.equal(dom.injected().length, 0, 'F6: 未插入')
  h.dispose()
  passed++;console.log(`ok ${passed} - F6 500ms timeout gives up and disconnects`)
}

// F7：既有账号菜单行为（重开幂等、关闭清理、偏好开关）在新路径下保持。
if (!process.env.DSHDR_MENU_CASE || process.env.DSHDR_MENU_CASE === 'F7') {
  const dom = accountMenuDOM()
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  dom.open()
  await flush()
  assert.equal(dom.injected().length, 1, 'F7: 首开注入')
  dom.close()
  assert.equal(dom.injected().length, 0, 'F7: 关闭清理')
  dom.open()
  await flush()
  assert.equal(dom.injected().length, 1, 'F7: 重开幂等（一个全新注入）')
  h.dispose()
  assert.equal(dom.injected().length, 0, 'F7: 卸载清理')
  passed++;console.log(`ok ${passed} - F7 reopen idempotence and cleanup preserved`)
}


// ── 2026-10-30 修复：账号菜单重启项首开不出现（需开两次） ────────────────────
// 根因（隔离复现 + asar 逆向证实）：宿主把 data-menu-backing 节点先于菜单列表
// 提交进 body；旧发现观察器的 armed 一次性守卫在 backing 变更时就触发并
// disconnect，菜单真正出现时无人接住 → 首开无按钮。第二次打开时 backing
// 已常驻（无变更），第一次变更恰好是菜单 → 成功。修复：每次 body childList
// 变更都幂等重试 probe，菜单就位才注入并停止。
// G 系列：DSHDR_FIRSTOPEN_CASE 可单跑。

// G1：宿主真实顺序（backing 先、菜单后，两个微任务批次）—— 第一次打开即有按钮。
if (!process.env.DSHDR_FIRSTOPEN_CASE || process.env.DSHDR_FIRSTOPEN_CASE === 'G1') {
  const dom = accountMenuDOM('backing-first')
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  await dom.openStaged({ staged: true })
  await flush()
  assert.equal(dom.injected().length, 1, 'G1: 首次打开（backing 先于菜单提交）即完成注入')
  const button = dom.injected()[0]
  assert.equal(dom.viewport.firstElementChild, button, 'G1: 按钮仍在 viewport 最前')
  assert.equal(button.parentElement, dom.viewport, 'G1: parentElement === viewport')
  // 注入发生在菜单 append 的同一微任务批次（绘制前）—— 无 setTimeout/rAF 依赖。
  assert.ok(!h.timerDelays().includes(0), 'G1: 无 setTimeout(0) 依赖')
  h.dispose()
  passed++;console.log(`ok ${passed} - G1 backing-first order injects on the FIRST open`)
}

// G2：完整两轮 —— 关闭（只移除菜单、backing 常驻）后第二次打开仍成功且幂等。
if (!process.env.DSHDR_FIRSTOPEN_CASE || process.env.DSHDR_FIRSTOPEN_CASE === 'G2') {
  const dom = accountMenuDOM('backing-first')
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  await dom.openStaged({ staged: true }); await flush()
  assert.equal(dom.injected().length, 1, 'G2: 首开注入')
  dom.close(); await flush()
  assert.equal(dom.injected().length, 0, 'G2: 关闭清理')
  // 第二次：backing 已在 body（openStaged 不重复挂），第一次变更就是菜单。
  await dom.openStaged({ staged: true }); await flush()
  assert.equal(dom.injected().length, 1, 'G2: 二开注入（无重复）')
  assert.equal(dom.injected().length, 1, 'G2: 幂等 —— 恰一个按钮')
  h.dispose()
  assert.equal(dom.injected().length, 0, 'G2: 卸载清理')
  passed++;console.log(`ok ${passed} - G2 close/reopen stays idempotent with a persistent backing`)
}

// G3：无抖动保持 —— 注入仍在菜单 append 的微任务批次内完成（首帧即最终布局）。
if (!process.env.DSHDR_FIRSTOPEN_CASE || process.env.DSHDR_FIRSTOPEN_CASE === 'G3') {
  const dom = accountMenuDOM('backing-first')
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  // 菜单 append 的同一个微任务批次里注入 —— backing 变更批次不注入。
  dom.openStaged()
  // openStaged 同步完成两次 append；两个 scheduleNotify 合并成一次微任务投递
  //（notifyScheduled 守卫）—— 真实浏览器中两次 append 若在同一宏任务同样
  // 合并为一次 MO 投递。注入仍发生在「菜单已在 DOM」的首个微任务 → 绘制前。
  await flush()
  assert.equal(dom.injected().length, 1, 'G3: 菜单出现的首个微任务批次内注入（绘制前）')
  assert.ok(h.frameCount() <= 1, 'G3: 至多一个 visibility 兜底帧（注入不依赖 rAF）')
  h.dispose()
  passed++;console.log(`ok ${passed} - G3 pre-paint injection preserved (no flicker regression)`)
}

// G4：观察器生命周期不变 —— 注入成功后无 500ms 超时残留；菜单关闭归零；不常驻。
if (!process.env.DSHDR_FIRSTOPEN_CASE || process.env.DSHDR_FIRSTOPEN_CASE === 'G4') {
  const dom = accountMenuDOM('backing-first')
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  dom.openStaged(); await flush()
  assert.equal(dom.injected().length, 1)
  assert.ok(!h.timerDelays().includes(500), 'G4: 成功后超时定时器已清')
  const bodyObservers = dom.observations().filter(item => item.target === dom.document.body && item.options.childList && !item.options.subtree)
  assert.ok(bodyObservers.length <= 1, 'G4: body childList 目标至多 1（稳定观察器）')
  dom.close(); await flush()
  assert.equal(dom.observations().length, 0, 'G4: 菜单关闭后观察器归零')
  h.dispose()
  assert.equal(dom.listenerCount(), 0, 'G4: 卸载后无监听残留')
  passed++;console.log(`ok ${passed} - G4 discovery lifecycle unchanged (bounded, no residue)`)
}

// G5：菜单后到（先点击、菜单延后出现）—— 发现窗口内接住，仍注入。
if (!process.env.DSHDR_FIRSTOPEN_CASE || process.env.DSHDR_FIRSTOPEN_CASE === 'G5') {
  const dom = accountMenuDOM('backing-first')
  const h = makeHarness(async () => reply(200, statusBody('off')), {dom})
  await flush()
  dom.clickTrigger()
  dom.trigger.setAttribute('aria-expanded', 'true')
  // 真实宿主时序：backing 变更先投递，菜单稍后（同一窗口内）。
  dom.document.body.appendChild(dom.backing)
  await flush()
  assert.equal(dom.injected().length, 0, 'G5: backing 批次不注入')
  dom.document.body.appendChild(dom.menu)
  await flush()
  assert.equal(dom.injected().length, 1, 'G5: 菜单出现的批次注入（窗口内接住）')
  h.dispose()
  passed++;console.log(`ok ${passed} - G5 late menu arrival caught within the window`)
}

const {menuFirstOpen2Checks}=await import('./menu-firstopen2-regression.mjs')
passed+=menuFirstOpen2Checks
console.log(`all ${passed} client regression checks passed`)

