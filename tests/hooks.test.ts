// The hooks through the engine's own `$`. Nothing sits beneath the plugin in
// a test: each `on(...)` hook here stands for the engine (the host's
// processes, files, clock, toasts, panes) and answers a call on `$` as `{ value }`.

import type { On, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { FOOTPRINT, LSOF_CWD, LSOF_LISTEN, MEASUREMENT, MEASUREMENT_WITH_PRESSURE, PS, PS_31, PS_ALONE } from './fixtures'

const ran = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Each session folder's repository (git common dir) and branch, as the repo shell run prints them. */
const REPOS: Record<string, [repo: string, branch: string]> = {
  '/Users/u/work/mine': ['/Users/u/src/watch-my-ram/.git', 'main'],
  '/Users/u/work/other': ['/Users/u/src/hub/.git', 'feat/x'],
  '/Users/u/work/desk': ['/Users/u/src/hub/.git', 'main'],
}

/** What `gh pr list --state all --json number,state,headRefName` prints for the hub repo. */
const PR_LIST = JSON.stringify([
  { number: 12, state: 'MERGED', headRefName: 'feat/x' },
  { number: 9, state: 'CLOSED', headRefName: 'feat/x' },
  { number: 11, state: 'OPEN', headRefName: 'feat/y' },
])

type GhAnswer = (argv: readonly string[], cwd: string | undefined) => { value: ProcessRunResult }

/** gh as GitHub would answer it: the hub list for `pr list`, nothing for `pr view`. */
const plainGh: GhAnswer = argv => (argv[2] === 'list' ? ran(PR_LIST) : ran('', 1))

/**
 * Answers `$.process.run` like this machine would, counting each command.
 * `ghDelay` holds each gh answer on `sleep` first, as a slow network would;
 * `repos` and `gh` change what the repo run and gh answer.
 */
function host(
  on: On,
  ps = PS,
  ghDelay?: () => Promise<void>,
  repos: Record<string, [repo: string, branch: string]> = REPOS,
  gh: GhAnswer = plainGh,
) {
  const calls: string[] = []
  on('process.run', async (_, e) => {
    const line = e.argv.join(' ')
    calls.push(line)
    if (line.includes('echo ---')) return ran(ps)
    if (line.includes('vm_stat')) return ran(MEASUREMENT)
    if (line.includes('-d cwd')) return ran(LSOF_CWD)
    if (line.includes('-sTCP:LISTEN')) return ran(LSOF_LISTEN)
    if (line.includes('footprint')) return ran(FOOTPRINT)
    if (line.includes('--git-common-dir')) {
      const folders = e.argv.slice(4)

      return ran(
        folders.flatMap(folder => (repos[folder] === undefined ? [] : [[folder, ...repos[folder]].join('\t')])).join('\n'),
      )
    }
    if (e.argv[0]?.endsWith('gh')) {
      await ghDelay?.()

      return gh(e.argv, e.init?.cwd)
    }

    return ran('', 1)
  })

  return calls
}

function toasts(on: On): string[] {
  const shown: string[] = []
  on('ui.toast', (_, e) => {
    shown.push(e.text)

    return { value: undefined }
  })

  return shown
}

/** The engine's own Bash: records exactly what reached it. */
function bash(on: On) {
  const reached: unknown[] = []
  on('tool.call', (_, e) => {
    reached.push(e)

    return { result: {} }
  })

  return reached
}

const BAND = {
  plugin: 'watch-my-ram',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'watch-my-ram',
  component: 'Pane',
  requestId: 'watch-my-ram',
  props: {
    title: 'watch-my-ram',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const GiB = 1024 ** 3
const SAMPLE = { at: 1, ramBytes: 12.8 * GiB, swapBytes: 21.8 * GiB, installedBytes: 16 * GiB }
const NOW = 10_000_000

type Engine = Parameters<TestBody>[0]

/**
 * The rest of the engine a session needs: env, the cache file, command and pane
 * registrations, and the surfaces the session draws on. A placed pane means
 * Claude Desktop (`desktop`); otherwise a headless run (no surface), unless
 * `surfaces` says otherwise.
 */
function sessionHost(
  on: On,
  cache: { mtimeMs?: number; text?: string },
  panes: { isPlaced: boolean; isOpen?: boolean; opens?: unknown[]; surfaces?: ('terminal' | 'desktop')[] } = {
    isPlaced: false,
  },
  closes: string[] = [],
) {
  const writes: string[] = []
  on('session.surfaces', () => ({ value: panes.surfaces ?? (panes.isPlaced ? ['desktop'] : []) }))
  mock.env(on, { HOME: '/Users/u' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'watch-my-ram' } }))
  on('fs.stat', (_, e) => {
    expect(e.path).toBe('/Users/u/.claude/watch-my-ram/sample.json')

    return cache.mtimeMs === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: 10, mtimeMs: cache.mtimeMs, isLink: false } }
  })
  on('fs.read', () => (cache.text === undefined ? { deny: 'ENOENT' } : { value: cache.text }))
  on('fs.write', (_, e) => {
    writes.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    panes.opens?.push(e)

    return panes.isPlaced ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'no-surface' } }
  })
  on('ui.close', (_, e) => {
    closes.push(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value:
      panes.isOpen === true
        ? [{ id: 'watch-my-ram', title: 'watch-my-ram', isShown: true, isFocused: false, isPlaced: true }]
        : [],
  }))

  return writes
}

