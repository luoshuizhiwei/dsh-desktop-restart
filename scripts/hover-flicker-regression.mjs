import assert from 'node:assert/strict'
import {makeHarness, reply, flush, statusBody, textContent, walk} from './fixtures/client-harness.mjs'
import {accountMenuDOM} from './fixtures/account-menu-dom.mjs'

export let hoverChecks = 0
const active = () => statusBody('off', {guard: {active: true, tasks: {known: true, active: true, turns: 1, queued: 0, jobs: 0}, installs: {active: false, running: false}}})
function actionNodes(tree, type) {
  const found = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'button' || node.type === type) found.push(node)
    for (const child of Array.isArray(node.children) ? node.children : [node.children]) visit(child)
  }
  visit(tree)
  return found
}
function visibleState(nodes) {
  return nodes.map(node => ({text: textContent(node), type: node.type, disabled: node.props.disabled,
    variant: node.props.variant, dataVariant: node.props['data-variant'], className: node.props.className,
    style: node.props.style, title: node.props.title, ariaLabel: node.props['aria-label'],
    describedBy: node.props['aria-describedby'], busy: node.props['aria-busy']}))
}

// Hold the real status GET pending: observe the rendered props before, during and after hover.
for (const language of ['en-US', 'zh-CN']) for (const official of [false, true]) {
  const OfficialButton = function OfficialButton() {}
  let hold = false, resolve, gets = 0, posts = 0
  const h = makeHarness((_url, options) => {
    if (options.method === 'POST') { posts++; return Promise.resolve(reply(200, {ok: true})) }
    gets++
    return hold ? new Promise(r => { resolve = r }) : Promise.resolve(reply(200, active()))
  }, {language, ...(official ? {primitives: {Button: OfficialButton}} : {})})
  const mounted = h.render(h.panelComponent)
  await flush()
  let tree = h.render(h.panelComponent, mounted.hook).tree
  let nodes = actionNodes(tree, OfficialButton)
  assert.equal(nodes.length, 3, 'guarded panel has restart, refresh and wait actions')
  const baseline = visibleState(nodes)
  const timers = h.timerDelays()
  for (const index of [0, 2]) {
    hold = true
    const beforeGets = gets
    nodes[index].props.onMouseEnter()
    assert.equal(gets, beforeGets + 1, 'hover still makes exactly one existing status GET')
    tree = h.render(h.panelComponent, mounted.hook).tree
    nodes = actionNodes(tree, OfficialButton)
    console.log(`HOVER ${official ? 'official' : 'fallback'} before=${JSON.stringify(baseline.map(x => [x.text, x.disabled]))} pending=${JSON.stringify(visibleState(nodes).map(x => [x.text, x.disabled]))}`)
    assert.deepEqual(visibleState(nodes), baseline, 'hover must not change button text, sizing/style props, accessibility or order')
    resolve(reply(200, active()))
    await flush()
    nodes = actionNodes(h.render(h.panelComponent, mounted.hook).tree, OfficialButton)
    assert.deepEqual(visibleState(nodes), baseline, 'same host status leaves actions unchanged after hover')
    assert.equal(posts, 0, 'hover cannot restart or mutate settings')
    assert.deepEqual(h.timerDelays(), timers, 'hover introduces no polling or timer')
  }
  h.unmount(mounted.hook); h.dispose()
  hoverChecks++; console.log(`PASS HOVER stable panel actions (${official ? 'official props' : 'fallback'})`)
}

// Shared pending state must also stay quiet across the other entry points.
for (const entry of ['headerComponent', 'sidebarComponent', 'settingsComponent']) {
  let hold = false, resolve, gets = 0
  const h = makeHarness(() => {
    gets++
    return hold ? new Promise(r => {resolve = r}) : Promise.resolve(reply(200, active()))
  })
  const component = entry === 'settingsComponent'
    ? walk(h.render(h.settingsComponent).tree, node => node.type?.name === 'SettingsTitleAction').type
    : h[entry]
  const mount = h.render(component); await flush()
  const tree = h.render(component, mount.hook).tree
  const nodes = actionNodes(tree)
  const trigger = nodes.find(node => typeof node.props.onFocus === 'function')
  assert.ok(trigger, `${entry} has an intent-refresh trigger`)
  const before = visibleState(nodes), count = gets
  hold = true
  trigger.props.onFocus()
  assert.equal(gets, count + 1)
  assert.deepEqual(visibleState(actionNodes(h.render(component, mount.hook).tree)), before)
  resolve(reply(200, active())); await flush()
  assert.deepEqual(visibleState(actionNodes(h.render(component, mount.hook).tree)), before)
  h.unmount(mount.hook); h.dispose()
  hoverChecks++; console.log(`PASS HOVER quiet focus across ${entry}`)
}

