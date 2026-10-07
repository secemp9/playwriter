// Dedicated worker for worker-errors.html: reports a bad row, then crashes; the page keeps it running.
self.onmessage = (event) => {
  console.error(`import worker: bad row 7 in ${event.data}`)
  postMessage('Import failed')
  throw new Error('import worker crashed on row 7')
}