async function bandText($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...BAND, surface })
  const text = await ui.find({ type: 'Text', text: /^watch-my-ram/ })
  await ui.unmount()

  return text
}

const startSession = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const runRollCall = ($: Engine) =>
  $.command.run({
    command: 'watch-my-ram',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

/** Seeds `$.state` as an earlier write would have left it. */
const seed = (on: On, sample: object = SAMPLE) =>
  on('state.get', (_, e) => ({
    value: {
      value: e.key === 'sample' ? { shape: 'sample-2', value: sample } : { shape: 'roll-1', value: null },
      version: 1,
    },
  }))

test('a test command while another session tests: one toast, command unchanged', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on)
  const shown = toasts(on)
  const reached = bash(on)

  const input = { tool: 'Bash', command: 'pnpm test', description: 'run tests' } as const
  await $.tool.call(input)

  expect(shown.length).toBe(1)
  expect(shown[0]).toContain('/Users/u/work/other')
  expect(reached.length).toBe(1)
  expect(reached[0]).toEqual(expect.objectContaining(input))

  // Within five minutes: no second snapshot, no second toast, still passed on.
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(calls.filter(one => one.includes('echo ---')).length).toBe(1)
  expect(shown.length).toBe(1)
  expect(reached.length).toBe(2)

  // After five minutes it may warn again.
  await clock.advance(5 * 60_000)
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(shown.length).toBe(2)
  expect(reached.length).toBe(3)
})

test('only own tests running: no toast', async ($, on) => {
  mock.clock(on, { now: NOW })
  host(on, PS_ALONE)
  const shown = toasts(on)
  const reached = bash(on)

  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  expect(shown).toEqual([])
  expect(reached.length).toBe(1)
})

test('a command that is not a test runs no ps at all', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on)
  const reached = bash(on)

  await $.tool.call({ tool: 'Bash', command: 'cat vitest.config.ts' })
  expect(calls).toEqual([])
  expect(reached).toEqual([expect.objectContaining({ command: 'cat vitest.config.ts' })])
})

test('ps failing never blocks or changes the command', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('process.run', () => ({ deny: 'ps is not available' }))
  const shown = toasts(on)
  const reached = bash(on)

  const result = await $.tool.call({ tool: 'Bash', command: 'pnpm -r test' })
  expect(shown).toEqual([])
  expect(reached).toEqual([expect.objectContaining({ command: 'pnpm -r test' })])
  expect(result.deny).toBeUndefined()
})

