// Dedicated worker for worker-startup.html: fails as its script first runs.
console.error('sync worker: no server configured')
throw new Error('sync worker could not start')
