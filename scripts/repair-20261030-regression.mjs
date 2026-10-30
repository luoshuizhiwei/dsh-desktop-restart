import assert from 'node:assert/strict'
import {makeHarness,reply,flush,statusBody,buttons,walk,textContent} from './fixtures/client-harness.mjs'
export let repairChecks=0
{
  let resolve
  const pending=new Promise(r=>{resolve=r})
  const h=makeHarness(()=>pending)
  h.dispose();assert.deepEqual(h.activeSlots(),[])
  resolve(reply(200,statusBody('off',{entries:{panel:false,footer:false,header:true,settingsRow:false,accountMenu:false,headerRefresh:false}})))
  await flush();assert.deepEqual(h.activeSlots(),[])
  repairChecks++;console.log('PASS REPAIR F2: late initial GET cannot register seats after disposal')
}
for(const phase of ['warn','confirm']){
  const clock={now:1000},callbacks=[]
  const h=makeHarness(()=>Promise.resolve(reply(200,statusBody('off',{guard:{active:phase==='warn',reasons:phase==='warn'?['task running']:[],tasks:{known:true,active:phase==='warn',turns:phase==='warn'?1:0,jobs:0,queued:0}}}))),{clock})
  h.store.bindTimer({timeout:(fn,ms)=>{callbacks.push({fn,ms})}})
  let unsub=h.store.subscribe(()=>{},'old',true);await flush()
  h.store.getSnapshot('old').press();assert.equal(h.store.getSnapshot('old').phase,phase)
  const oldCallbacks=[...callbacks]
  unsub();clock.now=1800;unsub=h.store.subscribe(()=>{},'new',true);await flush()
  h.store.getSnapshot('new').press();assert.equal(h.store.getSnapshot('new').phase,phase)
  for(const callback of oldCallbacks)callback.fn()
  assert.equal(h.store.getSnapshot('new').phase,phase,'old expiry cannot reset new phase')
  if(phase==='warn'){
    assert.equal(h.store.getSnapshot('new').armed,false,'old arm cannot bypass new cooldown')
    callbacks.slice(oldCallbacks.length).find(c=>c.ms===900).fn()
    assert.equal(h.store.getSnapshot('new').armed,true,'new arm still works')
  }
  callbacks.at(-1).fn();assert.equal(h.store.getSnapshot('new').phase,'idle','current expiry still works')
  unsub();h.dispose();repairChecks++;console.log('PASS REPAIR F3: '+phase+' ignores old lifecycle timers; current timers still work')
}
for(const kind of ['cookie','countdown','warn'])for(const stuck of ['transport','body']){
  let wrote=false
  const health={backup:false,warn:!wrote,limitBytes:16384,last:null}
  const h=makeHarness((_url,options)=>{
    if(options.method==='POST'){
      wrote=true
      return stuck==='transport'?new Promise(()=>{}):Promise.resolve({ok:true,json:()=>new Promise(()=>{})})
    }
    return Promise.resolve(reply(200,statusBody('off',{authCookie:{...health,backup:wrote},countdownSeconds:wrote?12:5,warnExpireSeconds:wrote?20:15})))
  })
  const section=h.render(h.settingsComponent)
  const component=kind==='cookie'?h.authCookieComponent:walk(section.tree,n=>n.type?.name===(kind==='countdown'?'CountdownRow':'WarnExpireRow')).type
  const ui=h.render(component);await flush()
  let tree=h.render(component,ui.hook).tree
  const control=buttons(tree).find(b=>b.props.onClick)
  assert.equal(control.props.disabled,false);control.props.onClick();await flush()
  h.fireTimer(10000);await flush()
  tree=h.render(component,ui.hook).tree
  assert.equal(buttons(tree).find(b=>b.props.onClick).props.disabled,false,'timeout releases busy state after bounded read-back')
  assert.match(textContent(tree),/Save outcome is unconfirmed/)
  if(kind==='cookie') assert.equal(walk(tree,n=>n.type==='input' && /back.?up/i.test(n.props['aria-label']??'')).props.checked,true)
  else assert.equal(walk(tree,n=>n.type==='input'&&n.props.type==='number').props.value,kind==='countdown'?'12':'20','lost POST response uses server value rather than false rollback')
  h.unmount(ui.hook);h.dispose();repairChecks++;console.log('PASS REPAIR F4: '+kind+' '+stuck+' timeout releases control and reads actual persisted setting')
}
{
  let wrote=false
  const h=makeHarness((_url,options)=>{
    if(wrote)return new Promise(()=>{})
    if(options.method==='POST'){wrote=true;return new Promise(()=>{})}
    return Promise.resolve(reply(200,statusBody('off',{authCookie:{backup:false,warn:true,limitBytes:16384,last:null}})))
  })
  const ui=h.render(h.authCookieComponent);await flush()
  buttons(h.render(h.authCookieComponent,ui.hook).tree).find(b=>b.props.onClick).props.onClick()
  await flush();h.fireTimer(10000);await flush();h.fireTimer(10000);await flush()
  const tree=h.render(h.authCookieComponent,ui.hook).tree
  assert.equal(buttons(tree).find(b=>b.props.onClick).props.disabled,false,'failed reconciliation still allows a retry')
  assert.match(textContent(tree),/Save outcome is unconfirmed/)
  h.unmount(ui.hook);h.dispose();repairChecks++;console.log('PASS REPAIR F4: write and read-back both time out; unknown result shown, no permanent disabled state')
}
console.log('repair client checks passed: '+repairChecks)