for (const [name, cache, measures] of [
  ['fresh cache is read, not measured', { mtimeMs: NOW - 10_000, text: JSON.stringify(SAMPLE) }, false],
  ['stale cache is measured and written', { mtimeMs: NOW - 31_000, text: JSON.stringify(SAMPLE) }, true],
  ['missing cache is measured and written', {}, true],
  ['broken cache is measured and written', { mtimeMs: NOW - 1000, text: '{"at":1,"ram' }, true],
  [
    'a cache written before installed RAM was stored is measured and written',
    { mtimeMs: NOW - 1000, text: '{"at":1,"ramBytes":2,"swapBytes":3}' },
    true,
  ],
] as const) {
  test(name, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const calls = host(on)
    const writes = sessionHost(on, cache)

    await startSession($)
    await clock.settle()

    expect(calls.filter(one => one.includes('vm_stat')).length).toBe(measures ? 1 : 0)
    expect(writes.length).toBe(measures ? 1 : 0)
    expect(calls.every(one => one.includes('vm_stat'))).toBe(true)
    expect((await bandText($, 'terminal'))?.text).toContain('alert >20 (auto)')
  })
}

test('the band samples again every 60 s, and only vm_stat + sysctl run', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on)
  sessionHost(on, {})

  await startSession($)
  await clock.settle()
  await clock.advance(60_000)
  await clock.advance(60_000)

  expect(calls.length).toBe(3)
  expect(calls.every(one => one.includes('vm_stat') && one.includes('hw.memsize'))).toBe(true)
})

test('the band keeps sampling after /clear ends the session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on)
  sessionHost(on, {})
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await startSession($)
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(60_000)

  expect(calls.filter(one => one.includes('vm_stat')).length).toBe(2)
})

test('band: automatic threshold (1.25 × 16 GB = 20), red above it, on terminal and desktop', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const text = await bandText($, surface)
    expect(text?.text).toBe('watch-my-ram · 34.6 GB in use · RAM 12.8/16 + swap 21.8 · alert >20 (auto)')
    expect(text?.props.wrap).toBe('truncate-end')
    expect(text?.props.color).toBe('error')
    expect(text?.props.dimColor).toBeUndefined()
  }
})

test('band: a threshold set in /config wins and drops "(auto)"', { options: { threshold_gb: 40 } }, async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const text = await bandText($, surface)
    expect(text?.text).toBe('watch-my-ram · 34.6 GB in use · RAM 12.8/16 + swap 21.8 · alert >40')
    expect(text?.props.color).toBeUndefined()
    expect(text?.props.dimColor).toBe(true)
  }
})

test('band: 0 in /config means automatic', { options: { threshold_gb: 0 } }, async ($, on) => {
  seed(on)
  expect((await bandText($, 'terminal'))?.text).toContain('alert >20 (auto)')
})

for (const [pressure, name, color] of [
  [1, 'normal', undefined],
  [2, 'warning', 'warning'],
  [4, 'critical', 'error'],
] as const) {
  test(`band: macOS pressure ${name} decides the colour, whatever the GB total`, async ($, on) => {
    seed(on, { ...SAMPLE, pressure })
    for (const surface of ['terminal', 'desktop'] as const) {
      const text = await bandText($, surface)
      expect(text?.text).toBe(`watch-my-ram · 34.6 GB in use · RAM 12.8/16 + swap 21.8 · pressure ${name}`)
      expect(text?.props.color).toBe(color)
      expect(text?.props.dimColor).toBe(color === undefined ? true : undefined)
    }
  })
}

test('band: a GB threshold from /config overrides pressure', { options: { threshold_gb: 40 } }, async ($, on) => {
  seed(on, { ...SAMPLE, pressure: 4 })
  const text = await bandText($, 'terminal')
  expect(text?.text).toBe('watch-my-ram · 34.6 GB in use · RAM 12.8/16 + swap 21.8 · alert >40')
  expect(text?.props.color).toBeUndefined()
})

test('the measure reads the pressure level, and the band shows it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls: string[] = []
  on('process.run', (_, e) => {
    calls.push(e.argv.join(' '))

    return ran(MEASUREMENT_WITH_PRESSURE)
  })
  sessionHost(on, {})

  await startSession($)
  await clock.settle()

  expect(calls.length).toBe(1)
  expect(calls[0]).toContain('kern.memorystatus_vm_pressure_level')
  const text = await bandText($, 'terminal')
  expect(text?.text).toContain('pressure warning')
  expect(text?.props.color).toBe('warning')
})

