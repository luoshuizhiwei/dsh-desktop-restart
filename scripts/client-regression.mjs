import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
let passed = 0

function ok(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

function element(type, props, ...children) {
  return { type, props: props ?? {}, children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children }
}

function walk(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = Array.isArray(node.children) ? node.children : [node.children]
  for (const child of children) {
    const found = walk(child, predicate)
    if (found !== null) return found
  }
  return node.props?.children ? walk(node.props.children, predicate) : null
}

function hookState() {
  return { states: [], cursor: 0, effectMeta: [], pendingEffects: [], effectCursor: 0 }
}

function makeHarness(fetchHandler, options = {}) {
  const clock = options.clock
  let factory
  let activeHook
  let settingsSection
  let settingsRestartRow
  let sidebarRestartAction
  let restartPanel
  let headerRestartButton
  let sweepRow
  let nextTimerId = 1
  const timers = new Map()
  const registrations = new Map()
  const style = { dataset: {}, textContent: '' }
  const document = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
    body: { querySelectorAll: () => options.menuItems ?? [] },
    querySelectorAll: () => (options.menuItems ?? []).filter(item => item.attributes.has('data-dshdr-hidden')),
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: element,
    useState(initial) {
      const hook = activeHook
      const index = hook.cursor++
      if (!(index in hook.states)) hook.states[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        hook.states[index] = typeof next === 'function' ? next(hook.states[index]) : next
      }
      return [hook.states[index], set]
    },
    useEffect(effect, deps) {
      const hook = activeHook
      const index = hook.effectCursor++
      hook.pendingEffects.push({ index, effect, deps })
    },
    useRef(initial) {
      const hook = activeHook
      const index = hook.cursor++
      if (!(index in hook.states)) hook.states[index] = { current: initial }
      return hook.states[index]
    },
  }
  const window = {
    localStorage: options.storage ?? { getItem: () => null, setItem() {} },
    setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    __ModuleLoader__: { load(definition) { factory = definition.factory } },
    // 测试时钟接缝：只在传了 clock 时暴露，生产没有这个字段
    ...(clock ? { __dshdrNow: () => clock.now } : {}),
  }
  const fetch = (url, options = {}) => fetchHandler(url, options)
  vm.runInNewContext(source, {
    window,
    document,
    navigator: { language: 'en-US' },
    fetch,
    console,
    Symbol,
  })
  const plugin = factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected module ${name}`)
  })
  const slots = {
    inject(_name, callback) { return callback() },
    register(spec, component) {
      const key = `${spec.name}:${spec.id ?? spec.key}`
      registrations.set(key, component)
      if (spec.name === 'settings.section') settingsSection = component
      if (spec.name === 'settings.general.item') settingsRestartRow = component
      if (spec.name === 'sidebar.footer.action') sidebarRestartAction = component
      if (spec.name === 'main' && spec.key === 'dsh-desktop-restart') restartPanel = component
      if (spec.name === 'conversation.session.header.actions') headerRestartButton = component
      return () => registrations.delete(key)
    },
  }
  plugin.apply({
    get(name) { return name === 'slots' ? slots : undefined },
    effect(run) { run() },
  })

  function render(component, hook = hookState(), runEffects = true) {
    hook.cursor = 0
    hook.effectCursor = 0
    hook.pendingEffects = []
    activeHook = hook
    let tree
    try {
      tree = component()
    } finally {
      activeHook = undefined
    }
    if (runEffects) for (const pending of hook.pendingEffects) {
      const previous = hook.effectMeta[pending.index]
      const changed = previous === undefined || pending.deps === undefined
        || pending.deps.length !== previous.deps.length
        || pending.deps.some((value, index) => !Object.is(value, previous.deps[index]))
      if (!changed) continue
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      const cleanup = pending.effect()
      hook.effectMeta[pending.index] = { deps: pending.deps, cleanup }
    }
    return { tree, hook }
  }
  const section = render(settingsSection, hookState(), false)
  sweepRow = walk(section.tree, (node) => node.type?.name === 'SweepRow')
  assert.ok(sweepRow, 'SettingsSection must contain SweepRow')
  return {
    render,
    settingsComponent: settingsSection,
    hideContactComponent: walk(section.tree, node => node.type?.name === 'HideContactRow').type,
    activeSlots: () => Array.from(registrations.keys()).sort(),
    settingsRestartComponent: settingsRestartRow,
    sidebarComponent: sidebarRestartAction,
    sweepComponent: sweepRow.type,
    panelComponent: restartPanel,
    headerComponent: headerRestartButton,
    // 注入 <style> 后的完整 CSS 文本（stub 的 style.textContent 被 factory 写入）。
    // 「恰好一次」断言用它推导各 span 在宽/窄屏下的真实可见性 —— 不硬编码。
    cssText: () => String(style.textContent),
    fireTimer(delay) {
      const entry = Array.from(timers.entries()).find(([, timer]) => delay === undefined || timer.delay === delay)
      assert.ok(entry, `timer with delay ${delay ?? 'any'} should exist`)
      timers.delete(entry[0])
      entry[1].callback()
    },
    timerDelays() { return Array.from(timers.values(), (timer) => timer.delay) },
    unmount(hook) {
      for (const entry of hook.effectMeta) if (typeof entry?.cleanup === 'function') entry.cleanup()
      hook.effectMeta = []
    },
  }
}

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function flush() {
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

async function acceptRestart(harness, component) {
  const instance = harness.render(component)
  await flush()
  let tree = harness.render(component, instance.hook).tree
  const findRestart = () => buttons(tree).find((button) => (button.props['data-variant'] === 'primary' || /whole desktop app|整个桌面应用/u.test(String(button.props.title ?? ''))) && button.props.onClick)
  let button = findRestart()
  assert.ok(button, 'restart button exists')
  assert.equal(button.props.disabled, false, 'old terminal state allows a new request')
  button.props.onClick()
  tree = harness.render(component, instance.hook).tree
  button = findRestart()
  button.props.onClick()
  await flush()
  for (let i = 0; i < 3; i += 1) tree = harness.render(component, instance.hook).tree
  return { tree, hook: instance.hook }
}

function buttons(tree) {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.type === 'button') found.push(node)
    const children = Array.isArray(node.children) ? node.children : [node.children]
    for (const child of children) visit(child)
  }
  visit(tree)
  return found
}

function buttonWithText(tree, text) {
  const result = buttons(tree).find((button) => button.children === text || button.props['aria-label'] === text)
  assert.ok(result, `button "${text}" should exist`)
  return result
}

function textContent(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  const children = Array.isArray(node.children) ? node.children : [node.children]
  return children.map(textContent).join(' ')
}


function hintText(tree) {
  const hint = walk(tree, (node) => node.type === 'span' && node.props.className === 'dshdr-set-hint' && node.props['aria-live'] === 'polite')
  return hint?.children ?? ''
}

function statusBody(resume = 'off', extras = {}) {
  return {
    desktop: true,
    guard: { active: false, tasks: { active: false, turns: 0, queued: 0, jobs: 0 }, installs: { active: false, running: false } },
    entries: { panel: false, footer: false, header: false, settingsRow: false },
    resume,
    ...extras,
  }
}


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
  const notes = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.type === 'p' && node.props.className === 'dshdr-panel-note') notes.push(node.children)
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
    assert.match(text, /Restarting now would interrupt them/u)
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
  assert.match(textContent(tree), /Restart complete/u)
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
await testTerminalRestart('panelComponent', { id: 'ok-op', result: 'ok', phase: 'ready', helperAlive: false, busy: false }, /Restart complete/u, false)
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
  for (const state of ['waiting', 'countdown', 'paused']) {
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
    if (state === 'waiting') {
      latest = { ...latest, state: 'terminal', executed: false, message: 'Not executed' }
      harness.fireTimer(2000)
      await flush()
      harness.render(harness.panelComponent, mounted.hook)
      confirm.props.onClick()
      await flush()
      assert.equal(posts, 0, 'an expired confirmation must not create a new request')
    } else {
      confirm.props.onClick()
      await flush()
      assert.equal(posts, 1)
    }
    harness.unmount(mounted.hook)
  }
  passed += 1
  console.log(`ok ${passed} - 4A immediate action confirms separately in all pre-execution states and rejects a stale confirmation`)
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
if (!process.env.DSHDR_ENTRY_CASE || process.env.DSHDR_ENTRY_CASE === 'R5') {
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
  const label=walk(tree,node=>node.type==='span'&&node.props.className==='dshdr-foot-label')
  assert.ok(label,'R5: sidebar label span exists during countdown')
  assert.match(String(label.children),/\d+s/u,'R5: countdown seconds must appear in the entry label')
  const button=walk(tree,node=>node.type==='button'&&node.props.className==='dshdr-foot-badge')
  assert.match(String(button.props.title),/countdown/iu,'R5: tooltip must mention the countdown')
  assert.match(String(button.props.title),/5s/u,'R5: tooltip countdown includes remaining seconds')
  assert.match(String(button.props['aria-label']),/\d+s/u,'R5: aria-label carries the remaining seconds')
  const described=walk(tree,node=>node.type==='span'&&node.props.className==='dshdr-sr-only')
  assert.ok(described,'R5: aria-describedby text exists during countdown')
  assert.match(String(described.children),/countdown/iu,'R5: aria-description mentions the countdown')
  h.unmount(header.hook)
  // paused：按钮文字显示「已暂停」类短词。
  const pausedHarness=makeHarness(async()=>reply(200,statusBody('off',{
    waiting:{since:'2026-10-26T00:00:00.000Z',maxMs:1_800_000},
    restartRequest:{state:'paused',ask:'paused-ask',pausedReason:'new work',deadlineAt},
  })))
  const pausedMount=pausedHarness.render(pausedHarness.sidebarComponent)
  await flush()
  const pausedTree=pausedHarness.render(pausedHarness.sidebarComponent,pausedMount.hook).tree
  const pausedLabel=walk(pausedTree,node=>node.type==='span'&&node.props.className==='dshdr-foot-label')
  assert.ok(pausedLabel,'R5: sidebar label span exists while paused')
  assert.match(String(pausedLabel.children),/paused|已暂停|暂停/iu,'R5: paused state must be visible in the entry label')
  assert.match(String(walk(pausedTree,node=>node.type==='button'&&node.props.className==='dshdr-foot-badge').props.title),/paused|暂停/iu,'R5: paused tooltip mentions the pause')
  pausedHarness.unmount(pausedMount.hook)
  passed++;console.log(`ok ${passed} - R5 countdown and paused are visible in entry label, tooltip, and aria copy`)
}

// R6：既有行为不退化 —— warn 态（宿主 409+guard，0.4.4 真机形态）二击必须发
// **普通请求**（不带 force/now）；等待/倒计时仍由宿主管。当前代码二击发的是
// submit({force:true})，直接抢跑 —— 这条就是缺陷 1 的客户端入口。
if (!process.env.DSHDR_ENTRY_CASE || process.env.DSHDR_ENTRY_CASE === 'R6') {
  let posts=[]
  let phase='warn'   // warn: POST 回 409+guard（0.4.4 宿主）; accepted: 回 202 waiting
  const h=makeHarness(async(url,options)=>{
    if(options.method==='POST'){
      posts.push(url)
      if(phase==='warn'){
        return reply(409,{ok:false,guard:{active:true,blocked:false,reasons:['有任务在跑'],tasks:{active:true,turns:1,queued:0,jobs:0},installs:{active:false,running:false}},error:'有任务在跑'})
      }
      return reply(202,{ok:true,waiting:true,since:'2026-10-26T00:00:00.000Z',restartRequest:{state:'waiting'}})
    }
    return reply(200,statusBody('off',{guard:{active:true,blocked:false,reasons:['有任务在跑'],tasks:{active:true,turns:1,queued:0,jobs:0},installs:{active:false,running:false}}}))
  })
  const mount=h.render(h.panelComponent)
  await flush()
  let tree=h.render(h.panelComponent,mount.hook).tree
  // 双击确认的第一段：两击提交一个普通请求 -> 宿主 409+guard -> 客户端进 warn 态。
  let primary=buttons(tree).find(b=>b.props['data-variant']==='primary')
  primary.props.onClick()
  await flush()
  tree=h.render(h.panelComponent,mount.hook).tree
  primary=buttons(tree).find(b=>b.props['data-variant']==='primary')
  primary.props.onClick()
  await flush()
  assert.equal(posts.length,1,'R6: double-click confirmation sends one ordinary request')
  assert.doesNotMatch(posts[0],/force=1|now=1/u,'R6: the submitted request carries neither force nor now')
  tree=h.render(h.panelComponent,mount.hook).tree
  // warn 态武装（900ms 冷却）：烧掉 timer。
  const armDelay=h.timerDelays().find(ms=>ms===900)
  if(armDelay!==undefined) h.fireTimer(900)
  tree=h.render(h.panelComponent,mount.hook).tree
  // 用户在 warn 态的第二次点击（本意只是「确认」）：
  primary=buttons(tree).find(b=>b.props['data-variant']==='primary')
  phase='accepted'
  primary.props.onClick()
  await flush()
  assert.equal(posts.length,2,'R6: the warn-state confirmation click submits again')
  assert.doesNotMatch(posts[1],/force=1|now=1/u,'R6: the warn-state confirmation must resend a PLAIN request, never force')
  h.unmount(mount.hook)
  passed++;console.log(`ok ${passed} - R6 the warn-state second click resends a plain request without force`)
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

// H1：四种非 idle 状态下，标题栏渲染出**默认 CSS 可见**的状态文字。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H1') {
  const clock={now:1_800_000_000_000}
  const deadlineAt=new Date(clock.now+1_800_000).toISOString()
  const cases=[
    {name:'confirm', statusExtras:{}, expect:/confirm|restart now|确认重启/ui, clickFirst:true},
    {name:'countdown', statusExtras:{waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},restartRequest:{state:'countdown',countdownRemainingMs:5000,countdownUntil:new Date(clock.now+5_000).toISOString(),deadlineAt}}, expect:/5s|倒计时/ui},
    {name:'waiting', statusExtras:{waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},restartRequest:{state:'waiting',deadlineAt}}, expect:/waiting|等待中/ui},
    {name:'paused', statusExtras:{waiting:{since:new Date(clock.now-1_000).toISOString(),maxMs:1_800_000},restartRequest:{state:'paused',ask:'h1-ask',pausedReason:'new work',deadlineAt}}, expect:/paused|已暂停|暂停/ui},
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
    // 2026-10-28 重复文字回归：同一状态文案在任一宽度档位下只出现**一次**。
    // 可见性从实际注入的 CSS 推导（宽屏：label 可见、header-state 应不可见；
    // 窄屏：label 被隐藏、header-state 接管）。此前只断言「存在」，宽屏下
    // label 与 header-state 并排各渲染一遍「确认重启」也照样通过——没抓住。
    const vis = deriveSpanVisibility(h.cssText())
    for (const narrow of [false, true]) {
      const hits = visibleStatusTexts(tree, narrow, vis).filter(tx => c.expect.test(tx)).length
      assert.equal(hits, 1, `H1 ${c.name} (${narrow ? 'narrow <=540px' : 'wide >540px'}): the status text must appear exactly once, got ${hits}`)
    }
    h.unmount(mount.hook)
  }
  passed++;console.log(`ok ${passed} - H1 confirm/countdown/waiting/paused are visibly rendered in the header`)
}

// H2：idle 时标题栏不渲染任何额外可见文字/徽标（状态节点为空）。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H2') {
  const h=makeHarness(async()=>reply(200,statusBody()))
  const mount=h.render(h.headerComponent)
  await flush()
  const tree=h.render(h.headerComponent,mount.hook).tree
  assert.equal(headerStateNodes(tree).length,0,'H2: idle header must not render state text or badge')
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
  const reads0=h.timerDelays().length
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

// H6：注入 CSS 必须含互补规则 —— .dshdr-header-state 默认 display:none，
// 仅在 @container(width<=540px) 内 display:inline（与 .dshdr-label 的
// 窄屏隐藏正好互补），保证同一状态文字任何宽度下只出现一次。
if (!process.env.DSHDR_HEADER_CASE || process.env.DSHDR_HEADER_CASE === 'H6') {
  const h=makeHarness(async()=>reply(200,statusBody()))
  const css=h.cssText()
  assert.ok(css.includes('.dshdr-header-state{display:none'),
    'H6: .dshdr-header-state 默认必须 display:none（宽屏交给按钮自带的 .dshdr-label）')
  assert.ok(/@container \(width<=540px\)\{[^}]*\.dshdr-header-state\{display:inline/.test(css),
    'H6: 窄容器（≤540px）内 .dshdr-header-state 必须 display:inline')
  // 互补前提：.dshdr-label 在同一窄容器查询内隐藏；基础规则无全局隐藏。
  assert.ok(/@container \(width<=540px\)\{[^}]*\.dshdr-label\{display:none/.test(css),
    'H6: 窄容器内 .dshdr-label 必须隐藏（互补的另一面）')
  assert.ok(!css.split('@container')[0].includes('.dshdr-label{display:none'),
    'H6: .dshdr-label 不得有全局 display:none（宽屏可见的前提）')
  passed++;console.log(`ok ${passed} - H6 injected CSS carries the complementary header-state/label visibility rules`)
}
console.log(`all ${passed} client regression checks passed`)
