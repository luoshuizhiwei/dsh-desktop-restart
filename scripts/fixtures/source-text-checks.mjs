import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const ledger=JSON.parse(readFileSync(new URL('./source-text-checks.json',import.meta.url),'utf8'))
const checked=new Set()
function check(method,id,value,pattern,message){
  assert.ok(ledger.some(entry=>entry.id===id&&entry.method===method),'text check must have a documented reason')
  checked.add(id)
  assert[method](value,pattern,message)
}
export const sourceTextChecks={
  ok:(...args)=>check('ok',...args),
  match:(...args)=>check('match',...args),
  doesNotMatch:(...args)=>check('doesNotMatch',...args),
  count:(regexOnly=false)=>regexOnly?ledger.filter(entry=>checked.has(entry.id)&&entry.method!=='ok').length:checked.size,
}
