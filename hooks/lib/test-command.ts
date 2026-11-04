// Does a Bash command start a test run? Pure functions.
//
// The command is split into segments at `&&`, `||`, `;`, `|` and newlines,
// and only the word in command position of each segment counts, so
// `cat vitest.config.ts` or `rg vitest src` never match while `npx vitest`
// and `cd web && pnpm test` do.

export const TOAST_COOLDOWN_MS = 5 * 60_000

const TEST_BINS = new Set(['vitest', 'playwright'])
const NPX_LIKE = new Set(['npx', 'bunx', 'pnpx'])
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const PREFIXES = new Set(['time', 'env', 'command', 'exec', 'nice', 'nohup', 'caffeinate', 'timeout'])
/** Prefix arguments such as `timeout 600` or `nice -n 5`. */
const PREFIX_ARG = /^(?:-\S*|\d+[smhd]?)$/
/** Package-manager flags that take the next word as their value. */
const FLAGS_WITH_VALUE = new Set(['--filter', '-F', '-C', '--dir', '--workspace', '--prefix', '--cwd'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** `./bin/vitest` → `vitest`, `vitest@3` → `vitest`. */
const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1).replace(/@[^@/]*$/, '')

/** `vitest …` always; `playwright` only as `playwright test`. */
function isTestBin(words: readonly string[]): boolean {
  const name = base(words[0] ?? '')
  if (name === 'vitest') return true

  return name === 'playwright' && words[1] === 'test'
}

const isTestScript = (word: string | undefined): boolean =>
  word !== undefined && /^test(?:$|[:\-_.])/.test(word)

function dropFlags(words: readonly string[], ownValue: boolean): string[] {
  const rest = [...words]
  while (rest[0]?.startsWith('-')) {
    const flag = rest.shift() ?? ''
    if (ownValue && FLAGS_WITH_VALUE.has(flag)) rest.shift()
  }

  return rest
}

function isTestSegment(segment: string): boolean {
  let words = segment
    .replace(/^[\s(]+/, '')
    .split(/\s+/)
    .map(word => word.replace(/\)+$/, ''))
    .filter(Boolean)
  while (words[0] !== undefined && (ENV_ASSIGNMENT.test(words[0]) || PREFIXES.has(words[0]))) {
    words = words.slice(1)
    while (words[0] !== undefined && PREFIX_ARG.test(words[0])) words = words.slice(1)
  }
  const head = base(words[0] ?? '')
  if (TEST_BINS.has(head)) return isTestBin(words)
  if (NPX_LIKE.has(head)) return isTestBin(dropFlags(words.slice(1), false))
  if (!PACKAGE_MANAGERS.has(head)) return false

  let rest = dropFlags(words.slice(1), true)
  // `yarn workspace web test`: skip the workspace name.
  if (rest[0] === 'workspace') rest = dropFlags(rest.slice(2), true)
  const sub = rest[0] === 't' ? 'test' : rest[0]
  if (sub === 'run' || sub === 'run-script') return isTestScript(dropFlags(rest.slice(1), true)[0])
  if (sub === 'exec' || sub === 'dlx' || sub === 'x') return isTestBin(dropFlags(rest.slice(1), false))
  if (isTestScript(sub)) return true
  // `pnpm vitest`, `yarn playwright test`: the package manager runs a bin.
  return isTestBin(rest)
}

export function isTestCommand(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some(isTestSegment)
}

/** At most one toast per cooldown: true when none was shown yet or the last is old enough. */
export function canToast(lastToastAt: number | undefined, now: number): boolean {
  return lastToastAt === undefined || now - lastToastAt >= TOAST_COOLDOWN_MS
}
