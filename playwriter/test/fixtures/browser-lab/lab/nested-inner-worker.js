// Worker started by nested-outer-worker.js: reports a file it cannot read.
self.onmessage = (event) => {
  console.error(`resize worker: cannot decode ${event.data}`)
  postMessage('Resize failed')
}
