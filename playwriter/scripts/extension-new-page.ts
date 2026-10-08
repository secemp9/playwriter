import playwright from 'playwright-core'

async function main() {
  const cdpEndpoint = `ws://localhost:19988/cdp/${Date.now()}`
  const browser = await playwright.chromium.connectOverCDP(cdpEndpoint)

  const contexts = browser.contexts()
  console.log(`Found ${contexts.length} browser context(s)`)

  // No wait: the relay announces every page (Target.attachedToTarget) before it answers the
  // connect's Target.setAutoAttach, and connectOverCDP resolves once those pages are initialized
  // (playwright-core crBrowser.ts connect → _waitForAllPagesToBeInitialized).
  for (const context of contexts) {
    const pages = context.pages()
    console.log(`Context has ${pages.length} page(s):`)
    // Create a new page
    const newPage = await context.newPage()
    // Evaluate a sum (e.g., 2 + 3) and log the result
    const sumResult = await newPage.evaluate(() => 2 + 3)
    console.log(`Evaluated sum 2 + 3 = ${sumResult}`)

    // A duration that is the demo itself (e): the new tab stays up 1 s for the person watching it.
    const shown = Promise.withResolvers<void>()
    setTimeout(shown.resolve, 1000)
    await shown.promise
    // Close the page
    await newPage.close()
  }
}

main()