test('band: a value stored by an older version is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { at: 1, ramBytes: 1, swapBytes: 1 }, version: 1 } }))
  expect((await bandText($, 'terminal'))?.text).toBe('watch-my-ram · measuring…')
})

test('/watch-my-ram where Desktop places no pane answers with the text tables and closes the undrawn pane', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on)
  const closes: string[] = []
  sessionHost(on, {}, { isPlaced: false, surfaces: ['desktop'] }, closes)

  await startSession($)
  const { text } = await runRollCall($)
  expect(closes).toEqual(['watch-my-ram'])

  expect(text).toContain('Memory: 34.6 GB in use (RAM 12.8 of 16 GB + swap 21.8 GB) · alert above 20 GB (auto) · OVER')
  expect(text).toContain('MERGED #12  ~/work/other')
  expect(text).toContain('~/work/mine  (this session)')
  expect(text).toContain('~/work/desk')
  expect(text).toContain('Claude sessions: 3 ')
  expect(text).toContain('5173  900  node  ~/work/other')
  expect(text).toContain('3000  800  node  ~/x')
  // An app's own node backend with cwd / is no dev port.
  expect(text).not.toContain('7265')
  expect(text).toContain('Dev ports listening: 2')
  // Footprint, not RSS, for the sessions footprint could read.
  expect(text).toContain('500  1h0m  360M   -')
  // gh only for the folder on a feature branch.
  expect(calls.filter(one => /^\S*gh /.test(one)).length).toBe(1)
})

test('/watch-my-ram still answers when ps fails', async ($, on) => {
  mock.clock(on, { now: NOW })
  sessionHost(on, {})
  on('process.run', (_, e) => (e.argv.join(' ').includes('vm_stat') ? ran(MEASUREMENT) : { deny: 'not available' }))

  await startSession($)
  const { text } = await runRollCall($)

  expect(text).toContain('Memory: 34.6 GB in use')
  expect(text).toContain('Claude sessions: 0 ')
})

test('/watch-my-ram on Desktop opens a read-only pane: tables, MERGED highlighted, Refresh, Ask Claude, Close', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on)
  const opens: unknown[] = []
  sessionHost(on, {}, { isPlaced: true, opens })
  const gathered = () => calls.filter(one => one.includes('echo ---')).length

  await startSession($)
  const { text } = await runRollCall($)
  expect(text).toBe('Opened the watch-my-ram pane. Close it with its Close button.')
  // Esc closes it too, once the pane has the focus.
  expect(opens).toEqual([expect.objectContaining({ closeOnEscape: true })])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const memory = await ui.find({ type: 'Text', text: /^Memory:/ })
    expect(memory?.text).toContain('· OVER')
    expect(memory?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: /MERGED #12/ }))?.props.color).toBe('merged')
    expect((await ui.find({ type: 'Text', text: /this session/ }))?.props.bold).toBe(true)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(one => one.props.label)).toEqual(['Refresh', 'Ask Claude for suggestions', 'Close'])

    // Refresh gathers the tables again.
    const before = gathered()
    await ui.press({ key: 'refresh' })
    expect(gathered()).toBe(before + 1)
    await ui.unmount()
  }
})

test('pane open: tables refresh by themselves every 5 min, gh answers reused for 10 min', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on)
  sessionHost(on, {}, { isPlaced: true, isOpen: true })
  const gathered = () => calls.filter(one => one.includes('echo ---')).length
  const ghCalls = () => calls.filter(one => /^\S*gh /.test(one)).length

  await startSession($)
  await runRollCall($)
  expect(gathered()).toBe(1)
  expect(ghCalls()).toBe(1)

  // The 60 s ticks before the tables are 5 min old gather nothing.
  for (let i = 0; i < 4; i += 1) await clock.advance(60_000)
  expect(gathered()).toBe(1)

  // The fifth does; gh is still cached (5 min < 10 min).
  await clock.advance(60_000)
  expect(gathered()).toBe(2)
  expect(ghCalls()).toBe(1)

  // Five more minutes: the tables again, and gh asked again (10 min passed).
  for (let i = 0; i < 5; i += 1) await clock.advance(60_000)
  expect(gathered()).toBe(3)
  expect(ghCalls()).toBe(2)
})

