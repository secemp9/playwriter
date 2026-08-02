/**
 * Reachability + fidelity oracle for the `execute()` sandbox.
 *
 * The failure mode this exists to catch: a capability is built, unit-tested and
 * documented, but never wired into the sandbox globals — so it is uncallable, and
 * nothing notices. Three whole lanes shipped that way once.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. This file used to carry `EXPECTED_FUNCTIONS` and
 * `EXPECTED_NAMESPACES` as literal arrays. That is a snapshot, not an oracle: it is only
 * ever as correct as the last person who remembered to edit it, and an audit found it
 * silently missing `recording.hold`, the entire `humanMouse` namespace, `chrome`,
 * `browser`, and every wrapper OPTION except two. The expected surface is now DERIVED
 * from the shipped documentation — `src/skill.md` (from which `dist/prompt.md` is
 * generated) plus the `*-examples.ts` files compiled into the MCP resources — by parsing
 * their code and reading the calls back out. Document a helper with an example and it is
 * expected here automatically; there is no list to forget.
 *
 * Both directions are checked. Documented-but-unreachable fails. Reachable-but-
 * undocumented ALSO fails, with an explicit `UNDOCUMENTED_BY_DESIGN` opt-out that costs
 * one written sentence — a warning would be invisible in CI, and "reachable capability
 * nobody wrote down" is exactly the state the audit found and the reason for this file.
 *
 * And options, not just names: the `scope`-class bug is invisible to a name check,
 * because the global exists, is callable, and quietly discards an option the docs
 * promise. `sandbox-api-oracle.ts` resolves each sandbox name to the function that
 * implements it and reports which options that function actually observes.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { PlaywrightExecutor } from './executor.js'
import {
  extractDocumentedApi,
  sandboxSurfaceExpressions,
  analyseWrapperOptions,
  observedOptionsOf,
  type DocumentedApi,
} from './sandbox-api-oracle.js'
import { splitSkillOnCliSection } from './strip-cli-sections.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTOR_FILE = path.join(PACKAGE_ROOT, 'src', 'executor.ts')
const PROMPT_MD = path.join(PACKAGE_ROOT, 'dist', 'prompt.md')

/** A Page stand-in. Only the members the sandbox constructor itself touches are real. */
function stubPage(): any {
  const page: any = {
    on: () => page,
    off: () => page,
    once: () => page,
    isClosed: () => false,
    url: () => 'https://example.test/',
    locator: (selector: string) => ({ selector: () => selector, page: () => page }),
    mainFrame: () => ({ frameId: () => 'FRAME1' }),
    frames: () => [],
    context: () => context,
    evaluate: async () => undefined,
  }
  const context: any = {
    on: () => context,
    pages: () => [page],
    getExistingCDPSession: async () => ({ send: async () => ({}), on: () => {}, off: () => {}, detach: async () => {} }),
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  }
  return { page, context }
}

function buildSandbox() {
  const executor = new PlaywrightExecutor({
    cdpConfig: { headless: true },
    logger: { log: () => {}, error: () => {} },
    cwd: process.cwd(),
  })
  const { page, context } = stubPage()
  const { vmContextObj } = executor.buildSandboxContext({ page, context, consoleLogs: [] })
  return { executor, vmContextObj, page, context }
}

// ---------------------------------------------------------------------------
// The oracle's inputs
// ---------------------------------------------------------------------------

/** Docs that ship. `dist/prompt.md` is `skill.md` minus the CLI section, so parsing
 *  skill.md covers it; the equivalence is asserted separately below. */
const DOC_MARKDOWN = ['src/skill.md']
/** Example files compiled verbatim into the `*-api.md` MCP resources by build-resources.ts. */
const DOC_EXAMPLES = [
  'src/page-model-examples.ts',
  'src/trace-examples.ts',
  'src/styles-examples.ts',
  'src/debugger-examples.ts',
  'src/editor-examples.ts',
  'src/performance-examples.ts',
]

const documented: DocumentedApi = extractDocumentedApi({
  root: PACKAGE_ROOT,
  markdownFiles: DOC_MARKDOWN,
  sourceFiles: DOC_EXAMPLES,
})
const surface = sandboxSurfaceExpressions(EXECUTOR_FILE)

/**
 * Roots whose members are somebody else's API.
 *
 * `page`, `context` and `browser` are Playwright objects. The docs are full of
 * `page.locator(…)` and `context.pages()`, and those are promises Playwright makes, not
 * promises this sandbox makes — checking them here would assert that our stub
 * reimplements Playwright.
 */
const NOT_OUR_NAMESPACE = new Set(['page', 'context', 'browser'])

/**
 * Sandbox names deliberately left out of the prose, each with the reason.
 *
 * The bar for an entry here is that documenting the name would make the docs WORSE —
 * a second spelling of something already documented, which is how two names drift into
 * meaning subtly different things. Anything else gets documented instead.
 */
const UNDOCUMENTED_BY_DESIGN: Record<string, string> = {
  accessibilitySnapshot: 'backward-compatible alias for `snapshot`; documenting both spellings invites them to drift apart',
  resizeImage: 'backward-compatible alias for `resizeImageForAgent`, named as an alias in the prose but never used in an example',
  startRecording: 'pre-namespace alias for `recording.start`',
  stopRecording: 'pre-namespace alias for `recording.stop`',
  isRecording: 'pre-namespace alias for `recording.isRecording`',
  cancelRecording: 'pre-namespace alias for `recording.cancel`',
}

/**
 * The Node built-ins spread in from `usefulGlobals`.
 *
 * Read out of `executor.ts` rather than restated, so this exclusion cannot go stale
 * either. They are documented as a CLASS ("Node.js globals: setTimeout, fetch, …"), not
 * one by one, and demanding a worked example for `TextDecoder` would be noise.
 */
const NODE_GLOBALS = new Set(
  (() => {
    const src = fs.readFileSync(EXECUTOR_FILE, 'utf8')
    const block = src.match(/const usefulGlobals = \{([\s\S]*?)\n\} as const/)
    if (!block) throw new Error('could not find the `usefulGlobals` literal in executor.ts')
    return [...block[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*),/gm)].map((m) => m[1])
  })(),
)

/** `JSON.stringify(…)` in a doc example is an ambient intrinsic of every realm, including
 *  the vm context — not a name this sandbox has to provide. */
function isAmbientIntrinsic(name: string): boolean {
  return !surface.has(name) && Object.prototype.hasOwnProperty.call(globalThis, name)
}

const documentedGlobals = [...documented.globals.keys()].filter((name) => !isAmbientIntrinsic(name))
const documentedNamespaces = [...documented.namespaces.entries()].filter(
  ([ns]) => !NOT_OUR_NAMESPACE.has(ns) && !isAmbientIntrinsic(ns),
)

// ---------------------------------------------------------------------------

