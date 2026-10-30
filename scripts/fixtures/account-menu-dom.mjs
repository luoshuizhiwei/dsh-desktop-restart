// Deliberately small DOM fixture: selectors, event delegation, and explicit
// MutationObserver delivery. This proves plugin contracts, not Electron layout.
export function accountMenuDOM(scenario = 'normal') {
  const observers = new Set()
  const docListeners = new Map()
  let constructed = 0
  const insertEvents = []
  let body
  function matches(node, selector) {
    const tag = selector.match(/^[a-z]+/iu)?.[0]
    if (tag && tag !== node.tagName) return false
    for (const match of selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/gu)) {
      if (!node.attributes.has(match[1])) return false
      if (match[2] !== undefined && node.getAttribute(match[1]) !== match[2]) return false
    }
    return true
  }
  class Node {
    constructor(tag) { this.tagName = tag; this.attributes = new Map(); this.children = []; this.parentElement = null; this.style = {}; this.dataset = {}; this.className = ''; this.listeners = new Map(); this.ownText = '' }
    setAttribute(key, value) { this.attributes.set(key, String(value)) }
    getAttribute(key) { return this.attributes.get(key) ?? null }
    removeAttribute(key) { this.attributes.delete(key) }
    appendChild(node) {
      node.remove(); this.children.push(node); node.parentElement = this
      if (scenario === 'append-failure' && node.attributes.has('data-dshdr-account-inject')) throw new Error('simulated append rejection after attachment')
      return node
    }
    insertBefore(node, reference) {
      if (reference !== null && reference.parentElement !== this) throw new Error('NotFoundError: reference is not a child')
      node.remove(); this.children.splice(reference === null ? this.children.length : this.children.indexOf(reference), 0, node); node.parentElement = this
      if (node.attributes.has('data-dshdr-account-inject')) insertEvents.push({visibility:node.style.visibility,parent:this,reference})
      // Retain the legacy append-failure case for the insertion API now used.
      if (scenario === 'append-failure' && node.attributes.has('data-dshdr-account-inject')) throw new Error('simulated insertion rejection after attachment')
      return node
    }
    remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null } }
    get firstElementChild() { return this.children[0] ?? null }
    contains(node) { return node === this || this.children.some(child => child.contains(node)) }
    get isConnected() { return this === body || this.parentElement?.isConnected === true }
    get textContent() { return this.ownText + this.children.map(n => n.textContent).join('') }
    set textContent(value) { this.ownText = String(value); for (const child of this.children) child.parentElement = null; this.children = [] }
    querySelectorAll(selector) { return this.children.flatMap(n => [...(matches(n, selector) ? [n] : []), ...n.querySelectorAll(selector)]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    closest(selector) { return matches(this, selector) ? this : this.parentElement?.closest(selector) ?? null }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn) }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
  }
  body = new Node('body')
  // 2026-10-30：模拟真实 MutationObserver 的自动微任务投递 —— body 的
  // childList 变更（appendChild/insertBefore/remove 影响 body 的 children）后，
  // 把变更排进微任务通知所有活跃观察者（真实浏览器行为；旧 fixture 只能手动 notify）。
  const pendingMicrotask = { scheduled: false }
  const scheduleBodyNotify = () => {
    if (pendingMicrotask.scheduled) return
    pendingMicrotask.scheduled = true
    queueMicrotask(() => {
      pendingMicrotask.scheduled = false
      notify([])
    })
  }
  const rawBodyAppend = body.appendChild.bind(body)
  body.appendChild = (node) => { const r = rawBodyAppend(node); scheduleBodyNotify(); return r }
  const rawBodyInsert = body.insertBefore.bind(body)
  body.insertBefore = (node, ref) => { const r = rawBodyInsert(node, ref); scheduleBodyNotify(); return r }
  const rawBodyRemove = body.removeChild ? body.removeChild.bind(body) : null
  const head = new Node('head')
  const trigger = new Node('button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('data-collapsed', 'false')
  if (scenario !== 'wrong-launcher') trigger.setAttribute('data-signed-out', 'false')
  trigger.setAttribute('aria-expanded', 'false')
  body.appendChild(trigger)
  const menu = new Node('div')
  menu.setAttribute('role', 'menu'); menu.setAttribute('data-menu-material', 'translucent')
  // 2026-10-30: 宿主菜单的真实伴随节点（j1 渲染的 data-menu-backing），常驻 body。
  const backing = new Node('div')
  backing.setAttribute('data-menu-backing', ''); backing.setAttribute('aria-hidden', 'true')
  // Observed in Electron 2026-10-29: material precedes the presentation viewport.
  const material = new Node('div')
  material.className = '_material_ri079_21'; material.setAttribute('aria-hidden','true')
  menu.appendChild(material)
  const viewport = new Node('div')
  viewport.setAttribute('role', 'presentation'); viewport.className = 'official_viewport'
  menu.appendChild(viewport)
  const itemWrap = new Node('div'); itemWrap.className = 'official_itemWrap'
  const contactWrap = new Node('div'); contactWrap.className = 'official_itemWrap'
  const signoutWrap = new Node('div'); signoutWrap.className = 'official_itemWrap'
  const seed = new Node('button')
  seed.setAttribute('role', 'menuitem'); seed.textContent = 'Settings'; seed.className = 'official_item'
  const signout = new Node('button')
  signout.setAttribute('role', 'menuitem'); signout.textContent = 'Sign out'; signout.className = 'official_item'
  seed.setAttribute('data-host-id', scenario === 'signed-out' ? 'signin' : 'settings')
  signout.setAttribute('data-host-id', 'signout')
  const contact = new Node('button')
  contact.setAttribute('role', 'menuitem'); contact.setAttribute('data-host-id', 'contact'); contact.textContent = 'Feedback'; contact.className = 'official_item'
  const separator = new Node('div'); separator.setAttribute('role', 'separator')
  const footer = new Node('div'); footer.setAttribute('role', 'presentation'); footer.className = 'official_footer'
  const footerItem = new Node('button'); footerItem.setAttribute('role', 'menuitem'); footerItem.setAttribute('data-host-id', 'footer'); footerItem.textContent = 'Secondary'
  if (scenario !== 'empty') {
    if (scenario === 'signed-out') { seed.textContent = 'Sign in'; itemWrap.appendChild(seed); viewport.appendChild(itemWrap) }
    else {
      if (scenario === 'grouped') itemWrap.appendChild(separator)
      itemWrap.appendChild(seed); contactWrap.appendChild(contact); signoutWrap.appendChild(signout)
      viewport.appendChild(itemWrap); viewport.appendChild(contactWrap); viewport.appendChild(signoutWrap)
    }
  }
  if (scenario === 'grouped' || scenario === 'footer-only') { footer.appendChild(footerItem); menu.appendChild(footer) }
  if (scenario === 'staged') { itemWrap.remove(); contactWrap.remove() }
  if (scenario === 'footer-only') { for (const child of [...viewport.children]) child.remove() }
  if (scenario === 'no-presentation') viewport.removeAttribute('role')
  const document = {
    head, body,
    createElement: tag => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    querySelectorAll: selector => [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)],
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, new Set()); docListeners.get(type).add(fn) },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn) },
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; constructed++; observers.add(this) }
    observe(target, options) { this.targets.push({target, options}); if (scenario === 'observer-failure') throw new Error('simulated observer rejection') }
    disconnect() { this.targets = []; observers.delete(this) }
  }
  function notify(records = []) { for (const observer of [...observers]) observer.callback(records) }
  function clickTrigger() { for (const fn of docListeners.get('click') ?? []) fn({target:trigger}) }
  return {
    document, MutationObserver, menu, material, viewport, itemWrap, footer, separator, seed, trigger, backing,
    clickTrigger, notify, insertEvents,
    dispatchKey(event) { for(const fn of docListeners.get('keydown') ?? []) fn(event) },
    prependHostItem({beforeInjected=false, deliver=true} = {}) {
      const wrap = new Node('div'); wrap.className = 'official_itemWrap'
      const item = new Node('button'); item.setAttribute('role','menuitem'); item.setAttribute('data-host-id','new-first'); item.className = 'official_item'; item.textContent='New first'
      wrap.appendChild(item); viewport.insertBefore(wrap,beforeInjected ? viewport.firstElementChild : viewport.children.find(node=>!node.attributes.has('data-dshdr-account-inject')) ?? null)
      if (deliver) notify([{target:viewport,addedNodes:[wrap],removedNodes:[]}]); return item
    },
    rebuildFirstItem() {
      const old = viewport.children.find(node=>!node.attributes.has('data-dshdr-account-inject')); old.remove()
      const wrap = new Node('div'); wrap.className = 'official_itemWrap'
      const item = new Node('button'); item.setAttribute('role','menuitem'); item.setAttribute('data-host-id','settings'); item.className = 'official_item'; item.textContent='Settings rebuilt'
      wrap.appendChild(item); viewport.insertBefore(wrap,viewport.children.find(node=>!node.attributes.has('data-dshdr-account-inject')) ?? null)
      notify([{target:viewport,addedNodes:[wrap],removedNodes:[old]}]); return item
    },
    addStagedItem(id) {
      const wrap = id === 'settings' ? itemWrap : contactWrap
      viewport.insertBefore(wrap,viewport.children.find(node=>!node.attributes.has('data-dshdr-account-inject')) ?? null)
      notify([{target:viewport,addedNodes:[wrap],removedNodes:[]}])
    },
    clickItem() { const button = menu.querySelector('[data-dshdr-account-inject]'); for (const fn of button.listeners.get('click') ?? []) fn({stopPropagation(){}}) },
    open() {
      trigger.setAttribute('aria-expanded', 'true')
      // 2026-10-30 first-open fix 复现：真实宿主在菜单列表之前先向 body 提交
      // data-menu-backing 节点（j1 的 portal + useLayoutEffect 搬移）。旧实现
      // 的发现观察器一次性守卫在这种顺序下首开必失败。
      if (scenario === 'backing-first' && !backing.isConnected) body.appendChild(backing)
      if (scenario !== 'missing' && !menu.isConnected) {
        if (scenario === 'nested') { const wrapper = new Node('div'); body.appendChild(wrapper); wrapper.appendChild(menu) }
        else body.appendChild(menu)
        if (scenario === 'ambiguous') { const other = new Node('div'); other.setAttribute('role','menu'); other.setAttribute('data-menu-material','translucent'); body.appendChild(other) }
      }
      clickTrigger()
    },
    // 模拟宿主两次提交。staged=true：backing 与菜单分两个微任务批次投递
    //（真实 React 分批提交形态 —— 一致性投递合并的盲区由 G5 单独覆盖）；
    // 默认同批合并（既有用例兼容）。
    async openStaged({ staged = false } = {}) {
      // 真实顺序：用户先点击（触发 armDiscovery），React 随后分批提交。
      trigger.setAttribute('aria-expanded', 'true')
      clickTrigger()
      if (scenario !== 'missing' && !menu.isConnected) {
        if (!backing.isConnected) body.appendChild(backing)   // 变更#1: backing
        if (staged) { await Promise.resolve(); await new Promise(r => setImmediate(r)) }
        body.appendChild(menu)                                 // 变更#2: 菜单
      }
    },
    close() { trigger.setAttribute('aria-expanded', 'false'); menu.remove(); notify() },
    injected: () => menu.querySelectorAll('[data-dshdr-account-inject]'),
    observations: () => [...observers].flatMap(observer => observer.targets),
    observerCount: () => constructed,
    listenerCount: () => [...docListeners.values()].reduce((sum, set) => sum + set.size, 0),
    originalSnapshot: () => {
      const snapshot = node => ({attrs:[...node.attributes],className:node.className,text:node.ownText,style:node.style,listeners:[...node.listeners],children:node.children.filter(n => !n.attributes.has('data-dshdr-account-inject')).map(snapshot)})
      return JSON.stringify(snapshot(menu))
    },
  }
}