test('pane closed: the 60 s tick never gathers the tables', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on)
  sessionHost(on, {}, { isPlaced: true, isOpen: false })

  await startSession($)
  for (let i = 0; i < 6; i += 1) await clock.advance(60_000)

  expect(calls.every(one => one.includes('vm_stat'))).toBe(true)
})

test('pane before any data: memory not measured yet, tables gathering, Refresh and Close but nothing to ask yet', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Memory:/ }))?.text).toBe('Memory: not measured yet')
    expect(await ui.find({ type: 'Text', text: /Gathering/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).map(one => one.props.label)).toEqual(['Refresh', 'Close'])
    await ui.unmount()
  }
})

test('narrow pane: the memory line wraps instead of losing "alert above … (auto)"', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 50 } })
  const memory = await ui.find({ type: 'Text', text: /^Memory:/ })
  expect(memory?.props.wrap).toBe('wrap')
  expect(memory?.text).toContain('alert above 20 GB (auto) · OVER')
  await ui.unmount()
})

test('two Refresh presses at once gather the tables once', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on)
  sessionHost(on, {}, { isPlaced: true })
  const gathered = () => calls.filter(one => one.includes('echo ---')).length

  await startSession($)
  await runRollCall($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = gathered()
  await Promise.all([ui.press({ key: 'refresh' }), ui.press({ key: 'refresh' })])
  expect(gathered()).toBe(before + 1)
  await ui.unmount()
})

test('band: short enough to sit beside what Claude Code draws on its row', async ($, on) => {
  seed(on)
  const text = (await bandText($, 'terminal'))?.text ?? ''
  expect(text.length).toBeLessThanOrEqual(78)
})

test('pane: the session table shows before gh answers, PR cells "…", then filled', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on, PS, () => clock.sleep(1500))
  sessionHost(on, {}, { isPlaced: true })

  await startSession($)
  const running = runRollCall($)
  await clock.settle()

  // gh is still out: the table is drawn already, its PR cells waiting.
  expect(calls.some(one => /^\S*gh /.test(one))).toBe(true)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Claude sessions: 3 / }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\d+ +600 .*…/ }))).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /MERGED/ })).toBeUndefined()
  await ui.unmount()

  await clock.advance(1500)
  expect((await running).text).toBe('Opened the watch-my-ram pane. Close it with its Close button.')
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /MERGED #12/ }))?.props.color).toBe('merged')
  expect(await ui.find({ type: 'Text', text: /…/ })).toBeUndefined()
  await ui.unmount()
})

test('PRs: one gh pr list per repository with a feature branch, not one call per folder', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on)
  sessionHost(on, {})

  await startSession($)
  await runRollCall($)

  expect(calls.filter(one => /^\S*gh pr list /.test(one)).length).toBe(1)
  expect(calls.filter(one => /^\S*gh pr view /.test(one))).toEqual([])
  expect(calls.filter(one => one.includes('--git-common-dir')).length).toBe(1)
})

test('31 sessions: the pane asks for rows, keeps orphans and ports above the table, and says how to scroll in a terminal', async ($, on) => {
  mock.clock(on, { now: NOW })
  host(on, PS_31)
  const opens: unknown[] = []
  sessionHost(on, {}, { isPlaced: true, opens })

  await startSession($)
  await runRollCall($)
  expect(opens).toEqual([expect.objectContaining({ id: 'watch-my-ram', rows: 40 })])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    const at = (pattern: RegExp) => texts.findIndex(text => pattern.test(text))
    expect(at(/^Claude sessions: 31 /)).toBeGreaterThan(at(/^Orphan dev processes/))
    expect(at(/^Claude sessions: 31 /)).toBeGreaterThan(at(/Dev ports listening/))
    // The keyboard hint is a terminal's; Desktop scrolls the pane with the mouse.
    expect(at(/ctrl\+x tab\), then ↑\/↓/)).toBe(surface === 'terminal' ? at(/^Claude sessions: 31 /) + 1 : -1)
    // Every session is in the tree; the engine scrolls what the frame cannot show.
    expect(texts.filter(text => /^ *\d+ +\d+ +\S+ +\d+M/.test(text)).length).toBe(31 + 2)
    await ui.unmount()
  }
})