// A background GET must neither clear an explicit refresh spinner early nor leave it stuck.
for (const scenario of ['executing', 'status-error']) {
  let hold = false, resolve
  const response = () => scenario === 'status-error' ? reply(503, {error: 'status unavailable'})
    : reply(200, statusBody('off', {restartBusy: true, restartOp: {id: 'hover-op', result: 'pending', phase: 'stop', helperAlive: true, busy: true}}))
  const h = makeHarness(() => hold ? new Promise(r => {resolve = r}) : Promise.resolve(response()))
  const panel = h.render(h.panelComponent), settings = h.render(h.settingsRestartComponent)
  await flush()
  const panelBefore = visibleState(actionNodes(h.render(h.panelComponent, panel.hook).tree))
  const settingsBefore = visibleState(actionNodes(h.render(h.settingsRestartComponent, settings.hook).tree))
  if (scenario === 'executing') {
    assert.equal(panelBefore[0].disabled, true)
    assert.equal(panelBefore[0].busy, 'true', 'execution busy accessibility is preserved')
  }
  hold = true
  const trigger = actionNodes(h.render(h.panelComponent, panel.hook).tree).find(node => node.props.onMouseEnter)
  trigger.props.onMouseEnter()
  assert.deepEqual(visibleState(actionNodes(h.render(h.panelComponent, panel.hook).tree)), panelBefore)
  assert.deepEqual(visibleState(actionNodes(h.render(h.settingsRestartComponent, settings.hook).tree)), settingsBefore, 'shared settings refresh must not flicker either')
  resolve(response()); await flush()
  assert.deepEqual(visibleState(actionNodes(h.render(h.panelComponent, panel.hook).tree)), panelBefore)
  h.unmount(panel.hook); h.unmount(settings.hook); h.dispose()
  hoverChecks++; console.log(`PASS HOVER ${scenario}: retry/refresh, settings and execution accessibility stay stable`)
}

// A background GET must neither clear an explicit refresh spinner early nor leave it stuck.
for (const quietFirst of [false, true]) {
  let hold = false
  const pending = []
  const h = makeHarness(() => hold ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(reply(200, active())))
  const mount = h.render(h.panelComponent); await flush()
  hold = true
  h.store.getSnapshot(null).refresh()
  h.store.getSnapshot(null).refreshOnIntent()
  assert.equal(pending.length, 2)
  assert.equal(h.store.getSnapshot(null).statusPending, true, 'explicit refresh retains visible loading feedback')
  pending[quietFirst ? 1 : 0](reply(200, active())); await flush()
  assert.equal(h.store.getSnapshot(null).statusPending, quietFirst, 'only the explicit read owns its loading state')
  pending[quietFirst ? 0 : 1](reply(200, active())); await flush()
  assert.equal(h.store.getSnapshot(null).statusPending, false, 'newer quiet result cannot strand an older explicit loading state')
  h.unmount(mount.hook); h.dispose()
  hoverChecks++; console.log(`PASS HOVER overlapping explicit/quiet refresh (${quietFirst ? 'quiet' : 'explicit'} first)`)
}

// Quiet refresh still applies new authoritative safety state, and surfaces real errors.
{
  let hold = false, resolve
  const h = makeHarness(() => hold ? new Promise(r => {resolve = r}) : Promise.resolve(reply(200, statusBody())))
  const mount = h.render(h.panelComponent); await flush()
  hold = true
  h.store.getSnapshot(null).refreshOnIntent()
  resolve(reply(200, active())); await flush()
  assert.notEqual(h.store.getSnapshot(null).guardHint, '', 'hover still learns the latest guard')
  h.store.getSnapshot(null).refreshOnIntent()
  resolve(reply(503, {error: 'hover status unavailable'})); await flush()
  assert.notEqual(h.store.getSnapshot(null).statusError, '', 'silent transport must not hide real status failures')
  assert.equal(h.store.getSnapshot(null).statusPending, false)
  h.unmount(mount.hook); h.dispose()
  hoverChecks++; console.log('PASS HOVER authoritative guards and status failures remain visible')
}

// Pending background work must not disturb the actual account-menu DOM item or its order.
{
  const dom = accountMenuDOM()
  let hold = false, resolve
  const h = makeHarness(() => hold ? new Promise(r => {resolve = r}) : Promise.resolve(reply(200, active())), {dom})
  const mount = h.render(h.panelComponent); await flush()
  dom.open(); await flush(); h.settleMenu()
  const item = dom.injected()[0], text = item.textContent, label = item.getAttribute('aria-label')
  const order = [...dom.viewport.children]
  hold = true
  const main = actionNodes(h.render(h.panelComponent, mount.hook).tree).find(node => node.props.onMouseEnter)
  main.props.onMouseEnter()
  assert.equal(dom.injected()[0], item)
  assert.equal(item.textContent, text)
  assert.equal(item.getAttribute('aria-label'), label)
  assert.deepEqual(dom.viewport.children, order)
  resolve(reply(200, active())); await flush()
  assert.equal(dom.injected()[0], item)
  assert.equal(item.textContent, text)
  h.unmount(mount.hook); h.dispose()
  hoverChecks++; console.log('PASS HOVER account-menu identity, label and order remain stable')
}
