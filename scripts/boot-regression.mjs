// 客户端入口/组件桩与包布局冒烟（不替代真实 Loader 或 Electron 冷启动）。
//
// 为什么需要它：client-regression 用的是自制假 React + 假座位，任何
// “注册了不存在的座位”“apply() 抛异常”“组件渲染就崩”的问题都能带着全绿通过。
// 当前宿主确实声明了 conversation.session.header.utilities；不能把固定
// 注册集合当作宿主座位是否存在的证明。启动失败须以原始异常和安装布局定位。
//
// 这个文件做三件事：
//   1. 用 bundle 真实的入口契约（window.__ModuleLoader__.load）取出 factory；
//   2. 用**严格座位表**跑一遍 apply()：注册未知座位直接失败；
//   3. 逐个渲染注册进来的组件，确认不会一渲染就抛。
//
// 座位是否真实存在，以当前 DSH 安装包的 app.asar 为准（找不到 asar 时跳过这一项，
// 并明确打印跳过原因，不假装通过）。

import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// 宿主从 host 入口向上找最近的同名清单，再相对该目录解析 ./client。
// 部署时把根 package.json 复制进 lib 会使路径变成 lib/lib/client.js。
// CI 检查源码布局；本机恢复/部署时显式传入安装根，同时检查实际安装。
const packageRoots = [join(here, '..'), process.env.DSH_RESTART_INSTALLED_ROOT].filter(Boolean)
for (const root of new Set(packageRoots.map((path) => realpathSync(path)))) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const entry = join(root, pkg.exports['.'].default)
  let directory = dirname(entry)
  let selected = null
  while (true) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === pkg.name) {
      selected = directory
      break
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  assert.equal(selected, root, `包根被嵌套清单遮蔽：${root}`)
  assert.ok(existsSync(join(selected, pkg.exports['./client'].default)), `客户端产物不存在：${root}`)
  // 2026-10-23 事故：lib/ 里多一份 package.json 会让 "./lib/client.js" 被解析成 lib/lib/client.js
  const libEntries = readdirSync(join(root, 'lib')).sort()
  assert.deepEqual(libEntries, ['client.js', 'helper.cjs', 'index.js', 'sweep.js'], `lib/ 目录必须只含 4 个运行文件；实际：${libEntries.join(', ')}`)
  console.log(`  ok    包布局：${root}`)
}

// ── React 最小实现（只覆盖本插件用到的 5 个 API）──────────────────────────
const hookState = { values: [], cursor: 0, effects: [] }
function resetHooks() {
  hookState.values = []
  hookState.cursor = 0
  hookState.effects = []
}
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    const index = hookState.cursor++
    if (!(index in hookState.values)) {
      hookState.values[index] = typeof initial === 'function' ? initial() : initial
    }
    return [
      hookState.values[index],
      (next) => {
        hookState.values[index] = typeof next === 'function' ? next(hookState.values[index]) : next
      },
    ]
  },
  useRef(initial) {
    const index = hookState.cursor++
    if (!(index in hookState.values)) hookState.values[index] = { current: initial ?? null }
    return hookState.values[index]
  },
  useEffect(fn) {
    hookState.effects.push(fn)
  },
  useCallback(fn) {
    return fn
  },
}

// ── UI 原语桩：故意不给 Button / 图标，逼插件走自己的兜底实现（更接近最坏情况）
const uiPrimitives = {}
const requireShim = (name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return uiPrimitives
  throw new Error(`boot-regression: unexpected require("${name}")`)
}

// ── 浏览器环境桩 ──────────────────────────────────────────────────────────
const storage = new Map()
const documentStub = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, style: {}, textContent: '' }),
  querySelector: () => null,
  querySelectorAll: () => [],
}
let capturedFactory = null
const windowStub = {
  __ModuleLoader__: {
    load(spec) {
      capturedFactory = spec.factory
    },
  },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  location: { reload() { throw new Error('boot-regression: 客户端不得整页重载') } },
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  React,
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ desktop: true }) }),
  URL,
  Date,
  Math,
  JSON,
}
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

assert.equal(typeof capturedFactory, 'function', 'bundle 必须通过 window.__ModuleLoader__.load 注册 factory')

// ── 真实座位表：以当前 DSH 安装包为准 ────────────────────────────────────
function readDshBundle() {
  const candidates = [
    process.env.DSH_ASAR,
    'D:\\develop\\AI Agent\\DeepSeek Harness\\resources\\app.asar',
  ].filter((p) => typeof p === 'string' && p !== '')
  for (const path of candidates) {
    if (existsSync(path)) return { path, text: readFileSync(path, 'latin1') }
  }
  return null
}
const dsh = readDshBundle()

// ── 座位白名单（2026-10-23）────────────────────────────────────────────────
// 本插件当前注册集合的回归护栏。新增注册时需核对宿主的实际声明/生命周期，
// 再更新集合；名单外不等于宿主不存在。仅字符串命中也不证明真实激活成功。
const ALLOWED_SLOTS = new Set([
  'conversation.session.header.actions',
  'settings.general.item',
  'settings.section',
  'sidebar.footer.action',
  'sidebar.panellist',
  'main',
])