/** Two repos; two worktrees of the hub on different branches. */
const TWO_REPOS: Record<string, [repo: string, branch: string]> = {
  '/Users/u/work/mine': ['/r/orph', 'feat/pane'],
  '/Users/u/work/other': ['/r/hub', 'feat/x'],
  '/Users/u/work/desk': ['/r/hub', 'feat/y'],
}

/** gh per repo: the hub's list in the hub, this mod's own repo in its folder. */
const twoReposGh: GhAnswer = (argv, cwd) =>
  argv[2] !== 'list'
    ? ran('', 1)
    : ran(cwd === '/Users/u/work/mine' ? JSON.stringify([{ number: 1, state: 'OPEN', headRefName: 'feat/pane' }]) : PR_LIST)

test('PRs: one gh call per repository; two worktrees of one repo matched by their own branch', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on, PS, undefined, TWO_REPOS, twoReposGh)
  sessionHost(on, {})

  await startSession($)
  const { text } = await runRollCall($)

  expect(calls.filter(one => /^\S*gh pr list /.test(one)).length).toBe(2)
  expect(text).toMatch(/MERGED #12 +~\/work\/other/)
  expect(text).toMatch(/#11 +~\/work\/desk/)
  expect(text).toMatch(/#1 +~\/work\/mine/)
})

test('PRs: a failed gh is not cached; the next refresh asks again', async ($, on) => {
  mock.clock(on, { now: NOW })
  let isDown = true
  const calls = host(on, PS, undefined, REPOS, argv => (isDown ? ran('', 1) : plainGh(argv, undefined)))
  sessionHost(on, {})
  const ghCalls = () => calls.filter(one => /^\S*gh pr list /.test(one)).length

  await startSession($)
  expect((await runRollCall($)).text).not.toContain('MERGED #12')
  isDown = false
  expect((await runRollCall($)).text).toContain('MERGED #12')
  expect(ghCalls()).toBe(2)
})

test('PRs: a refresh within 10 min asks gh nothing and draws known PRs at once, no "…"', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls = host(on, PS, () => clock.sleep(1500))
  sessionHost(on, {}, { isPlaced: true })
  const ghCalls = () => calls.filter(one => /^\S*gh /.test(one)).length

  await startSession($)
  const first = runRollCall($)
  await clock.advance(1500)
  await first
  expect(ghCalls()).toBe(1)

  // Refresh: the first write already holds the known PR, and gh is not asked.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(ghCalls()).toBe(1)
  expect((await ui.find({ type: 'Text', text: /MERGED #12/ }))?.props.color).toBe('merged')
  expect(await ui.find({ type: 'Text', text: /  …  / })).toBeUndefined()
  await ui.unmount()
})

test('PRs: a list that hits its 200 limit falls back to gh pr view for an unmatched branch, once', async ($, on) => {
  mock.clock(on, { now: NOW })
  const full = JSON.stringify(
    Array.from({ length: 200 }, (_, i) => ({ number: 1000 + i, state: 'MERGED', headRefName: `old/${i}` })),
  )
  const gh: GhAnswer = argv =>
    argv[2] === 'list' ? ran(full) : argv[3] === 'feat/x' ? ran('{"number":12,"state":"MERGED"}') : ran('', 1)
  const calls = host(on, PS, undefined, REPOS, gh)
  sessionHost(on, {})
  const views = () => calls.filter(one => /^\S*gh pr view /.test(one)).length

  await startSession($)
  expect((await runRollCall($)).text).toContain('MERGED #12  ~/work/other')
  expect(views()).toBe(1)
  await runRollCall($)
  expect(views()).toBe(1)
})

test('the index column is in the pane too, numbering rows in the order shown, styled like its row', async ($, on) => {
  mock.clock(on, { now: NOW })
  host(on)
  sessionHost(on, {}, { isPlaced: true })

  await startSession($)
  await runRollCall($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^#  PID  AGE/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^1  500 .*this session/ }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^2  600 .*MERGED #12/ }))?.props.color).toBe('merged')
    await ui.unmount()
  }
})

/** The engine's prompt box: records suggestions and submitted prompts. */
function promptBox(on: On) {
  const suggested: string[] = []
  const submitted: { text: string; asUser?: boolean }[] = []
  on('prompt.suggest', (_, e) => {
    suggested.push(e.text)

    return { isShown: true }
  })
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, asUser: e.origin?.kind === 'plugin' ? e.origin.asUser : undefined })

    return { text: e.text }
  })

  return { suggested, submitted }
}

