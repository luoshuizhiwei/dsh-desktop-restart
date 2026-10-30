import assert from 'node:assert/strict'
import { makeHarness, reply, flush, statusBody, textContent } from './fixtures/client-harness.mjs'

export async function forceContract(source) {
  const clock={now:1800000000000}, posts=[]
  const h=makeHarness(async(url,options)=>{
    if(options.method==='POST'){posts.push(new URL(url,'http://local'));return reply(200,{ok:true})}
    return reply(200,statusBody('off',{guard:{active:true,tasks:{known:true,active:true,turns:1,queued:0,jobs:0},installs:{running:false}}}))
  },{clock,source,timer:true})
  const mount=h.render(h.panelComponent),view=null,off=()=>h.unmount(mount.hook)
  try {
    await flush();h.store.getSnapshot(view).press()
    assert.equal(h.store.getSnapshot(view).phase,'warn')
    h.store.getSnapshot(view).press();await flush();assert.equal(posts.length,0,'cooldown refuses a double click')
    clock.now+=2000;h.fireTimer(900)
    h.store.getSnapshot(view).press();await flush()
    assert.equal(posts.length,1)
    assert.equal(posts[0].searchParams.get('force'),'1')
    assert.equal(posts[0].searchParams.get('now'),'1','executed request must contain now=1')
  } finally {off();h.dispose()}
}

export async function waitCancelContract() {
  const clock={now:1800000000000},posts=[]
  let request=null
  const h=makeHarness(async(url,options)=>{
    if(options.method==='POST'){
      const params=new URL(url,'http://local').searchParams;posts.push(params)
      if(params.get('cancelWait')==='1'){request={state:'terminal',reason:'cancelled',executed:false};return reply(200,{ok:true,cancelled:true,restartRequest:request})}
      request={state:'waiting',deadlineAt:new Date(clock.now+1800000).toISOString()}
      return reply(202,{ok:true,waiting:true,restartRequest:request})
    }
    return reply(200,statusBody('off',{restartRequest:request}))
  },{clock})
  const mount=h.render(h.headerComponent)
  try {
    await flush()
    h.store.getSnapshot(null).waitForIdle();await flush()
    assert.equal(posts[0].get('wait'),'1');assert.equal(h.store.getSnapshot(null).request.state,'waiting')
    request={state:'countdown',countdownUntil:new Date(clock.now+5000).toISOString(),countdownRemainingMs:5000,deadlineAt:new Date(clock.now+1800000).toISOString()}
    h.store.getSnapshot(null).refresh();await flush()
    assert.match(textContent(h.render(h.headerComponent,mount.hook).tree),/5s/)
    clock.now+=2000
    assert.match(textContent(h.render(h.headerComponent,mount.hook).tree),/3s/)
    h.store.getSnapshot(null).press();await flush();assert.equal(posts.length,1,'countdown locks normal submit')
    h.store.getSnapshot(null).cancelWait();await flush()
    assert.equal(posts[1].get('cancelWait'),'1');assert.equal(h.store.getSnapshot(null).request.executed,false)
    for(let i=0;i<2;i++){h.store.getSnapshot(null).refresh();await flush();assert.equal(h.store.getSnapshot(null).request.reason,'cancelled','GET does not consume the result')}
  } finally {h.unmount(mount.hook);h.dispose()}
}

export async function rollbackContract() {
  let fail=true,posts=0
  const h=makeHarness(async(_url,options)=>{
    if(options.method==='POST'){posts++;return reply(fail?503:200,fail?{ok:false,error:'isolated write failure'}:{ok:true})}
    return reply(200,statusBody())
  })
  const view=h.store.newViewId(),off=h.store.subscribe(()=>{},view,false)
  try {
    await flush();h.store.getSnapshot(view).press();assert.equal(posts,0)
    h.store.getSnapshot(view).press();await flush()
    assert.equal(h.store.getSnapshot(view).phase,'error');assert.equal(h.store.getSnapshot(view).opBusy,false)
    assert.match(h.store.getSnapshot(view).message,/isolated write failure/)
    fail=false;h.store.getSnapshot(view).press();await flush();assert.equal(posts,2)
    assert.notEqual(h.store.getSnapshot(view).phase,'error')
  } finally {off();h.dispose()}
}

