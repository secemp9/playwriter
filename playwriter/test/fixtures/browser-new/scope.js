// How this scope presents the browser: loaded by identity.html (page), and as a dedicated, shared and
// service worker. Everything here only reads.
async function describeScope() {
  const data = navigator.userAgentData
  const highEntropy = data
    ? await data.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64'])
    : null
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    language: navigator.language,
    languages: navigator.languages,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    modelContext: 'modelContext' in navigator,
    highEntropy,
  }
}

// Fetches a URL from this scope and says whether it answered (for allowedDomains).
async function tryFetch(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return `status ${response.status}`
  } catch (error) {
    return `failed: ${error.message}`
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const answer = async (data) => ({ scope: await describeScope(), fetched: data && data.fetch ? await tryFetch(data.fetch) : null })
  if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) {
    self.onconnect = (event) => {
      const port = event.ports[0]
      port.onmessage = async (message) => port.postMessage(await answer(message.data))
    }
  } else if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
    self.addEventListener('install', () => self.skipWaiting())
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
    self.addEventListener('message', async (message) => message.source.postMessage(await answer(message.data)))
  } else {
    self.onmessage = async (message) => self.postMessage(await answer(message.data))
  }
}