describe('the doc parser itself works', () => {
  /**
   * A parser that quietly matches nothing turns the whole oracle into a no-op that
   * passes forever. These floors are deliberately far below the real numbers: they fire
   * when the extraction BREAKS, not when the docs are edited.
   */
  it('extracted a real API surface, not an empty one', () => {
    expect(documented.stats.sources).toBe(DOC_MARKDOWN.length + DOC_EXAMPLES.length)
    expect(documented.stats.snippets, 'no fenced code blocks were found in the docs').toBeGreaterThan(50)
    expect(documented.stats.parseFailures, 'a shipped doc example does not parse').toEqual([])
    expect(documented.stats.parsed).toBe(documented.stats.snippets)
    expect(documentedGlobals.length, 'the parser found almost no documented globals').toBeGreaterThan(25)
    expect(documentedNamespaces.length, 'the parser found almost no documented namespaces').toBeGreaterThan(3)
    const totalOptions =
      [...documented.globals.values()].reduce((n, s) => n + s.size, 0) +
      documentedNamespaces.reduce((n, [, members]) => n + [...members.values()].reduce((m, s) => m + s.size, 0), 0)
    expect(totalOptions, 'the parser found almost no documented options').toBeGreaterThan(80)
  })

  it('recognises the shapes it has to recognise', () => {
    // One canary per extraction shape. If a regex or an AST case rots, the floors above
    // may still pass on the remainder; these say exactly which shape stopped working.
    expect(documented.globals.has('snapshot'), 'bare-identifier calls in fenced blocks').toBe(true)
    expect(documented.namespaces.get('pm')?.has('query'), 'namespace calls in fenced blocks').toBe(true)
    expect(documented.namespaces.get('recording')?.has('startCdp'), 'namespace calls in fenced blocks').toBe(true)
    expect(documented.namespaces.get('humanMouse')?.has('moveTo'), 'the humanMouse lane').toBe(true)
    expect(documented.globals.get('getLatestLogs'), 'options from a `{ page?, count? }` signature sketch').toContain('sinceLastCall')
    expect(documented.globals.get('getStylesForLocator'), 'options from the examples files').toContain('includeUserAgentStyles')
    expect(documented.globals.has('document'), 'names inside page.evaluate() are the page realm, not ours').toBe(false)
  })

  it('no API is documented only inside the CLI section the MCP prompt strips', () => {
    // `dist/prompt.md` is `skill.md` with the `## CLI Usage` section removed, so an API
    // documented ONLY in there is invisible to every MCP agent. Computed from skill.md
    // itself rather than from the built artifact, so it can never pass on a stale dist/
    // nor fail merely because dist/ has not been rebuilt yet.
    //
    // The boundary comes from the SAME function the build calls. It used to be re-derived
    // here by cutting at the next `\n## `, which found a different boundary than the build
    // does — the build stops at any heading of depth <= 2, so the hand-rolled version also
    // discarded the `# playwriter best practices` h1 section that really does ship. It
    // happened to stay green, but a guard computing a different answer than the thing it
    // guards is only ever accidentally right.
    const skill = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'skill.md'), 'utf8')
    const withoutCli = splitSkillOnCliSection(skill).shipped
    const tmp = path.join(PACKAGE_ROOT, 'src', '.skill-without-cli.tmp.md')
    fs.writeFileSync(tmp, withoutCli)
    try {
      const survived = extractDocumentedApi({
        root: PACKAGE_ROOT,
        markdownFiles: ['src/.skill-without-cli.tmp.md'],
        sourceFiles: [],
      })
      const skillOnly = extractDocumentedApi({ root: PACKAGE_ROOT, markdownFiles: DOC_MARKDOWN, sourceFiles: [] })
      const lost = [...skillOnly.globals.keys()].filter((g) => !survived.globals.has(g) && !isAmbientIntrinsic(g))
      expect(lost, 'documented only under `## CLI Usage`, so the MCP prompt never carries it').toEqual([])
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('the built MCP prompt really is the stripped skill.md', () => {
    // Weaker than the check above ON PURPOSE: dist/ is a build artifact and may lag an
    // uncommitted skill.md edit. What cannot lag is the SHAPE — the strip either ran or
    // it did not, and a stale artifact can only ever be a subset, never a superset.
    if (!fs.existsSync(PROMPT_MD)) {
      throw new Error('dist/prompt.md is missing — run `pnpm build`. The MCP serves that file.')
    }
    const prompt = fs.readFileSync(PROMPT_MD, 'utf8')
    expect(prompt, 'the CLI section is still in the MCP prompt; build-resources.ts stopped stripping it').not.toContain(
      '\n## CLI Usage\n',
    )
    const fromPrompt = extractDocumentedApi({ root: PACKAGE_ROOT, markdownFiles: ['dist/prompt.md'], sourceFiles: [] })
    const skillOnly = extractDocumentedApi({ root: PACKAGE_ROOT, markdownFiles: DOC_MARKDOWN, sourceFiles: [] })
    const invented = [...fromPrompt.globals.keys()].filter((g) => !skillOnly.globals.has(g))
    expect(invented, 'the MCP prompt documents something skill.md does not — it is no longer generated from it').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The strip, and what it strands
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS, AND WHY THE CHECK ABOVE WAS NOT ENOUGH.
 *
 * The check above asks whether any API NAME is documented only inside the stripped
 * `## CLI Usage` section. That is a real question, but it is the wrong grain, and an audit
 * proved it: `recording.startCdp` is documented in several places OUTSIDE the CLI section,
 * so nothing was ever "lost" by that measure — yet the one sentence saying it is the
 * recorder that survives direct-CDP mode sat inside the stripped section, and no MCP agent
 * could read it. Nothing was missing. Something correct was simply unreachable.
 *
 * Three more facts sat there the same way, each appearing exactly once in `skill.md` and
 * zero times in `dist/prompt.md`: `PLAYWRITER_HOST` (honoured in MCP mode by
 * `getRemoteConfig` in `mcp.ts`, so MCP-over-tunnel is a real deployment), the
 * `~/.playwriter/relay-server.log` triage route, and `gh issue create -R remorses/playwriter`.
 *
 * So this guard drops below the level of "API name" to the level of VOCABULARY. It pulls
 * every hard token out of the stripped section — env vars, file paths, long flags, shell
 * command heads, and backticked spans — and asks the blunt question the name check never
 * asked: does this string appear ANYWHERE in the text that ships? A token that does not is
 * either genuinely CLI-only, in which case it is listed below with a written reason, or it
 * is stranded and has to be moved or duplicated into the shipped text.
 *
 * WHAT IT CATCHES: stranded vocabulary. Any env var, path, flag, command or backticked
 * identifier whose only occurrence in the whole file is inside the stripped section.
 *
 * WHAT IT DOES NOT CATCH, stated plainly because an overclaimed guard is worse than none —
 * that is the lesson of the name-level check it supplements:
 *
 *   1. A stranded CLAIM built entirely from vocabulary used elsewhere. The
 *      `recording.startCdp` sentence that motivated this file is exactly that shape: every
 *      token in it appears in the shipped text, so this guard would NOT have flagged it.
 *      (It is un-stranded today, by duplication, but by hand — not by this check.)
 *   2. Prose with no hard token at all — an ordering constraint, a caveat, a "prefer X to Y".
 *   3. A token that appears in the shipped text in an unrelated or contradictory sense.
 *      This is string containment, not meaning.
 *   4. The reverse leak: CLI-only prose that ships. This guard runs one way only — it asks
 *      whether a stripped token is unreachable, never whether a shipped one is useless.
 *      When it was written `dist/prompt.md` still carried `playwriter -s 1 -e` examples
 *      under "common mistakes" and nothing here objected; those are gone now, removed by
 *      hand, and nothing here would object if they came back. Worse, the leak had been
 *      *suppressing* this guard: the deleted heredoc example was the only shipped
 *      occurrence of `<<'EOF'` and `'EOF'`, so those tokens read as reachable until it
 *      went. A reverse leak keeps this check green on precisely the vocabulary it leaks.
 *      The mirror check is not built, deliberately — see the note below.
 *
 * It is a lexical net with a stated mesh size. It would have caught three of the four
 * stranded items, which is three more than the name check caught.
 *
 * WHY THERE IS NO MIRROR OF THIS CHECK. The obvious symmetry — flag every hard token in
 * the SHIPPED half that looks like argv — does not survive contact with the file. The
 * shipped half legitimately contains `--profile-directory`, `--remote-debugging-port` and
 * `--allowlisted-extension-id` (how you start the user's Chrome), `gh issue create
 * -R remorses/playwriter --title` (how you file the bug), a `jq` pipeline over
 * `~/.playwriter/cdp.jsonl`, and the word `playwriter` in almost every section. Every one
 * of those is a shell string an agent with a Bash tool should absolutely read. What makes
 * `playwriter -s 1 -e` different is not its shape but its SUBJECT: it drives the CLI the
 * agent is not using. No lexical rule separates those two sets, and a check that fires on
 * `--profile-directory` would be trained away inside a week — which is exactly how the
 * name-level check above stopped catching anything. The honest guard here is a periodic
 * read of the shipped half, not a regex.
 */
const CLI_ONLY_BY_DESIGN: Record<string, string> = {
  // --- headless and cloud: genuinely unreachable from MCP, so not "lost" ---
  // There is no PLAYWRITER_BROWSER env var and mcp.ts has no headless or cloud branch —
  // `getOrCreateExecutor` resolves to direct CDP, remote relay, or local relay and nothing
  // else. An MCP session cannot enter either mode, so documenting them would be dead text.
  '--browser': 'selects headless/cloud, which an MCP session has no way to enter (no PLAYWRITER_BROWSER env var)',
  'playwriter session new --browser headless': 'headless mode is CLI-only; MCP has no branch that reaches it',
  'playwriter browser install': 'downloads Chrome for Testing for headless mode, which MCP cannot enter',
  'playwriter browser start': 'launches a debugging-enabled Chrome; the MCP equivalent is pointing PLAYWRITER_DIRECT at one',
  '--proxy': 'cloud-browser residential proxy region, and cloud mode is unreachable from MCP',
  '--proxy <region>': 'cloud-browser residential proxy region, and cloud mode is unreachable from MCP',
  '--custom-proxy': 'cloud-browser option, and cloud mode is unreachable from MCP',
  '--disable-proxy-bandwidth-acceleration': 'cloud-browser option, and cloud mode is unreachable from MCP',
  PLAYWRITER_API_KEY: 'authenticates cloud browsers, which an MCP session cannot start',
  'navigator.webdriver': 'names a stealth patch cloud Chromium applies; cloud is unreachable from MCP',

  // --- the CLI's own surface: an MCP agent drives `execute`, not argv ---
  'playwriter session new': 'the MCP server owns session lifecycle; an agent never runs this',
  '-s <id>': 'the CLI session flag; MCP sessions are not addressed by argv',
  '--direct': 'the CLI spelling of PLAYWRITER_DIRECT, which is documented in the shipped text',
  '--token': 'the CLI spelling of PLAYWRITER_TOKEN, which is documented in the shipped text',
  '--timeout':
    'the CLI spelling of the `timeout` parameter on the MCP `execute` tool. The agent sees that parameter in the tool schema, and the shipped createDemoVideo note now names the key outright — `timeout: 120000` — so naming a flag it cannot pass would only mislead it',
  '--timeout 120000':
    'the same flag with the createDemoVideo value; the shipped text gives that value as `timeout: 120000` against the 10000ms default, without the argv spelling',
  npm: 'global install of the CLI',
  bunx: 'runs the CLI without installing it',
  export: 'shell syntax for setting the env vars; an MCP client sets them in its own config block',
  MY_SECRET_TOKEN: 'placeholder value in the `playwriter serve` example, not an identifier',
  '//traforo.dev': 'the tunnel the HOST machine runs; the agent only ever sees the resulting URL in PLAYWRITER_HOST',
  'chrome://inspect/#remote-debugging':
    'a human action in a browser UI, and mcp.ts:124 already puts this exact string in the error an MCP agent gets when PLAYWRITER_DIRECT finds no Chrome',

  // --- bash quoting: about argv, and there is no argv in MCP ---
  //
  // These were reachable from the shipped half until the "Quote escaping in bash"
  // block was deleted from `## common mistakes to avoid` — a leak in the OTHER direction,
  // fourteen lines of argv advice riding in every agent's context. Their entries only had
  // to be written once that leak was closed, which is worth noticing: a reverse leak keeps
  // this guard green on exactly the vocabulary it is leaking.
  //
  // `\t`, the other escape named in that quoting sentence, is deliberately NOT here: the shipped
  // half's `jq -r '.direction + "\t" + …'` triage pipeline contains that exact string, so the
  // token check already reads it as reachable and an entry for it would excuse nothing. That
  // it is reachable in a completely unrelated sense is caveat 3 above, not something an
  // allowlist entry can fix — and the liveness test below now refuses entries like it.
  "$'...'": 'a bash quoting form; MCP code is passed as a JSON string with no shell in between',
  "<<'EOF'": 'the bash heredoc opener; there is no shell between an MCP agent and `execute`, so nothing to quote against',
  "'EOF'": 'the quoted heredoc delimiter, and quoting it is what disables bash expansion — a bash-only concern',
  "\\'": 'bash escaping inside $\'...\'',
  '\\\\': 'bash escaping inside $\'...\'',
}

/**
 * Hard tokens: strings specific enough that appearing in one half of the file and not the
 * other is evidence, rather than coincidence. Deliberately NOT bare English words.
 */
function hardTokens(text: string): Map<string, string> {
  const found = new Map<string, string>()
  const add = (token: string, kind: string) => {
    if (!found.has(token)) found.set(token, kind)
  }

  // SCREAMING_SNAKE_CASE — env vars and placeholder values.
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) add(m[0], 'env var')
  // Absolute, home-relative and protocol-relative paths that carry an extension or a host.
  for (const m of text.matchAll(/(?:~|\.)?\/[\w.\-/]*\.\w{2,6}\b/g)) add(m[0], 'path')
  // Long CLI flags.
  for (const m of text.matchAll(/(?<![\w-])--[a-z][a-z0-9-]{2,}\b/g)) add(m[0], 'flag')
  // The command each line of a shell fence actually runs.
  for (const fence of text.matchAll(/^[ \t]*```(\w*)[ \t]*\n([\s\S]*?)^[ \t]*```/gm)) {
    if (fence[1] !== 'bash' && fence[1] !== 'sh' && fence[1] !== 'shell') continue
    for (const line of fence[2].split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const head = trimmed.match(/^([a-z][\w.-]*)\b/)
      if (head) add(head[1], 'shell command')
    }
  }
  // Backticked spans — the identifiers, commands and invocations the prose points at.
  // Capped at 100 chars so a whole sentence in backticks does not become one token.
  for (const m of text.matchAll(/`([^`\n]{2,100})`/g)) add(m[1], 'code span')

  return found
}

describe('the CLI strip does not strand MCP-relevant facts', () => {
  const skill = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'skill.md'), 'utf8')
  const { shipped, stripped } = splitSkillOnCliSection(skill)

  it('splits skill.md where the build splits it', () => {
    // The floors that make the token check below meaningful. A split that produced an
    // empty stripped half would report zero stranded tokens forever — green, and checking
    // nothing. This is the `splitBands` failure mode, so it gets an explicit floor.
    expect(stripped, 'the stripped half does not start at the CLI heading').toContain('## CLI Usage')
    expect(stripped.length, 'the stripped CLI section is implausibly small — is the split still working?').toBeGreaterThan(2000)
    expect(shipped.length, 'the shipped half is implausibly small — the strip ran off the end').toBeGreaterThan(
      skill.length * 0.5,
    )
    expect(shipped, 'the CLI section survived the split').not.toContain('\n## CLI Usage\n')
  })

  it('refuses to strip nothing when the heading is renamed', () => {
    // Fragility #1. The strip matched `heading.text === 'CLI Usage'` exactly and did
    // nothing at all when it did not match — so renaming the heading would have shipped
    // the whole CLI section into every agent's context, silently. Nothing anywhere said
    // "the strip found no section". Now it throws, and the build fails loudly.
    const renamed = skill.replace('## CLI Usage\n', '## Using the CLI\n')
    expect(renamed, 'the heading this test rewrites is no longer in skill.md').not.toEqual(skill)
    expect(() => splitSkillOnCliSection(renamed)).toThrow(/no "## CLI Usage" heading/)
  })

  it('refuses to strip the whole document when the section never terminates', () => {
    // Fragility #1's twin: stripping too much is as silent as stripping too little. With
    // no heading of depth <= 2 left after it, the section runs to EOF and prompt.md
    // becomes a valid, almost content-free document that nothing downstream can question.
    const start = skill.indexOf('## CLI Usage')
    const runaway = skill.slice(0, start) + skill.slice(start).replace(/^(#{1,2}) (?!CLI Usage)/gm, '#### ')
    expect(() => splitSkillOnCliSection(runaway)).toThrow(/removed .* of skill\.md/)
  })

  it('the token check is sensitive — a swallowed section makes it fire', () => {
    // The ceiling above only sees a TOTAL runaway. The realistic accident is smaller and
    // just as damaging: demote the heading that terminates the CLI section and the strip
    // quietly swallows the section after it — here `# playwriter best practices`, the
    // opening ~60 lines of the agent's own instructions — then stops at the next h2,
    // landing around 12% of the file. That is under any ceiling loose enough to let CLI
    // docs grow, and no structural rule separates an absorbed h3 from a real
    // `### Session management`. The token check is the thing that catches it.
    //
    // This test exists because a guard nobody has watched fail proves nothing. It pins the
    // SENSITIVITY, not the content: if someone weakens `hardTokens` into a no-op, the
    // stranding check above would still pass on a healthy file and only this would notice.
    const demoted = skill.replace('\n# playwriter best practices\n', '\n### playwriter best practices\n')
    expect(demoted, 'the heading this test demotes is no longer in skill.md').not.toEqual(skill)
    const bad = splitSkillOnCliSection(demoted)
    const swallowed = [...hardTokens(bad.stripped)]
      .filter(([token]) => !bad.shipped.includes(token))
      .filter(([token]) => !(token in CLI_ONLY_BY_DESIGN))
    expect(swallowed.length, 'a whole section was absorbed into the strip and the token check said nothing').toBeGreaterThan(
      10,
    )
  })

  it('the allowlist is live — every entry excuses a token that is really stranded', () => {
    // An allowlist that outlives the text it excuses is how a check quietly stops
    // checking. There are TWO ways an entry can stop excusing anything, and asking only
    // the first question let two of twenty-nine entries sit here inert:
    //
    //   1. the token is no longer produced by the split at all — a stale excuse, or a typo
    //      that never matched;
    //   2. the token IS in the stripped half, but it also appears in the SHIPPED half, so
    //      the stranding check below would have skipped it anyway. The entry reads as the
    //      reason a fact is unreachable when the fact is perfectly reachable.
    //
    // Both are inert, and inert entries are worse than absent ones: each is a written
    // sentence asserting that MCP agents cannot reach something they can, and the next
    // reader has no way to tell an excuse that is load-bearing from one that is decoration.
    // `playwriter serve` and `\t` were exactly this, and removing them cost nothing —
    // `playwriter serve` is named in the shipped remote-relay paragraph, and `\t` sits in
    // the shipped `jq` triage pipeline.
    //
    // The direction matters: an entry is needed when the token appears in the stripped half
    // and NOWHERE in the shipped half. Anything else and the entry is excusing a strand
    // that does not exist.
    const inStripped = hardTokens(stripped)

    const stale = Object.keys(CLI_ONLY_BY_DESIGN).filter((token) => !inStripped.has(token))
    expect(stale, 'listed as CLI-only but no longer a token of the stripped section — delete these entries').toEqual([])

    const notStranded = Object.keys(CLI_ONLY_BY_DESIGN).filter((token) => shipped.includes(token))
    expect(
      notStranded,
      'listed as CLI-only, but the shipped half contains this exact string — the stranding check never ' +
        'consults these entries, so each is an excuse for a strand that does not exist. Delete them. If the ' +
        'shipped occurrence is in an unrelated sense, that is caveat 3 on this guard and still not something ' +
        'an allowlist entry fixes.',
    ).toEqual([])
  })

  it('no hard token is reachable only from the stripped CLI section', () => {
    const inStripped = hardTokens(stripped)
    const stranded = [...inStripped]
      .filter(([token]) => !shipped.includes(token))
      .filter(([token]) => !(token in CLI_ONLY_BY_DESIGN))
      .map(([token, kind]) => `${kind}: ${token}`)
      .sort()
    expect(
      stranded,
      'these appear ONLY in the `## CLI Usage` section, so dist/prompt.md never carries them and no MCP ' +
        'agent can read them. Either move/duplicate the fact into the shipped text, or add the token to ' +
        'CLI_ONLY_BY_DESIGN with a sentence saying why an MCP session can never reach it.',
    ).toEqual([])
  })

  it('what the build actually shipped carries those same tokens', () => {
    // The check above is computed from skill.md, so it cannot be fooled by a stale dist/.
    // This one closes the other half: that the artifact on disk really is that shipped text.
    // Weaker on purpose — dist/ may lag an uncommitted edit, so it only asserts the tokens
    // skill.md's OWN shipped half already contains.
    if (!fs.existsSync(PROMPT_MD)) {
      throw new Error('dist/prompt.md is missing — run `pnpm build`. The MCP serves that file.')
    }
    const prompt = fs.readFileSync(PROMPT_MD, 'utf8')
    const mustReach = ['PLAYWRITER_HOST', '~/.playwriter/relay-server.log', 'gh issue create -R remorses/playwriter']
    const absent = mustReach.filter((token) => shipped.includes(token) && !prompt.includes(token))
    expect(absent, 'skill.md un-stranded these but dist/prompt.md does not have them — run `pnpm build`').toEqual([])
  })
})

/**
 * The option analyser's own tests.
 *
 * It is the load-bearing half of this oracle, and its failure mode is silent: an
 * analyser that reported `transparent` for everything would pass every option check
 * forever while checking nothing. Each case below is a shape that really appears in
 * `executor.ts`, plus the one that used to defeat it.
 */
describe('the wrapper option analyser reads what it claims to read', () => {
  const analyse = (src: string) => {
    const ast = parse(`const f = ${src}`, { sourceType: 'module', plugins: ['typescript'] }) as any
    return observedOptionsOf(ast.program.body[0].declarations[0].init, 'inline')
  }

  it('names a destructuring parameter', () => {
    const w = analyse('({ a, b: renamed, c = 1 }) => [a, renamed, c]')
    expect([...w.observed].sort()).toEqual(['a', 'b', 'c'])
    expect(w.transparent).toBe(false)
  })

  it('names a body destructure, including the `opts || {}` form', () => {
    expect([...analyse('(o) => { const { a, b } = o; return [a, b] }').observed].sort()).toEqual(['a', 'b'])
    const w = analyse('(o) => { const { a } = o || {}; return a }')
    expect([...w.observed]).toEqual(['a'])
    expect(w.transparent, '`o || {}` is a destructure, not a forward').toBe(false)
  })

  it('names member reads, optional ones included', () => {
    const w = analyse('(o) => g({ x: o.a, y: o?.b })')
    expect([...w.observed].sort()).toEqual(['a', 'b'])
    expect(w.transparent).toBe(false)
  })

  it('reports a forward or a spread as transparent', () => {
    expect(analyse('(o) => g(o)').transparent).toBe(true)
    expect(analyse('(o) => g({ ...o, extra: 1 })').transparent).toBe(true)
    expect(analyse('({ a, ...rest }) => g(a, rest)').transparent).toBe(true)
  })

  it('does NOT treat a null-guard as a forward', () => {
    // One `if (!options)` used to mark the whole wrapper transparent, which exempted
    // every option it dropped from the check without saying so.
    const w = analyse('(o) => { if (!o) throw new Error("x"); return g(o.a) }')
    expect(w.transparent).toBe(false)
    expect([...w.observed]).toEqual(['a'])
    expect(analyse('(o) => { if (o === undefined) return null; return o.b }').transparent).toBe(false)
  })

  it('reads the option names a parameter type declares', () => {
    const w = analyse('(o: { a?: string; b?: number }) => o.a')
    expect([...w.declared!].sort()).toEqual(['a', 'b'])
    expect([...w.observed]).toEqual(['a'])
  })
})

describe('documented sandbox API is reachable', () => {
  const { vmContextObj } = buildSandbox()

  it.each(documentedGlobals)('%s is a callable sandbox global', (name) => {
    expect(vmContextObj[name], `${name} is documented but missing from the sandbox globals`).toBeDefined()
    expect(typeof vmContextObj[name], `${name} is documented as a call but is not callable`).toBe('function')
  })

  it.each(documentedNamespaces)('the %s namespace exposes every documented member', (ns, members) => {
    expect(vmContextObj[ns], `${ns} is documented but missing from the sandbox globals`).toBeDefined()
    for (const member of members.keys()) {
      expect(typeof vmContextObj[ns][member], `${ns}.${member} is documented but is not callable`).toBe('function')
    }
  })

  it('exposes state, page, context and the sandboxed require', () => {
    expect(vmContextObj.state).toBeTypeOf('object')
    expect(vmContextObj.page).toBeDefined()
    expect(vmContextObj.context).toBeDefined()
    expect(typeof vmContextObj.require).toBe('function')
  })

  it('does NOT expose the live PageModel builder — only the pm projections', () => {
    // buildPageModel returns the whole node tree + byKey index. `pm.*` exists so sandbox
    // code can only ever get bounded, cycle-free projections out.
    expect(vmContextObj.buildPageModel).toBeUndefined()
  })
})

describe('reachable sandbox API is documented', () => {
  const { vmContextObj } = buildSandbox()

  it('every sandbox global is named somewhere in the docs', () => {
    const undocumented = [...surface.keys()].filter((name) => {
      if (NODE_GLOBALS.has(name)) return false
      if (UNDOCUMENTED_BY_DESIGN[name]) return false
      return !documented.mentions.has(name)
    })
    expect(
      undocumented,
      'these are reachable from execute() and appear nowhere in skill.md — document them, or add them to ' +
        'UNDOCUMENTED_BY_DESIGN with the reason',
    ).toEqual([])
  })

  it('every member of a documented namespace is itself documented', () => {
    const undocumented: string[] = []
    for (const [ns] of documentedNamespaces) {
      // `console` and `Buffer` exist in plain Node too: their members are Node's API, and
      // demanding skill.md name `console.groupCollapsed` would be noise, not coverage.
      if (Object.prototype.hasOwnProperty.call(globalThis, ns)) continue
      const value = vmContextObj[ns]
      if (!value || typeof value !== 'object') continue
      for (const member of Object.keys(value)) {
        if (typeof value[member] !== 'function' && typeof value[member] !== 'object') continue
        if (UNDOCUMENTED_BY_DESIGN[`${ns}.${member}`]) continue
        if (!documented.mentions.has(member)) undocumented.push(`${ns}.${member}`)
      }
    }
    expect(undocumented, 'reachable namespace members that appear nowhere in skill.md').toEqual([])
  })

  it('every UNDOCUMENTED_BY_DESIGN entry still exists', () => {
    // An opt-out for a name that was deleted is a stale exemption, and the next name to
    // land under it inherits an excuse nobody wrote for it.
    const dead = Object.keys(UNDOCUMENTED_BY_DESIGN).filter((name) => {
      const [ns, member] = name.split('.')
      return member ? !(vmContextObj[ns] && member in vmContextObj[ns]) : !surface.has(ns)
    })
    expect(dead, 'UNDOCUMENTED_BY_DESIGN names something the sandbox no longer has').toEqual([])
  })
})

/**
 * Option fidelity — the check a name-level oracle cannot make.
 *
 * `getStylesForLocator` existed, was callable, and destructured only `options.locator`,
 * so the `includeUserAgentStyles` the docs (and a shipped example) promised did nothing
 * at all. Nothing about its NAME was wrong.
 */
describe('every documented option is actually read by its wrapper', () => {
  const subjects: Array<[string, Set<string>]> = [
    ...[...documented.globals.entries()]
      .filter(([name, opts]) => opts.size > 0 && surface.has(name) && !isAmbientIntrinsic(name))
      .map(([name, opts]) => [name, opts] as [string, Set<string>]),
    ...documentedNamespaces.flatMap(([ns, members]) =>
      [...members.entries()]
        .filter(([, opts]) => opts.size > 0 && surface.has(ns))
        .map(([member, opts]) => [`${ns}.${member}`, opts] as [string, Set<string>]),
    ),
  ]

  it('found wrappers to check', () => {
    expect(subjects.length, 'no documented call carries options — the extractor is broken').toBeGreaterThan(25)
  })

  it.each(subjects)('%s reads every option the docs give it', (name, options) => {
    const [global, member] = name.split('.')
    const wrapper = analyseWrapperOptions({ executorFile: EXECUTOR_FILE, surface, global, member })
    expect(
      wrapper,
      `could not resolve ${name} to an implementation. The oracle follows aliases, imports and factory ` +
        'calls out of executor.ts; extend sandbox-api-oracle.ts rather than dropping the check.',
    ).not.toBeNull()
    if (wrapper!.transparent) return // forwards its options whole; nothing can be dropped
    const dropped = [...options].filter((option) => !wrapper!.observed.has(option))
    expect(
      dropped,
      `${name} (${wrapper!.definedIn}) never reads ${dropped.join(', ')}, but the docs pass it. ` +
        `It reads: ${[...wrapper!.observed].sort().join(', ') || '(nothing)'}`,
    ).toEqual([])
  })
})

/**
 * The same check against each wrapper's OWN declared type.
 *
 * `snapshot` accepted `format?: SnapshotFormat` in its parameter type and never
 * destructured it, so the option type-checked, read as supported, and did nothing. The
 * docs never mentioned it, so only the type can catch this one.
 */
describe('every option a wrapper declares is actually read by it', () => {
  const declaredSubjects = [...surface.keys()]
    .map((name) => [name, analyseWrapperOptions({ executorFile: EXECUTOR_FILE, surface, global: name })] as const)
    .filter(([, wrapper]) => wrapper && wrapper.declared && wrapper.declared.size > 0 && !wrapper.transparent)

  it('found wrappers with inline option types', () => {
    expect(declaredSubjects.length).toBeGreaterThan(5)
  })

  it.each(declaredSubjects)('%s reads every option its own type declares', (name, wrapper) => {
    const dead = [...wrapper!.declared!].filter((option) => !wrapper!.observed.has(option))
    expect(
      dead,
      `${name} declares ${dead.join(', ')} in its parameter type and never reads it — the option ` +
        'type-checks at the call site and does nothing at runtime',
    ).toEqual([])
  })
})

describe('static-analysis lane is genuinely callable (not just present)', () => {
  const { vmContextObj } = buildSandbox()

  it('inspectBinding reports a const whose value is mutated in place', () => {
    const report = vmContextObj.inspectBinding({
      code: 'const items = []; items.push(1); export default items',
      name: 'items',
    })
    expect(report.ok).toBe(true)
    expect(report.name).toBe('items')
    expect(report.constant).toBe(true)
    // The point of the hazard: `const` says nothing about writes THROUGH the binding.
    expect(report.hazards.length).toBeGreaterThan(0)
  })

  it('evaluateBinding folds a constant and returns no NodePath', () => {
    const probe = vmContextObj.evaluateBinding({ code: 'const n = 2 + 3; export default n', name: 'n' })
    expect(probe.ok).toBe(true)
    expect(JSON.stringify(probe)).not.toContain('NodePath')
  })

  it('findMissingDeps scans a FILE and finds the missing dep', () => {
    const report = vmContextObj.findMissingDeps({
      code: [
        'import { useEffect } from "react"',
        'export function C({ id }) {',
        '  useEffect(() => { console.log(id) }, [])',
        '  return null',
        '}',
      ].join('\n'),
    })
    expect(report.ok).toBe(true)
    expect(report.effects.length).toBe(1)
    expect(report.effects[0].hook).toBe('useEffect')
    expect(report.effects[0].missing).toContain('id')
  })

  it('isPureFunctionSource refuses a function that reaches outside', () => {
    expect(vmContextObj.isPureFunctionSource('(a) => a + 1').pure).toBe(true)
    const impure = vmContextObj.isPureFunctionSource('() => window.location.href')
    expect(impure.pure).toBe(false)
    expect(impure.freeIdentifiers).toContain('window')
  })

  it('moduleGraph hands out an OPAQUE handle, never the live graph', () => {
    const handle = vmContextObj.moduleGraph({ root: process.cwd() })
    expect(typeof handle.summary).toBe('function')
    expect(handle.fileCount).toBeGreaterThan(0)
    // The live graph holds NodePaths. None of its AST-bearing members may leak.
    expect((handle as any).getFile).toBeUndefined()
    expect((handle as any).exportsByFile).toBeUndefined()
    expect((handle as any).callSites).toBeUndefined()
    const summary = handle.summary()
    expect(summary.root).toBe(process.cwd())
    // The digest must survive JSON — that is what "safe to hand to an agent" means.
    expect(() => JSON.stringify(summary)).not.toThrow()
  })

  it('moduleGraph reuses the executor cache rather than reparsing', () => {
    const { vmContextObj: ctx } = buildSandbox()
    const a = ctx.moduleGraph({ root: process.cwd() })
    const b = ctx.moduleGraph({ root: process.cwd() })
    expect(a).toBe(b)
  })

  it('backwardSlice rejects a raw object where a graph handle is required', () => {
    expect(() =>
      vmContextObj.backwardSlice({ graph: { pretending: true }, startFile: '/x.ts', startExpr: 'n' }),
    ).toThrow(/must be a handle from moduleGraph/)
  })

  it('backwardSlice runs with only startFile/startExpr, defaulting the graph root', () => {
    const hop = vmContextObj.backwardSlice({ startFile: '/definitely/not/here.ts', startExpr: 'n' })
    // A missing file is a real answer with a real blockedBy — not a crash.
    expect(hop.kind).toBe('blocked')
    expect(() => JSON.stringify(hop)).not.toThrow()
  })
})

describe('wrappers do not re-introduce the failure modes the substrate removed', () => {
  const { vmContextObj } = buildSandbox()

  it('replayPure returns the union, and refusals carry positions + verdicts', () => {
    const ok = vmContextObj.replayPure({ fn: '(a, b) => a + b', args: [2, 3] })
    expect(ok.ok).toBe(true)
    expect(ok.value).toBe(5)

    const refused = vmContextObj.replayPure({ fn: '() => fetch("/x")' })
    expect(refused.ok).toBe(false)
    // `offending` (with source positions) and the admissible/unsafe split must survive.
    expect(Array.isArray(refused.offending)).toBe(true)
    expect(refused.categoricallyUnsafe).toContain('fetch')
  })

  it('replayPureAsync awaits an async sliced function', async () => {
    const result = await vmContextObj.replayPureAsync({ fn: 'async (a) => a * 2', args: [21] })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(42)
  })

  it('replayPure surfaces virtualised logs instead of refusing console', () => {
    const result = vmContextObj.replayPure({ fn: '(x) => { console.log("saw", x); return x }', args: [7] })
    expect(result.ok).toBe(true)
    expect(result.logs.length).toBe(1)
  })

  it('fiberDiff marks an unobservable comparison as unobservable, never unchanged', () => {
    const diff = vmContextObj.fiberDiff({ props: { onClick: '[function]' } }, { props: { onClick: '[function]' } })
    expect(diff.unchangedKeys.includes('onClick') && diff.unobservableKeys.includes('onClick')).toBe(false)
    expect(diff.unobservableKeys).toContain('onClick')
  })

  it('net.active/read/stop/warnings work on ids alone, with no controller in scope', async () => {
    const { vmContextObj: ctx, page } = buildSandbox()
    const controller = ctx.net.timeline({ page, urlPattern: '/api/' })
    expect(typeof controller.id).toBe('string')
    // Drop the controller entirely: the registry is the point.
    const listed = ctx.net.active({ live: true }).map((p: any) => p.id)
    expect(listed).toContain(controller.id)
    expect(ctx.net.read(controller.id)).toMatchObject({ entries: [] })
    expect(await ctx.net.stop(controller.id)).toBe(true)
    expect(ctx.net.active({ live: true }).map((p: any) => p.id)).not.toContain(controller.id)
    // A passive probe must never be reported as perturbing.
    expect(ctx.net.warnings()).toEqual([])
  })

  it('net.get reads one probe by id, live or stopped', async () => {
    // Without this the only route to a single probe's accounting was `traceProbes`, an
    // exported convenience namespace nothing imported — so it was unreachable.
    const { vmContextObj: ctx, page } = buildSandbox()
    const controller = ctx.net.timeline({ page, urlPattern: '/only/' })
    expect(ctx.net.get(controller.id)).toMatchObject({ id: controller.id, kind: 'net.timeline', live: true })
    expect(await ctx.net.stop(controller.id)).toBe(true)
    // Still readable after stopping: "who perturbed my measurement?" has to stay answerable.
    expect(ctx.net.get(controller.id)).toMatchObject({ live: false })
    expect(ctx.net.get('net.timeline#no-such-probe')).toBeNull()
  })

  it('net.timeline threads a caller-supplied buffer', () => {
    // The buffer is how a probe's entries outlive the execute() call that armed it
    // without going through the registry: `state.entries` fills up in place.
    const { vmContextObj: ctx, page } = buildSandbox()
    const buffer: any[] = []
    const controller = ctx.net.timeline({ page, urlPattern: '/api/', buffer })
    expect(ctx.net.read(controller.id)).toMatchObject({ entries: [] })
    // Same array object, not a copy: an entry pushed by the probe is visible here.
    buffer.push({ phase: 'request', url: 'https://example.test/api/x', ts: 1 })
    expect(controller.entries()).toHaveLength(1)
  })

  it('net.stopAll only stops probes THIS session armed', async () => {
    // The probe registry is module-level and shared by every session in the relay
    // process. One agent calling stopAll must not disarm another's measurement.
    const mine = buildSandbox()
    const theirs = buildSandbox()
    const myProbe = mine.vmContextObj.net.timeline({ page: mine.page, urlPattern: '/a' })
    const theirProbe = theirs.vmContextObj.net.timeline({ page: theirs.page, urlPattern: '/b' })

    const stopped = await mine.vmContextObj.net.stopAll()
    expect(stopped).toContain(myProbe.id)
    expect(stopped).not.toContain(theirProbe.id)

    const live = mine.vmContextObj.net.active({ live: true }).map((p: any) => p.id)
    expect(live).not.toContain(myProbe.id)
    expect(live).toContain(theirProbe.id) // still running, as it must be
    await theirs.executor.disposeBrowserSideResources()
  })

  it('session teardown stops probes armed against this executor', async () => {
    const { executor, vmContextObj: ctx, page } = buildSandbox()
    const controller = ctx.net.timeline({ page, urlPattern: '/api/' })
    const { probesStopped } = await executor.disposeBrowserSideResources()
    expect(probesStopped).toContain(controller.id)
    expect(ctx.net.active({ live: true }).map((p: any) => p.id)).not.toContain(controller.id)
  })

  it('readLogpoints returns the accounting, not a bare hits array', async () => {
    const { vmContextObj: ctx } = buildSandbox()
    // Feed the log pipeline directly: readLogpoints is pure over the log lines.
    const read = await ctx.readLogpoints({ tag: 'nothing-armed' })
    expect(Array.isArray(read)).toBe(false)
    expect(read).toHaveProperty('hits')
    expect(read).toHaveProperty('totalHits')
    expect(read).toHaveProperty('droppedHits')
    expect(read).toHaveProperty('malformedHits')
    expect(read).toHaveProperty('unparsableLines')
    expect(read).toHaveProperty('caps')
    expect(read).toHaveProperty('cursor')
    expect(read.caps).toMatchObject({ maxHits: 20, maxLen: 50 })
  })

  it('readLogpoints threads maxHits/maxLen through', async () => {
    const { vmContextObj: ctx } = buildSandbox()
    const read = await ctx.readLogpoints({ maxHits: 3, maxLen: 8 })
    expect(read.caps).toMatchObject({ maxHits: 3, maxLen: 8 })
  })

  it('setLogpoint propagates the non-pausing refusal instead of installing nothing', async () => {
    const { vmContextObj: ctx, page } = buildSandbox()
    // A malformed expr cannot be assembled into a provably non-pausing condition.
    await expect(
      ctx.setLogpoint({ page, file: 'app.js', line: 1, expr: 'debugger' }),
    ).rejects.toThrow(/not provably non-pausing/)
  })

  it('snapshot takes its page from the locator it is scoped to', async () => {
    // `snapshot({ locator: state.page.locator('main') })` is exactly how the docs show a
    // scoped snapshot, and it used to resolve that locator against the DEFAULT page —
    // the silent-wrong-tab failure the `{ page: state.page }` rule exists to prevent.
    const { vmContextObj: ctx } = buildSandbox()
    const other = stubPage().page
    const ariaSnapshot = await import('./aria-snapshot.js')
    const spy = vi.spyOn(ariaSnapshot, 'getAriaSnapshot')
    spy.mockResolvedValue({ snapshot: '', refs: [], getSelectorForRef: () => null } as any)

    await ctx.snapshot({ locator: other.locator('main') })
    expect(spy.mock.calls[0][0].page, 'the locator owns a page; the default global must not win').toBe(other)

    // An explicit page still wins over the locator's.
    spy.mockClear()
    await ctx.snapshot({ page: ctx.page, locator: other.locator('main') })
    expect(spy.mock.calls[0][0].page).toBe(ctx.page)
    spy.mockRestore()
  })

  it('snapshot refuses an unknown format instead of ignoring it', async () => {
    // `format` used to be accepted by the type and never destructured, so it read as a
    // supported option and did nothing at all.
    const { vmContextObj: ctx, page } = buildSandbox()
    await expect(ctx.snapshot({ page, format: 'markdown' })).rejects.toThrow(/format/)
  })

  it('recording.caption/clearCaption/hold/frameCount fail loudly with no screencast running', async () => {
    // Silently accepting the caption would leave the agent believing the clip is
    // narrated, and it would only find out after handing the video to a human.
    const { vmContextObj: ctx } = buildSandbox()
    expect(() => ctx.recording.caption('step 1')).toThrow(/No CDP screencast is running/)
    expect(() => ctx.recording.clearCaption()).toThrow(/No CDP screencast is running/)
    expect(() => ctx.recording.hold()).toThrow(/No CDP screencast is running/)
    expect(() => ctx.recording.frameCount()).toThrow(/No CDP screencast is running/)
  })
})

describe('traceValue summary shape', () => {
  it('render is a METHOD taking options, and expand returns a bounded subtree', async () => {
    const { vmContextObj: ctx } = buildSandbox()
    // Inject a ready slice so no browser or source tree is needed.
    const slice = {
      kind: 'root',
      site: null,
      blockedBy: null,
      hazards: [],
      evaluated: null,
      children: [
        { kind: 'value', site: null, blockedBy: null, hazards: [], evaluated: null, children: [] },
        { kind: 'blocked', site: null, blockedBy: 'budget-hops', hazards: [], evaluated: null, children: [] },
      ],
    }
    const t = await ctx.traceValue({ page: null, slice })

    expect(typeof t.render).toBe('function')
    const full = t.render()
    expect(typeof full).toBe('string')
    // Options actually do something: a 1-line budget must collapse the output.
    expect(t.render({ maxLines: 1 }).split('\n').length).toBeLessThan(full.split('\n').length + 1)
    expect(t.render({ maxLines: 1 })).toContain('collapsed')

    expect(Array.isArray(t.hopIds)).toBe(true)
    expect(t.hopIds).toContain('0')
    expect(Array.isArray(t.warnings)).toBe(true)

    // expand returns a real subtree with the depth accounting, not a childCount.
    const sub = t.expand('0', { depth: 1 })
    expect(Array.isArray(sub.children)).toBe(true)
    expect(sub.children.length).toBe(2)
    expect(sub).toHaveProperty('omittedChildren')
    expect(sub).toHaveProperty('complete')
    expect((sub as any).childCount).toBeUndefined()
    expect(() => JSON.stringify(sub)).not.toThrow()

    // depth 0 must REPORT what it cut rather than looking complete.
    const shallow = t.expand('0', { depth: 0 })
    expect(shallow.children.length).toBe(0)
    expect(shallow.omittedChildren).toBe(2)
    expect(shallow.complete).toBe(false)

    // budget-hops is a static remedy: raise maxHops, do not go get runtime evidence.
    const budget = t.blocked.find((b: any) => b.blockedBy === 'budget-hops')
    expect(budget.probe.type).toBe('static-remedy')
  })
})

describe('pm option threading', () => {
  it('threads rootSelector (and the deprecated scope alias) into buildPageModel', async () => {
    const { vmContextObj, page } = buildSandbox()
    const pageModel = await import('./page-model.js')
    const spy = vi.spyOn(pageModel, 'buildPageModel')
    // The stub page cannot actually be measured; we only assert what was REQUESTED,
    // which is the thing the old wrapper silently dropped.
    spy.mockRejectedValue(new Error('stub'))
    await expect(vmContextObj.pm.query({ page, rootSelector: 'main' })).rejects.toThrow('stub')
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ rootSelector: 'main' }))

    spy.mockClear()
    await expect(vmContextObj.pm.query({ page, scope: '#app' })).rejects.toThrow('stub')
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scope: '#app' }))
    spy.mockRestore()
  })

  /**
   * `scope` is ONE selector in TWO incompatible languages, and the wrapper used to hand
   * the same string to both: `buildPageModel({ scope })` reads it as `rootSelector`, a
   * Playwright selector applied before any tree exists, while `model.query({ scope })`
   * reads it as `within`, a page-path selector over the built tree. Whatever the caller
   * meant, one of the two was wrong — and an unmatched `within` THROWS, so a perfectly
   * good `pm.query({ scope: 'main' })` died inside the query it never asked for.
   *
   * On `pm.*` the alias means `rootSelector`, exactly as the docs say. It is stripped
   * before the query sees it; `within` is how you scope a query.
   */
  it('applies `scope` at the BUILD layer only, never as a query `within`', async () => {
    const { vmContextObj, page } = buildSandbox()
    const pageModel = await import('./page-model.js')
    const spy = vi.spyOn(pageModel, 'buildPageModel')
    let queried: any = null
    spy.mockResolvedValue({
      query: (opts: any) => {
        queried = opts
        return []
      },
      diffAgainst: () => {},
    } as any)

    await vmContextObj.pm.query({ page, scope: '#app', roles: ['button'] })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scope: '#app' }))
    expect(queried, 'the build-layer scope must not reach the query as a page-path `within`').toMatchObject({
      roles: ['button'],
    })
    expect(queried.scope).toBeUndefined()
    expect(queried.within).toBeUndefined()

    // `within` is untouched: it is the query scope and belongs to the query.
    queried = null
    await vmContextObj.pm.query({ page, within: 'element#main' })
    expect(queried.within).toBe('element#main')

    // queryPage is the same projection under another name and must behave identically.
    queried = null
    await vmContextObj.queryPage({ page, scope: '#app' })
    expect(queried.scope).toBeUndefined()
    spy.mockRestore()
  })
})

describe('getStylesForLocator wrapper fidelity', () => {
  it('threads includeUserAgentStyles and reuses a caller-supplied cdp', async () => {
    const { vmContextObj, page } = buildSandbox()
    const styles = await import('./styles.js')
    const spy = vi.spyOn(styles, 'getStylesForLocator')
    spy.mockResolvedValue({ element: 'div', rules: [], inlineStyle: null } as any)

    const cdp = { send: async () => ({}), on: () => {}, off: () => {}, detach: async () => {} } as any
    const locator = page.locator('.btn')
    await vmContextObj.getStylesForLocator({ locator, cdp, includeUserAgentStyles: true })

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ locator, cdp, includeUserAgentStyles: true }))
    spy.mockRestore()
  })
})
