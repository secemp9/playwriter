/**
 * Fails the build if any source file is not valid UTF-8, or contains a control byte other than
 * tab (0x09) or newline (0x0A).
 *
 * This runs as the FIRST step of `pnpm build`, before `rm -rf dist` and before the ~25 seconds
 * of bundling, for two reasons: a bad byte should not cost you a rebuild, and more importantly
 * the failure mode being guarded against is *tooling going quiet* - grep returning nothing at
 * all because a NUL made it treat the file as binary. A check for that has to run somewhere a
 * person actually reads the output, not somewhere it can be silently skipped.
 *
 * The same check also runs as a vitest test (src/source-bytes.test.ts), so it fires under
 * `pnpm test` too. Both paths share the implementation in src/source-bytes.ts.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSourceBytesCheck } from '../src/source-bytes.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(scriptDir, '..')

process.exit(runSourceBytesCheck({ packageRoot }))
