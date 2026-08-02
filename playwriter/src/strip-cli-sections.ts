/**
 * The `## CLI Usage` strip that turns `src/skill.md` into `dist/prompt.md`.
 *
 * `dist/prompt.md` is the `execute` tool description every MCP agent receives, and it is
 * `skill.md` with this one section removed. That makes the strip load-bearing in two
 * directions at once, and both failures are silent:
 *
 *   - Strip too little and the whole CLI section — `playwriter -s 1 -e`, `npx`, `--browser
 *     cloud` — ships into every agent's context on every call.
 *   - Strip too much and correct, MCP-relevant documentation vanishes from the only place
 *     an agent can read it, while `skill.md` still says it and every human reviewer still
 *     sees it.
 *
 * It lives here rather than inside `scripts/build-resources.ts` so the build and the
 * guards in `executor-sandbox.test.ts` run the SAME code. When the test derived the
 * boundary itself it derived it wrong — it cut at the next `## ` and so also discarded the
 * `# playwriter best practices` h1 section, which the real strip keeps. A guard that
 * disagrees with the thing it guards is not a guard.
 */
import { Lexer, type Token, type Tokens } from 'marked'

/** The h2 whose section is dropped. Renaming it in skill.md must FAIL the build, not
 *  silently ship the section — see the throw in `splitSkillOnCliSection`. */
export const CLI_SECTION_HEADING = 'CLI Usage'

/**
 * A stripped section larger than this fraction of the source is treated as a bug, not an
 * edit. The accident it catches is the section never terminating: the strip runs until the
 * next heading of depth <= 2, so if no such heading follows, it eats the rest of the file
 * and emits a valid, nearly empty prompt.md with no error anywhere.
 *
 * The real figure is ~9%. The ceiling is far above it deliberately: it fires when the
 * boundary BREAKS, not when somebody adds a paragraph of CLI docs.
 *
 * BE CLEAR ABOUT WHAT THIS DOES NOT CATCH. The realistic version of the accident is much
 * smaller and no less damaging: demote the heading that terminates the section — today
 * `# playwriter best practices` — and the strip swallows one extra section and stops at
 * the h2 after it, landing at ~12% of the file. No size ceiling loose enough to tolerate
 * CLI docs growing is tight enough to see that, and nothing structural separates an
 * absorbed h3 from a legitimate `### Session management`. The token check in
 * `executor-sandbox.test.ts` is what catches that case, and there is a test proving it
 * fires on exactly this mutation.
 */
export const MAX_STRIPPED_FRACTION = 0.5

export interface SkillSplit {
  /** What `dist/prompt.md` gets: the source minus the CLI section. */
  shipped: string
  /** The CLI section itself, verbatim — everything the MCP prompt drops. */
  stripped: string
}

/**
 * Splits `skill.md` into the part the MCP prompt ships and the part it drops.
 *
 * Throws rather than returning a degenerate split, because every degenerate split is
 * indistinguishable from success at the call site: an unstripped prompt is still a valid
 * prompt, and an over-stripped one is still a valid prompt.
 */
export function splitSkillOnCliSection(skillContent: string): SkillSplit {
  const tokens = Lexer.lex(skillContent)

  const shippedTokens: Token[] = []
  const strippedTokens: Token[] = []
  let skipUntilDepth: number | null = null
  let headingsMatched = 0

  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      if (heading.depth === 2 && heading.text === CLI_SECTION_HEADING) {
        skipUntilDepth = 2
        headingsMatched++
        strippedTokens.push(token)
        continue
      }
      // Any heading at or above the section's level ends it.
      if (skipUntilDepth !== null && heading.depth <= skipUntilDepth) {
        skipUntilDepth = null
      }
    }

    if (skipUntilDepth === null) shippedTokens.push(token)
    else strippedTokens.push(token)
  }

  if (headingsMatched === 0) {
    throw new Error(
      `skill.md has no "## ${CLI_SECTION_HEADING}" heading, so nothing was stripped and the ` +
        `entire CLI section would ship in dist/prompt.md — the execute tool description every ` +
        `MCP agent receives. If the heading was renamed, update CLI_SECTION_HEADING in ` +
        `src/strip-cli-sections.ts to match.`,
    )
  }

  const shipped = shippedTokens.map((t) => t.raw).join('').trim() + '\n'
  const stripped = strippedTokens.map((t) => t.raw).join('').trim() + '\n'

  if (shipped.length >= skillContent.length) {
    throw new Error(
      `the "## ${CLI_SECTION_HEADING}" heading matched but the strip removed nothing ` +
        `(${skillContent.length} bytes in, ${shipped.length} out).`,
    )
  }

  const strippedFraction = stripped.length / skillContent.length
  if (strippedFraction > MAX_STRIPPED_FRACTION) {
    throw new Error(
      `the "## ${CLI_SECTION_HEADING}" strip removed ${(strippedFraction * 100).toFixed(1)}% of ` +
        `skill.md (ceiling ${MAX_STRIPPED_FRACTION * 100}%). The section runs until the next ` +
        `heading of depth <= 2, so this usually means the heading after it was demoted and the ` +
        `strip ran off the end of the file. dist/prompt.md would be missing most of the docs.`,
    )
  }

  return { shipped, stripped }
}

/** The build's entry point: `skill.md` minus the CLI section. */
export function stripCliSectionsFromSkill(skillContent: string): string {
  return splitSkillOnCliSection(skillContent).shipped
}
