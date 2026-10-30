import assert from 'node:assert/strict'
import {makeHarness,reply,flush,statusBody} from './fixtures/client-harness.mjs'
import {accountMenuDOM} from './fixtures/account-menu-dom.mjs'
export let menuFirstOpen2Checks=0
{
  const dom=accountMenuDOM()
  dom.document.body.appendChild(dom.menu)
  let deliveries=0
  const observer=new dom.MutationObserver(()=>{deliveries++})
  observer.observe(dom.document.body,{childList:true})
  await flush();assert.equal(deliveries,0,'late observer cannot receive historical mutations')
  dom.document.body.appendChild(dom.backing)
  await flush();assert.equal(deliveries,1,'future mutation is delivered')
  observer.disconnect();menuFirstOpen2Checks++
  console.log('PASS MENU2 fixture: records assigned when mutation occurs, not at delivery')
}
{
  let extraRequests=0
  const dom=accountMenuDOM()
  const h=makeHarness(async(url)=>{if(url.includes('menuTrace='))extraRequests++;return reply(200,statusBody())},{dom})
  await flush()
  // Real trace 1793344385372-1: menu and items committed before document click.
  dom.open()
  assert.equal(dom.injected().length,1,'already committed menu must inject in the click callback, without waiting for any new body mutation')
  const button=dom.injected()[0]
  assert.equal(dom.viewport.firstElementChild,button);assert.equal(button.parentElement,dom.viewport)
  assert.equal(button.style.visibility,'hidden')
  h.fireFrame();assert.equal(button.style.visibility,'visible')
  await flush();assert.equal(extraRequests,0,'disabled trace creates no extra requests')
  assert.ok(!h.timerDelays().includes(500),'successful immediate injection ends discovery')
  dom.close();await flush();assert.equal(dom.injected().length,0);assert.equal(dom.observations().length,0)
  h.dispose();menuFirstOpen2Checks++
  console.log('PASS MENU2 real order: precommitted menu injects synchronously, first in viewport, hidden then visible, clean close, no diagnostic traffic by default')
}
for(const enabled of [true,false]){
  const uploads=[]
  const dom=accountMenuDOM('backing-first')
  const h=makeHarness(async(url)=>{
    if(url.includes('menuTrace='))uploads.push(JSON.parse(new URL(url,'http://fixture').searchParams.get('menuTrace')))
    return reply(200,statusBody('off',{menuTraceEnabled:enabled}))
  },{dom})
  await flush();dom.clickTrigger();dom.trigger.setAttribute('aria-expanded','true')
  dom.document.body.appendChild(dom.backing);await flush()
  assert.equal(dom.injected().length,0)
  dom.document.body.appendChild(dom.menu);await flush();assert.equal(dom.injected().length,1)
  h.fireFrame();await flush()
  if(enabled){
    const events=uploads.flatMap(item=>item.events)
    assert.ok(events.some(e=>e.type==='body'&&e.bodyRecords>0))
    assert.ok(events.some(e=>e.outcome==='visible'&&e.injected&&e.first))
    assert.ok(uploads.every(item=>encodeURIComponent(JSON.stringify(item)).length<=1750))
  }else assert.equal(uploads.length,0)
  h.dispose();menuFirstOpen2Checks++
  console.log('PASS MENU2 delayed order and trace opt-in='+enabled+': late menu handled, bounded diagnostic chunks only when enabled')
}
