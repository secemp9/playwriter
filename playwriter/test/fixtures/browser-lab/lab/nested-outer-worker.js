// Dedicated worker for nested-worker.html: hands each job to a worker of its own and passes back its answer.
const inner = new Worker('/lab/nested-inner-worker.js')
inner.onmessage = (event) => postMessage(event.data)
self.onmessage = (event) => inner.postMessage(event.data)
