/**
 * Guards source files against stray control bytes and invalid UTF-8.
 *
 * The incident this exists for: a raw NUL in a template literal in src/executor.ts compiled
 * cleanly, passed every test, and made grep silently return nothing for that entire file - no
 * match, no warning, exit code 1. Several searches came back empty and read as "this was never
 * wired up" when it was fully wired.
 *
 * These tests do three separate jobs:
 *   1. verify the detector itself against synthetic buffers,
 *   2. verify the failure message actually says file / offset / hex byte / context,
 *   3. scan the real tree.
 *
 * Note on snapshots: this file deliberately uses no snapshot assertions. `pnpm test` runs
 * `vitest run -u`, which would rewrite a snapshot to match whatever the code now does - the
 * exact opposite of a guard.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  CONTROL_BYTE_EXCEPTIONS,
  PACKAGE_ROOT,
  SKIPPED_DIRECTORIES,
  SKIPPED_EXTENSIONS,
  describeByte,
  findByteViolations,
  findInvalidUtf8,
  formatViolation,
  listScannedFiles,
  scanSourceBytes,
} from './source-bytes.js'

/**
 * The complete list of files permitted to contain raw control bytes. Verified by reading the
 * file end to end:
 *
 *   - src/kitty-graphics.test.ts line 45 holds a vitest inline snapshot of a kitty graphics APC
 *     sequence, so the two ESC bytes are the value under test. Every other escape in that file
 *     is spelled \x1b. vitest regenerates that literal under `vitest run -u`, so a hand-written
 *     escape would not survive the next test run.
 *
 * src/relay-core.test.ts was the second entry, for the ANSI dim codes (ESC [2m ... ESC [22m)
 * inside its inline snapshots of Playwright "Call log:" output — 39 lines, 78 ESC bytes. Those
 * snapshots also pinned how many actionability retries fitted inside a 100ms click budget,
 * which is a property of the machine, not of the code; they are now toContain() assertions on
 * the error message and on the deterministic head of the call log, matching the text inside the
 * dim codes rather than the codes. That removed every ESC from the file, so the exception was
 * deleted rather than left dangling.
 *
 * If you are here because this assertion failed: adding a file means adding an entry to
 * CONTROL_BYTE_EXCEPTIONS in source-bytes.ts with a written reason, and adding it here. That
 * friction is the point.
 */
const FILES_ALLOWED_RAW_CONTROL_BYTES = ['src/kitty-graphics.test.ts']