test('/watch-my-ram in a terminal answers in the chat, gives Claude the roll-call, then suggests asking for advice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on)
  const opens: unknown[] = []
  // A pane could be placed, but a terminal gets the chat answer: its buttons may not take clicks.
  sessionHost(on, {}, { isPlaced: true, opens, surfaces: ['terminal'] })
  const box = promptBox(on)

  await startSession($)
  const answer = await runRollCall($)
  expect(opens).toEqual([])
  expect(answer.text).toContain('Memory: 34.6 GB in use')
  expect(answer.text).toContain('MERGED #12  ~/work/other')

  // Claude reads the same roll-call, with the advice-only rule beside it.
  expect(answer.context).toHaveLength(1)
  expect(answer.context?.[0]).toContain(answer.text)
  expect(answer.context?.[0]).toContain('give advice only')

  // The suggestion waits until the answer is drawn.
  expect(box.suggested).toEqual([])
  await clock.advance(500)
  expect(box.suggested).toEqual([
    'Suggest what I could clean up from the watch-my-ram roll-call above. Advice only: do not run, stop or close anything.',
  ])
  expect(box.submitted).toEqual([])
})

test('pane: Close closes it, and Ask Claude sends the roll-call shown with an advice-only request', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = host(on)
  const closes: string[] = []
  sessionHost(on, {}, { isPlaced: true }, closes)
  const box = promptBox(on)

  await startSession($)
  await runRollCall($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = calls.length

  await ui.press({ key: 'ask' })
  expect(box.submitted).toHaveLength(1)
  const [asked] = box.submitted
  expect(asked?.asUser).toBe(true)
  expect(asked?.text).toContain('Here is my current watch-my-ram roll-call:')
  expect(asked?.text).toContain('Memory: 34.6 GB in use')
  expect(asked?.text).toContain('MERGED #12  ~/work/other')
  expect(asked?.text).toContain('This is advice only: do not run any command, and do not stop, close, kill or delete anything.')
  // Asking runs nothing on the machine.
  expect(calls.length).toBe(before)

  await ui.press({ key: 'close' })
  expect(closes).toEqual(['watch-my-ram'])
  await ui.unmount()
})

test('band: Desktop gets a Hide button (a terminal has its own [-]); /watch-my-ram shows the band again', async ($, on) => {
  mock.clock(on, { now: NOW })
  host(on)
  sessionHost(on, {}, { isPlaced: true })
  // The engine beneath: with nothing handed to it, it draws an empty band.
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as never)
  await startSession($)

  // A terminal: the line alone.
  const inTerminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await inTerminal.findAll({ type: 'Button' })).toEqual([])
  await inTerminal.unmount()

  // Desktop: the line and Hide.
  const onDesktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await onDesktop.find({ type: 'Text' }))?.text).toContain('34.6 GB in use')
  expect((await onDesktop.findAll({ type: 'Button' })).map(one => one.props.label)).toEqual(['Hide'])
  await onDesktop.press({ key: 'hide' })
  await onDesktop.unmount()

  // Hidden, on every surface, until the command runs.
  for (const surface of ['terminal', 'desktop'] as const) expect(await bandText($, surface)).toBeUndefined()
  await runRollCall($)
  expect((await bandText($, 'desktop'))?.text).toContain('34.6 GB in use')
})

test('band: the mascot follows pressure, as a text face on terminal and an animated SVG on desktop', async ($, on) => {
  seed(on, { ...SAMPLE, pressure: 4 })
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /ﾟДﾟ/ }))?.props.color).toBe('error')
  await terminal.unmount()
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('RAM mascot, panicking')
  expect(svg?.props.isInteractive).toBe(true)
  await desktop.unmount()
})
