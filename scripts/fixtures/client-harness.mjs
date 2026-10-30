import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', '..', 'lib', 'client.js'), 'utf8')
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
  const frames = new Map()
  const registrations = new Map()
  const style = { dataset: {}, textContent: '' }
  const document = options.dom?.document ?? {
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
    requestAnimationFrame(callback) { const id = nextTimerId++; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    __ModuleLoader__: { load(definition) { factory = definition.factory } },
    // 测试时钟接缝：只在传了 clock 时暴露，生产没有这个字段
    ...(clock ? { __dshdrNow: () => clock.now } : {}),
  }
  const fetch = (url, options = {}) => fetchHandler(url, options)
  vm.runInNewContext((options.source ?? source).replace("const restartStore = createRestartStore();", "const restartStore = createRestartStore(); window.__testRestartStore = restartStore; window.__testUseRestart = useRestart;"), {
    window,
    document,
    MutationObserver: options.dom?.MutationObserver,
    navigator: { language: options.language ?? 'en-US' },
    fetch,
    console,
    Symbol,
  })
  const plugin = factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && options.primitives) return options.primitives
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
  const pluginCleanups = []
  plugin.apply({
    get(name) {
      // 2026-10-29 E 系列：可选注入客户端 timer 服务（armLater/expireLater 走
      // harness 的 timers Map，可 fireTimer 快进）；默认不开 —— 既有用例的
      // 「无 timer 服务 → armLater 立即生效」行为保持不变。
      if (name === 'timer' && options.timer) return { timeout: (fn, ms) => window.setTimeout(fn, ms) }
      return name === 'slots' ? slots : undefined
    },
    effect(run) { const cleanup = run(); if (typeof cleanup === "function") pluginCleanups.push(cleanup) },
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
    dispose() { for (const cleanup of pluginCleanups.reverse()) cleanup() },
    store: window.__testRestartStore,
    useRestart: window.__testUseRestart,
    settingsComponent: settingsSection,
    authCookieComponent: walk(section.tree, node => node.type?.name === 'AuthCookieHealth').type,
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
    frameCount() { return frames.size },
    fireFrame() { const pending = [...frames]; frames.clear(); for (const [,callback] of pending) callback() },
    settleMenu() { for (let i=0; frames.size && i<10; i++) this.fireFrame(); assert.equal(frames.size,0,'menu frame work must settle') },
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


export { source, element, walk, hookState, makeHarness, reply, flush, acceptRestart, buttons, buttonWithText, textContent, hintText, statusBody }