// ── 严格座位注册表 ────────────────────────────────────────────────────────
const registrations = []
const injectedNames = []
const slots = {
  inject(name, callback) {
    assert.equal(typeof name, 'string', 'slots.inject 需要座位名')
    assert.ok(name.length > 0, 'slots.inject 的座位名不能为空')
    assert.ok(ALLOWED_SLOTS.has(name), `座位 "${name}" 不在白名单里——新增座位必须显式加入 ALLOWED_SLOTS 并说明依据`)
    injectedNames.push(name)
    callback()
    return () => {}
  },
  register(spec, Component) {
    assert.ok(spec !== null && typeof spec === 'object', 'slots.register 需要 spec 对象')
    assert.equal(spec.name, injectedNames[injectedNames.length - 1], 'register 的 name 必须与所在 inject 的座位一致')
    // 有的座位用 id，有的用 key（例如 main 座位用 key 指向 sidebar.panellist 的条目）
    const identifier = typeof spec.id === 'string' ? spec.id : (typeof spec.key === 'string' ? spec.key : null)
    assert.ok(identifier !== null, 'spec 需要 id 或 key 字符串')
    assert.equal(typeof Component, 'function', '组件必须是函数')
    registrations.push({ spec, Component, identifier })
    return () => {}
  },
}

const localeStub = {
  register() {},
  bind() {
    return (key) => key
  },
}
const ctx = {
  get(name) {
    if (name === 'slots') return slots
    if (name === 'locale') return localeStub
    if (name === 'timer') return undefined
    return undefined
  },
  locale: localeStub,
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  logger() {
    return { info() {}, warn() {}, error() {} }
  },
  inject() {},
  webServer: { register() { return () => {} } },
}

// ── 1) 跑 apply() ────────────────────────────────────────────────────────
const plugin = capturedFactory(requireShim)
assert.ok(plugin !== null && typeof plugin === 'object', 'factory 必须返回插件对象')
assert.equal(typeof plugin.apply, 'function', '插件必须导出 apply')
assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'], 'inject 声明必须与实现一致')

let applyError = null
try {
  plugin.apply(ctx)
} catch (error) {
  applyError = error
}
assert.equal(applyError, null, `apply() 不得抛异常：${applyError && applyError.message}`)
assert.ok(registrations.length >= 4, `至少应注册 4 个入口，实际 ${registrations.length}`)

// ── 2) 座位名必须真实存在于 DSH 安装包 ────────────────────────────────────
if (dsh === null) {
  console.log('  skip  座位真实性校验（找不到 DSH 安装包 app.asar；可用 DSH_ASAR 指定）')
} else {
  for (const { spec } of registrations) {
    assert.ok(
      dsh.text.includes(spec.name),
      `座位 "${spec.name}" 不存在于当前 DSH 安装包（${dsh.path}）——注册它会让插件激活失败`,
    )
  }
  console.log(`  ok    座位真实性：${registrations.length} 个座位名都能在 DSH 安装包里找到`)
}

// ── 3) 每个注册组件都要能渲染一次而不抛 ──────────────────────────────────
for (const { spec, Component } of registrations) {
  resetHooks()
  let tree = null
  let renderError = null
  try {
    tree = Component({})
  } catch (error) {
    renderError = error
  }
  assert.equal(renderError, null, `组件 ${spec.id ?? spec.key}（${spec.name}）渲染时抛异常：${renderError && renderError.message}`)
  assert.ok(tree !== null && tree !== undefined, `组件 ${spec.id ?? spec.key} 渲染结果不能是 null/undefined`)
  // headerRefreshGuard：会话标题栏必须同时有「重启」和「刷新」两个按钮
  if (spec.name === 'conversation.session.header.actions') {
    const labels = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.props !== undefined && node.props !== null) {
        const label = node.props['aria-label']
        if (typeof label === 'string') labels.push(label)
      }
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(tree)
    // 沙箱里 t() 没有词典会返回键名，所以键名与译文都算通过
    const hasRefresh = labels.some((label) => label === 'refreshShort' || label === '刷新' || label === 'Refresh')
    assert.ok(hasRefresh, `标题栏缺少「刷新」按钮（实际 aria-label: ${labels.join(' / ')}）`)
    // 刷新按钮只有文字、没有图标；而 .dshdr-label 默认 display:none —— 必须带 --label 修饰类才看得见
    const classes = []
    const collectClass = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      const cls = node.props && node.props.className
      if (typeof cls === 'string') classes.push(cls)
      if (Array.isArray(node.children)) node.children.forEach(collectClass)
    }
    collectClass(tree)
    assert.ok(
      classes.some((cls) => cls.includes('dshdr-trigger--label')),
      '刷新按钮必须带 dshdr-trigger--label（否则文字被 display:none 隐藏，按钮变透明）',
    )
  }
}

// ── 4) 客户端不得整页导航（2026-10-23 事故的静态守卫，双保险）────────────
for (const token of ['location.reload', 'location.href', 'location.assign', 'location.replace', 'history.go']) {
  assert.equal(source.includes(token), false, `客户端不得出现整页导航：${token}`)
}

console.log(`all ${registrations.length} registrations booted and rendered`)