const bytesOf = (text: string): Uint8Array => {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

describe('control byte detection', () => {
  test('flags a NUL and reports its offset, byte, line and column', () => {
    const bytes = bytesOf('const a = 1\nconst key = `x\x00y`\n')
    const violations = findByteViolations({ file: 'scratch.ts', bytes })

    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('control-byte')
    expect(violations[0].byte).toBe(0x00)
    expect(violations[0].offset).toBe(bytes.indexOf(0x00))
    expect(violations[0].line).toBe(2)
    // 'const key = `x' is 14 bytes, so the NUL is the 15th byte of line 2.
    expect(violations[0].column).toBe(15)
    expect(violations[0].detail).toBe('disallowed control byte 0x00 (NUL)')
  })

  test('allows tab and newline', () => {
    const violations = findByteViolations({ file: 'scratch.ts', bytes: bytesOf('a\tb\nc\td\n') })
    expect(violations).toEqual([])
  })

  test('rejects carriage return, so CRLF cannot creep in unnoticed', () => {
    const violations = findByteViolations({ file: 'scratch.ts', bytes: bytesOf('const a = 1\r\n') })
    expect(violations.map((violation) => violation.byte)).toEqual([0x0d])
  })

  test('rejects DEL, which is just as invisible as the low control bytes', () => {
    const violations = findByteViolations({ file: 'scratch.ts', bytes: bytesOf('const a = 1\x7f\n') })
    expect(violations.map((violation) => violation.byte)).toEqual([0x7f])
  })

  test('rejects ESC by default and accepts it only when named in allowedExtraBytes', () => {
    const bytes = bytesOf('const dim = "\x1b[2m"\n')
    expect(findByteViolations({ file: 'scratch.ts', bytes }).map((violation) => violation.byte)).toEqual([0x1b])
    expect(findByteViolations({ file: 'scratch.ts', bytes, allowedExtraBytes: [0x1b] })).toEqual([])
  })

  test('an ESC exception still does not let a NUL through in the same file', () => {
    const bytes = bytesOf('const dim = "\x1b[2m"\nconst key = "a\x00b"\n')
    const violations = findByteViolations({ file: 'scratch.ts', bytes, allowedExtraBytes: [0x1b] })
    expect(violations.map((violation) => violation.byte)).toEqual([0x00])
  })

  test('reports every occurrence, in offset order', () => {
    const bytes = bytesOf('\x00a\x01b\x02\n')
    expect(findByteViolations({ file: 'scratch.ts', bytes }).map((violation) => violation.offset)).toEqual([0, 2, 4])
  })

  test('describeByte names the control characters', () => {
    expect(describeByte(0x00)).toBe('0x00 (NUL)')
    expect(describeByte(0x1b)).toBe('0x1B (ESC)')
    expect(describeByte(0x0d)).toBe('0x0D (CR)')
    expect(describeByte(0xc3)).toBe('0xC3')
  })
})

describe('utf-8 validation', () => {
  test('accepts well-formed multi-byte sequences', () => {
    expect(findInvalidUtf8(bytesOf('ascii / accents é / cjk 漢 / emoji \u{1f600}\n'))).toBeNull()
  })

  test('rejects a continuation byte with no lead byte', () => {
    const result = findInvalidUtf8(new Uint8Array([0x61, 0x80, 0x62]))
    expect(result?.offset).toBe(1)
    expect(result?.byte).toBe(0x80)
    expect(result?.detail).toContain('continuation byte with no lead byte')
  })

  test('rejects a truncated sequence at end of file', () => {
    const result = findInvalidUtf8(new Uint8Array([0x61, 0xe6, 0xbc]))
    expect(result?.offset).toBe(1)
    expect(result?.detail).toContain('truncated 3-byte UTF-8 sequence')
  })

  test('rejects a lead byte followed by a non-continuation byte', () => {
    const result = findInvalidUtf8(new Uint8Array([0xc3, 0x41]))
    expect(result?.offset).toBe(1)
    expect(result?.detail).toContain('expected a UTF-8 continuation byte')
  })

  test('rejects an overlong encoding of a character that fits in fewer bytes', () => {
    // U+002F written as three bytes instead of one.
    const result = findInvalidUtf8(new Uint8Array([0xe0, 0x80, 0xaf]))
    expect(result?.offset).toBe(0)
    expect(result?.detail).toContain('overlong')
  })

  test('rejects the UTF-8 encoding of a surrogate code point', () => {
    // U+D800 encoded as if it were an ordinary character.
    const result = findInvalidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))
    expect(result?.detail).toContain('surrogate')
  })

  test('rejects code points above U+10FFFF', () => {
    const result = findInvalidUtf8(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))
    expect(result?.detail).toContain('above the Unicode maximum')
  })

  test('rejects bytes that can never begin a sequence', () => {
    expect(findInvalidUtf8(new Uint8Array([0xc0, 0x80]))?.byte).toBe(0xc0)
    expect(findInvalidUtf8(new Uint8Array([0xff]))?.byte).toBe(0xff)
  })

  test('surfaces invalid utf-8 through findByteViolations', () => {
    const violations = findByteViolations({ file: 'scratch.ts', bytes: new Uint8Array([0x61, 0xff, 0x0a]) })
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('invalid-utf8')
  })
})

