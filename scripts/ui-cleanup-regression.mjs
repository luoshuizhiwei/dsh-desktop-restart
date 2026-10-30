import assert from 'node:assert/strict'
import {makeHarness,reply,statusBody,flush,walk,textContent,buttons} from './fixtures/client-harness.mjs'

export let uiCleanupChecks=0
for(const iso of ['2026-10-29T12:37:33.122Z',null,'','invalid-date',undefined]){
  const sampleAt=iso==='2026-10-29T12:37:33.122Z'?'2026-10-28T03:04:05Z':'invalid-sample'
  const health={backup:false,warn:true,limitBytes:16384,last:{status:'normal',checkedAt:iso,sample:{estimatedBytes:350,authCount:0,checkedAt:sampleAt}}}
  const h=makeHarness(async()=>reply(200,statusBody('off',{authCookie:health})))
  const mounted=h.render(h.authCookieComponent);await flush()
  const text=textContent(h.render(h.authCookieComponent,mounted.hook).tree)
  if(iso==='2026-10-29T12:37:33.122Z'){
    const format=value=>new Intl.DateTimeFormat('sv-SE',{dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(value))
    assert.ok(text.includes('Last check: '+format(iso)))
    assert.ok(text.includes('Last downtime check (estimate, not live): '+format(sampleAt)))
    assert.match(format(iso),/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    console.log(`COOKIE LOCAL TIME: ${iso} => ${format(iso)}; timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  }else{
    assert.ok(text.includes('Last check: Not checked yet'))
    assert.ok(text.includes('Last downtime check (estimate, not live): Not checked yet'))
    assert.doesNotMatch(text,/Invalid Date/)
  }
  h.unmount(mounted.hook);h.dispose();uiCleanupChecks++
}

{
  let reads=0,writes=0,stored=null
  const h=makeHarness(async(_url,options)=>{
    if(options.method==='POST')writes++
    else reads++
    return reply(200,statusBody())
  },{storage:{getItem:key=>key==='dsh-desktop-restart.entries'?stored:null,setItem(key,value){if(key==='dsh-desktop-restart.entries')stored=value}}})
  const header=h.render(h.headerComponent),settings=h.render(h.settingsComponent);await flush()
  const renderHeader=()=>h.render(h.headerComponent,header.hook).tree
  const refresh=()=>buttons(renderHeader()).find(button=>button.props['aria-label']==='Refresh')
  assert.equal(refresh(),undefined,'default off means no refresh button or empty label')
  assert.equal(walk(renderHeader(),node=>node.props?.className==='dshdr-label'),null)
  const renderSettings=()=>h.render(h.settingsComponent,settings.hook).tree
  const setting=()=>walk(renderSettings(),node=>node.type==='input'&&node.props['aria-label']==='Refresh button in the session header')
  assert.equal(setting().props.checked,false)
  assert.doesNotMatch(textContent(renderSettings()),/Health and diagnostics|Account menu diagnostic|健康与诊断|账号菜单诊断/)
  setting().props.onChange({target:{checked:true}})
  assert.equal(setting().props.checked,true)
  const button=refresh();assert.ok(button,'enabling is immediate, without page reload')
  assert.ok(walk(button,node=>node.props?.['data-refresh-status-icon']==='1'))
  const before=reads;button.props.onClick();await flush()
  assert.equal(reads,before+1,'click invokes the actual shared status refresh')
  assert.equal(writes,0,'refresh never submits restart or preferences')
  setting().props.onChange({target:{checked:false}})
  assert.equal(refresh(),undefined,'disabling removes it immediately')
  assert.equal(JSON.parse(stored).headerRefresh,false)
  h.unmount(header.hook);h.unmount(settings.hook);h.dispose();uiCleanupChecks++
}

for(const [stored,host,expected] of [[{},undefined,false],[{},true,true],[{headerRefresh:false},true,false],[{headerRefresh:true},false,true]]){
  const h=makeHarness(async()=>reply(200,statusBody('off',{entries:host===undefined?{}:{headerRefresh:host}})),{storage:{getItem:key=>key==='dsh-desktop-restart.entries'?JSON.stringify(stored):null,setItem(){}}})
  await flush();const mounted=h.render(h.headerComponent);await flush()
  assert.equal(buttons(h.render(h.headerComponent,mounted.hook).tree).some(button=>button.props['aria-label']==='Refresh'),expected)
  h.unmount(mounted.hook);h.dispose();uiCleanupChecks++
}
console.log(`PASS UI CLEANUP: ${uiCleanupChecks} local-time, invalid-input, removed-diagnostic and live refresh preference checks`)
