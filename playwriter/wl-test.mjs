import { spawn, execSync } from 'node:child_process'
import WebSocket from 'ws'
const CHROMIUM='/home/secemp9/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'
const EXT='/home/secemp9/ast_browser/playwriter/extension/dist-wl'
const PORT=9380, PROFILE='/tmp/pw-wl'
execSync(`rm -rf ${PROFILE}`)

// Pass 1: discover the path-derived extension ID (no flag yet)
function launch(extraArgs) {
  return spawn(CHROMIUM, [`--user-data-dir=${PROFILE}`,`--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,`--disable-extensions-except=${EXT}`,
    '--no-first-run','--no-default-browser-check',...extraArgs,'about:blank'], {stdio:'ignore'})
}
const list=()=>{try{return JSON.parse(execSync(`curl -s --max-time 2 http://127.0.0.1:${PORT}/json/list`).toString())}catch{return[]}}
const sw=()=>list().find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension'))

let child = launch([])
let found=null
for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,1000)); found=sw(); if(found) break}
if(!found){console.log('no SW'); child.kill('SIGKILL'); process.exit(0)}
const extId = found.url.split('/')[2]
console.log('extension id:', extId)
child.kill('SIGKILL')
await new Promise(r=>setTimeout(r,2500))

// Pass 2: relaunch WITH --whitelisted-extension-id and try tabCapture with NO click
execSync(`rm -rf ${PROFILE}`)
child = launch([`--whitelisted-extension-id=${extId}`])
found=null
for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,1000)); found=sw(); if(found) break}
if(!found){console.log('no SW on pass 2'); child.kill('SIGKILL'); process.exit(0)}
const ws=new WebSocket(found.webSocketDebuggerUrl)
await new Promise(r=>ws.on('open',r))
const out=await new Promise(res=>{
  ws.on('message',raw=>{const m=JSON.parse(raw.toString()); if(m.id===1) res(m)})
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
    expression:`new Promise(async resolve=>{
      const tabs = await chrome.tabs.query({active:true,currentWindow:true});
      chrome.tabCapture.getMediaStreamId({targetTabId:tabs[0].id},(id)=>{
        resolve(JSON.stringify({ok:!!id, err: chrome.runtime.lastError && chrome.runtime.lastError.message}))
      })
    })`, awaitPromise:true, returnByValue:true}}))
})
console.log('tabCapture WITH --whitelisted-extension-id, no click:', out.result?.result?.value)
ws.close(); child.kill('SIGKILL')