describe('failure message', () => {
  const bytes = bytesOf('const prefix = "p"\nconst cacheKey = `${prefix}\x00${suffix}`\nexport {}\n')
  const violation = findByteViolations({ file: 'src/executor.ts', bytes })[0]
  const message = formatViolation({ violation, bytes })

  test('names the file with line and column', () => {
    expect(message).toContain(`src/executor.ts:${violation.line}:${violation.column}`)
  })

  test('states the byte offset', () => {
    expect(message).toContain(`byte offset:    ${violation.offset}`)
    expect(violation.offset).toBe(bytes.indexOf(0x00))
  })

  test('states the offending byte in hex, by name', () => {
    expect(message).toContain('offending byte: 0x00 (NUL)')
  })

  test('shows the surrounding source line with the byte escaped and a caret under it', () => {
    const lines = message.split('\n')
    const caretIndex = lines.findIndex((line) => {
      return line.endsWith('^^^^ here')
    })
    expect(caretIndex).toBeGreaterThan(0)

    const renderedLine = lines[caretIndex - 1]
    expect(renderedLine).toContain('const cacheKey = `${prefix}\\x00${suffix}`')
    // The caret must sit exactly under the escaped byte, not merely somewhere on the line.
    expect(lines[caretIndex].indexOf('^')).toBe(renderedLine.indexOf('\\x00'))
  })

  test('shows a hex dump of the surrounding bytes with the offender marked', () => {
    expect(message).toContain(`raw bytes around offset ${violation.offset}`)
    const lines = message.split('\n')
    const markerIndex = lines.findIndex((line) => {
      return line.trim() === '^^'
    })
    expect(markerIndex).toBeGreaterThan(0)

    const dumpRow = lines[markerIndex - 1]
    // A hex dump row is `<offset>  <32 hex digits>  |<ascii gutter>|`.
    expect(dumpRow).toMatch(/^ {4}[0-9A-F]{8} {2}/)
    expect(dumpRow).toContain('|')
    // The marker must sit under the hex pair for the offending byte, and the ASCII gutter
    // must show it as a dot rather than pretending it is a printable character.
    const markerColumn = lines[markerIndex].indexOf('^')
    expect(dumpRow.slice(markerColumn, markerColumn + 2)).toBe('00')
    expect(dumpRow.slice(dumpRow.indexOf('|') + 1, dumpRow.lastIndexOf('|'))).toContain('prefix}.$')
  })

  test('explains why a NUL specifically is a problem, and how to fix it', () => {
    expect(message).toContain('grep')
    expect(message).toContain('\\x00')
  })

  test('explains carriage returns differently from NUL', () => {
    const crBytes = bytesOf('const a = 1\r\n')
    const crMessage = formatViolation({
      violation: findByteViolations({ file: 'a.ts', bytes: crBytes })[0],
      bytes: crBytes,
    })
    expect(crMessage).toContain('LF-only')
  })

  test('explains invalid utf-8 differently from a control byte', () => {
    const badBytes = new Uint8Array([0x61, 0xff, 0x0a])
    const badMessage = formatViolation({
      violation: findByteViolations({ file: 'a.ts', bytes: badBytes })[0],
      bytes: badBytes,
    })
    expect(badMessage).toContain('not valid UTF-8')
  })
})

describe('exception list', () => {
  test('no exception may whitelist NUL, and every exception carries a written reason', () => {
    for (const exception of CONTROL_BYTE_EXCEPTIONS) {
      expect(exception.allowedBytes).not.toContain(0x00)
      expect(exception.allowedBytes.length).toBeGreaterThan(0)
      expect(exception.reason.trim().length).toBeGreaterThan(40)
    }
  })

  test('every exception names a file that exists', () => {
    expect(scanSourceBytes({ applyExceptions: false }).missingExceptionFiles).toEqual([])
  })

  test('exceptions are exact filenames, never patterns', () => {
    for (const exception of CONTROL_BYTE_EXCEPTIONS) {
      expect(exception.file).not.toMatch(/[*?[\]]/)
      expect(fs.statSync(path.join(PACKAGE_ROOT, exception.file)).isFile()).toBe(true)
    }
  })

  test('the exception list matches exactly the files that need one', () => {
    const withoutExceptions = scanSourceBytes({ applyExceptions: false })
    const offendingFiles = [
      ...new Set(
        withoutExceptions.violations
          .filter((violation) => {
            return violation.kind === 'control-byte'
          })
          .map((violation) => {
            return violation.file
          }),
      ),
    ].sort()

    expect(offendingFiles).toEqual(FILES_ALLOWED_RAW_CONTROL_BYTES)
    expect(CONTROL_BYTE_EXCEPTIONS.map((exception) => exception.file).sort()).toEqual(FILES_ALLOWED_RAW_CONTROL_BYTES)
    expect(withoutExceptions.unusedExceptions).toEqual([])
  })

  test('the excepted files contain only ESC, and nothing worse', () => {
    const withoutExceptions = scanSourceBytes({ applyExceptions: false })
    for (const file of FILES_ALLOWED_RAW_CONTROL_BYTES) {
      const bytesInFile = [
        ...new Set(
          withoutExceptions.violations
            .filter((violation) => {
              return violation.file === file
            })
            .map((violation) => {
              return violation.byte
            }),
        ),
      ]
      expect(bytesInFile).toEqual([0x1b])
    }
  })
})

describe('scan scope', () => {
  test('covers src, scripts, test, docs and the package root', () => {
    const files = listScannedFiles()
    expect(files).toContain('package.json')
    expect(files).toContain('vitest.config.ts')
    expect(files).toContain('src/executor.ts')
    expect(files).toContain('scripts/check-source-bytes.ts')
    expect(files).toContain('test/security.test.ts')
    expect(files).toContain('docs/plan-centralize-relay-state.md')
  })

  test('skips generated output, dependencies and binary fixtures', () => {
    const files = listScannedFiles()
    for (const file of files) {
      for (const skipped of Object.keys(SKIPPED_DIRECTORIES)) {
        expect(file.split('/')).not.toContain(skipped)
      }
      expect(Object.keys(SKIPPED_EXTENSIONS)).not.toContain(path.extname(file).toLowerCase())
    }
    // The committed golden frames are real files under a scanned root, and are skipped by
    // extension rather than by being outside the walk.
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'test/video-golden/solid-dark.png'))).toBe(true)
    expect(files).not.toContain('test/video-golden/solid-dark.png')
  })

  test('scans a meaningful number of files', () => {
    expect(listScannedFiles().length).toBeGreaterThan(100)
  })
})

describe('end-to-end scan of a synthetic tree', () => {
  const withTempPackage = (build: (root: string) => void, assert: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bytes-'))
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      build(root)
      assert(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  test('a NUL in a source file is found, reported and located', () => {
    withTempPackage(
      (root) => {
        fs.writeFileSync(path.join(root, 'src/clean.ts'), 'export const clean = 1\n')
        fs.writeFileSync(path.join(root, 'src/dirty.ts'), 'export const key = `a\x00b`\n')
      },
      (root) => {
        const result = scanSourceBytes({ packageRoot: root })
        expect(result.violations.map((violation) => violation.file)).toEqual(['src/dirty.ts'])
        expect(result.violations[0].byte).toBe(0x00)
        expect(result.reports).toHaveLength(1)
        expect(result.reports[0]).toContain('src/dirty.ts:1:22')
        expect(result.reports[0]).toContain('offending byte: 0x00 (NUL)')
      },
    )
  })

  test('binary fixtures and node_modules are not read at all', () => {
    withTempPackage(
      (root) => {
        fs.mkdirSync(path.join(root, 'src/node_modules'), { recursive: true })
        fs.writeFileSync(path.join(root, 'src/node_modules/dep.js'), 'var x = "\x00"\n')
        fs.writeFileSync(path.join(root, 'src/golden.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))
        fs.writeFileSync(path.join(root, 'src/ok.ts'), 'export const ok = 1\n')
      },
      (root) => {
        const result = scanSourceBytes({ packageRoot: root })
        expect(result.files).toEqual(['src/ok.ts'])
        expect(result.violations).toEqual([])
      },
    )
  })

  test('caps the number of reports per file but still counts every violation', () => {
    withTempPackage(
      (root) => {
        fs.writeFileSync(path.join(root, 'src/many.ts'), `const a = "${'\x00'.repeat(10)}"\n`)
      },
      (root) => {
        const result = scanSourceBytes({ packageRoot: root })
        expect(result.violations).toHaveLength(10)
        expect(result.reports).toHaveLength(4)
        expect(result.reports[3]).toContain('and 7 more violation(s) in src/many.ts')
      },
    )
  })
})

describe('the real tree', () => {
  test('every source file is valid UTF-8 with no control bytes besides tab and newline', () => {
    const result = scanSourceBytes()
    if (result.reports.length > 0) {
      throw new Error(
        `${result.violations.length} disallowed byte(s) found in ${new Set(result.violations.map((violation) => violation.file)).size} file(s):\n\n` +
          result.reports.join('\n\n'),
      )
    }
    expect(result.violations).toEqual([])
  })
})
