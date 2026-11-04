import { describe, expect, test } from 'claude-code/testing'

import {
  GB,
  formatBand,
  formatUsage,
  isFresh,
  isOver,
  parseInstalledBytes,
  parseMeasurement,
  parseSample,
  parseSwapUsedBytes,
  parseVmStatRamBytes,
  resolveThreshold,
} from '../hooks/lib/memory'
import {
  ancestry,
  claudeSessions,
  folderFromArgs,
  orphanDevProcesses,
  otherSessionTests,
  parseEtime,
  parseSnapshot,
  sessionPid,
} from '../hooks/lib/processes'
import {
  PR_CACHE_MS,
  TABLE_REFRESH_MS,
  buildRollView,
  countPrs,
  formatRollCall,
  isFeatureBranch,
  parsePrList,
  parseRepoLines,
  repoArgv,
  isPrCacheFresh,
  isProjectFolder,
  isTableStale,
  memoryLine,
  parseFootprint,
  parseLsofCwd,
  parseLsofListen,
} from '../hooks/lib/roll-call'
import { canToast, isTestCommand } from '../hooks/lib/test-command'
import { FOOTPRINT, LSOF_CWD, LSOF_LISTEN, MEASUREMENT, MEMSIZE_16, PS, PS_ALONE, SWAP, VM_STAT } from './fixtures'

describe('test command detection', () => {
  const matches = [
    'vitest',
    'npx vitest run src/a.test.ts',
    'pnpm test',
    'pnpm test:e2e',
    'pnpm -r test',
    'pnpm --filter web test',
    'pnpm -r --filter=./apps/* test:unit',
    'cd apps/web && pnpm test',
    'CI=1 npx playwright test',
    'npm run test:unit',
    'npm test',
    'yarn test',
    'pnpm exec vitest --run',
    'pnpm vitest',
    './node_modules/.bin/vitest run',
    '(cd web; pnpm test) 2>&1 | tail -20',
    'npm t',
    'timeout 600 pnpm test',
    'nohup pnpm test:e2e',
    'npx vitest@3 run',
    'yarn workspace web test',
  ]
  const misses = [
    'cat vitest.config.ts',
    'rg vitest src',
    'grep -r playwright .',
    'pnpm install',
    'npx playwright install chromium',
    'echo pnpm test',
    'git commit -m "test: add cases"',
    'ls tests',
    'pnpm build',
    'vim playwright.config.ts',
  ]

  test('starts of test runs match', () => {
    for (const command of matches) expect([command, isTestCommand(command)]).toEqual([command, true])
  })

  test('commands that only mention a test tool do not match', () => {
    for (const command of misses) expect([command, isTestCommand(command)]).toEqual([command, false])
  })
})

describe('memory', () => {
  test('vm_stat: active + wired + occupied by compressor, times page size', () => {
    expect(parseVmStatRamBytes(VM_STAT)).toBe((164238 + 194322 + 481328) * 16384)
  })

  test('swapusage: used, in MiB', () => {
    expect(parseSwapUsedBytes(SWAP)).toBe(22320.94 * 1024 ** 2)
    expect(parseSwapUsedBytes('total = 0.00M  used = 0.00M  free = 0.00M')).toBe(0)
  })

  test('installed RAM from hw.memsize', () => {
    expect(parseInstalledBytes(MEMSIZE_16)).toBe(16 * GB)
    expect(parseInstalledBytes(VM_STAT + SWAP)).toBeUndefined()
  })

  test('band text says what is in use, the installed RAM, and that the threshold is an alert level', () => {
    const sample = parseMeasurement(MEASUREMENT, 1)
    expect(sample).toBeDefined()
    expect(formatUsage(sample!, { gb: 20, isAuto: true })).toBe(
      '34.6 GB in use (RAM 12.8 of 16 GB + swap 21.8 GB) · alert above 20 GB (auto)',
    )
    expect(formatUsage(sample!, { gb: 24.5, isAuto: false })).toBe(
      '34.6 GB in use (RAM 12.8 of 16 GB + swap 21.8 GB) · alert above 24.5 GB',
    )
  })

  test('band short form: about 60 characters, same numbers', () => {
    const sample = parseMeasurement(MEASUREMENT, 1)!
    const band = formatBand(sample, { gb: 20, isAuto: true })
    expect(band).toBe('34.6 GB in use · RAM 12.8/16 + swap 21.8 · alert >20 (auto)')
    expect(`watch-my-ram · ${band}`.length).toBeLessThanOrEqual(78)
    expect(formatBand(sample, { gb: 24.5, isAuto: false })).toBe('34.6 GB in use · RAM 12.8/16 + swap 21.8 · alert >24.5')
  })

  test('unreadable output gives no sample', () => {
    expect(parseMeasurement('garbage', 1)).toBeUndefined()
    expect(parseMeasurement(VM_STAT, 1)).toBeUndefined()
    expect(parseMeasurement(VM_STAT + SWAP, 1)).toBeUndefined()
  })

  test('over only when strictly above the threshold', () => {
    const at = (gb: number) => ({ at: 0, ramBytes: gb * GB, swapBytes: 0, installedBytes: 16 * GB })
    const twenty = { gb: 20, isAuto: true }
    expect(isOver(at(20.1), twenty)).toBe(true)
    expect(isOver(at(20), twenty)).toBe(false)
    expect(isOver(at(12), twenty)).toBe(false)
    expect(isOver(at(34.6), { gb: 40, isAuto: false })).toBe(false)
  })

  test('automatic threshold: 1.25 × installed RAM', () => {
    expect(resolveThreshold(undefined, 16 * GB)).toEqual({ gb: 20, isAuto: true })
    expect(resolveThreshold(undefined, 8 * GB)).toEqual({ gb: 10, isAuto: true })
    expect(resolveThreshold(undefined, 18 * GB)).toEqual({ gb: 22.5, isAuto: true })
    expect(resolveThreshold(undefined, 24 * GB)).toEqual({ gb: 30, isAuto: true })
  })

  test('a positive value from /config wins', () => {
    expect(resolveThreshold(32, 8 * GB)).toEqual({ gb: 32, isAuto: false })
    expect(resolveThreshold(12.5, 16 * GB)).toEqual({ gb: 12.5, isAuto: false })
    expect(resolveThreshold('24', 16 * GB)).toEqual({ gb: 24, isAuto: false })
    // Shown and compared at the same one decimal.
    expect(resolveThreshold(20.25, 16 * GB)).toEqual({ gb: 20.3, isAuto: false })
  })

  test('0, empty, negative or text means automatic', () => {
    for (const option of [0, 0.04, '', '  ', -5, 'x', 'auto', Number.NaN, null]) {
      expect([option, resolveThreshold(option, 8 * GB)]).toEqual([option, { gb: 10, isAuto: true }])
    }
  })
})

describe('cache file', () => {
  test('fresh within half the 60 s period, stale after', () => {
    expect(isFresh(1000, 1000 + 29_999)).toBe(true)
    expect(isFresh(1000, 1000 + 30_000)).toBe(false)
    expect(isFresh(5000, 1000)).toBe(false)
  })

  test('broken or partial JSON is no sample', () => {
    expect(parseSample('{"at":1,"ramBytes":2,"swapBytes":3,"installedBytes":4}')).toEqual({
      at: 1,
      ramBytes: 2,
      swapBytes: 3,
      installedBytes: 4,
    })
    // Written by the version before installed RAM was stored: measured again.
    expect(parseSample('{"at":1,"ramBytes":2,"swapBytes":3}')).toBeUndefined()
    expect(parseSample('{"at":1,"ramB')).toBeUndefined()
    expect(parseSample('')).toBeUndefined()
    expect(parseSample('null')).toBeUndefined()
    expect(parseSample('{"at":1,"ramBytes":"2","swapBytes":3}')).toBeUndefined()
  })
})

describe('process tree', () => {
  const snapshot = parseSnapshot(PS)

  test('etime', () => {
    expect(parseEtime('02-03:00:00')).toBe(2 * 86400 + 3 * 3600)
    expect(parseEtime('01:00:00')).toBe(3600)
    expect(parseEtime('01:59')).toBe(119)
    expect(parseEtime('?')).toBe(0)
  })

  test('the session is the claude process above the shell', () => {
    expect(sessionPid(snapshot)).toBe(500)
    expect(ancestry(snapshot.procs, 701)).toEqual([701, 500, 400])
  })

  test('own tests are left out, the other session is named by its folder', () => {
    expect(otherSessionTests(snapshot)).toEqual([{ pid: 611, sessionPid: 600, folder: '/Users/u/work/other' }])
  })

  test('a process that only mentions vitest is not a test', () => {
    expect(otherSessionTests(snapshot).some(one => one.pid === 702)).toBe(false)
  })

  test('sessions: Desktop path with spaces counts, the browser native host does not', () => {
    expect(claudeSessions(snapshot).map(one => one.pid)).toEqual([500, 600, 650])
  })

  test('npx cache folder names no project', () => {
    expect(folderFromArgs('node /Users/u/.npm/_npx/ab12/node_modules/.bin/vitest run')).toBeUndefined()
  })

  test('nothing else running: no other tests', () => {
    expect(otherSessionTests(parseSnapshot(PS_ALONE))).toEqual([])
  })

  test('orphans: dev processes under launchd only', () => {
    expect(orphanDevProcesses(snapshot).map(one => one.pid)).toEqual([800, 801])
  })
})

describe('roll-call', () => {
  test('lsof parsers', () => {
    expect(parseLsofCwd(LSOF_CWD).get(650)).toBe('/Users/u/work/desk')
    expect(parseLsofCwd(LSOF_CWD).get(908)).toBe('/')
    expect(parseLsofListen(LSOF_LISTEN)).toEqual([
      { pid: 800, command: 'node', port: 3000 },
      { pid: 900, command: 'node', port: 5173 },
      { pid: 908, command: 'node', port: 7265 },
    ])
  })

  test('footprint: per pid in KiB, missing pids left out', () => {
    expect([...parseFootprint(FOOTPRINT)]).toEqual([
      [500, 377487360 / 1024],
      [600, 326107136 / 1024],
    ])
    expect(parseFootprint('')).toEqual(new Map())
  })

  test('project folders: not /, home, apps or system locations', () => {
    const home = '/Users/u'
    expect(isProjectFolder('/Users/u/x', home)).toBe(true)
    expect(isProjectFolder('/Users/u/work/web', home)).toBe(true)
    expect(isProjectFolder('/', home)).toBe(false)
    expect(isProjectFolder('/Users/u', home)).toBe(false)
    expect(isProjectFolder('/Applications/Raycast Beta.app/Contents', home)).toBe(false)
    expect(isProjectFolder('/Users/u/Library/Application Support/x', home)).toBe(false)
    expect(isProjectFolder(undefined, home)).toBe(false)
  })

  const input = () => {
    const snapshot = parseSnapshot(PS)

    return {
      at: 5,
      sessions: [
        { pid: 650, ageSec: 10800, rssKb: 120000, folder: '/Users/u/work/desk', isSelf: false, isMerged: false },
        { pid: 500, ageSec: 3600, rssKb: 200000, folder: '/Users/u/work/mine', isSelf: true, isMerged: false },
        { pid: 600, ageSec: 183600, rssKb: 150000, folder: '/Users/u/work/other', isSelf: false, prNumber: 12, isMerged: true },
      ],
      orphans: orphanDevProcesses(snapshot),
      ports: [
        { pid: 800, command: 'node', port: 3000, folder: '/Users/u/x' },
        { pid: 900, command: 'node', port: 5173, folder: '/Users/u/work/other' },
      ],
      memoryKb: parseFootprint(FOOTPRINT),
      home: '/Users/u',
    }
  }

  test('view: sessions by RAM footprint, largest first, MERGED and this session flagged', () => {
    const view = buildRollView(input())
    expect(view.at).toBe(5)
    expect(view.sessions.lines.map(line => [...line.text.trim().split(/\s+/, 2), line.isMerged, line.isSelf])).toEqual([
      ['#', 'PID', undefined, undefined],
      ['1', '500', false, true],
      ['2', '600', true, false],
      ['3', '650', false, false],
    ])
  })

  test('memory line: same wording as the band, with ok or OVER', () => {
    const sample = parseMeasurement(MEASUREMENT, 1)
    expect(memoryLine(sample, undefined)).toBe(
      'Memory: 34.6 GB in use (RAM 12.8 of 16 GB + swap 21.8 GB) · alert above 20 GB (auto) · OVER',
    )
    expect(memoryLine(sample, 40)).toBe('Memory: 34.6 GB in use (RAM 12.8 of 16 GB + swap 21.8 GB) · alert above 40 GB · ok')
    expect(memoryLine(undefined, undefined)).toBe('Memory: not measured yet')
  })

  test('text table from a fixture: footprint where read, RSS marked where not', () => {
    const text = formatRollCall(buildRollView(input()), memoryLine(parseMeasurement(MEASUREMENT, 1), undefined))
    expect(text).toBe(
      [
        'Memory: 34.6 GB in use (RAM 12.8 of 16 GB + swap 21.8 GB) · alert above 20 GB (auto) · OVER',
        '',
        'Orphan dev processes (parent died): 2',
        '#  PID  AGE  RAM   NAME',
        '1  800  5m   59M*  node',
        '2  801  4m   68M*  chromium --headless',
        '',
        'Dev ports listening: 2',
        '#  PORT  PID  NAME  FOLDER',
        '1  3000  800  node  ~/x',
        '2  5173  900  node  ~/work/other',
        '',
        'Claude sessions: 3 (788M RAM, 1 with a merged PR)',
        '#  PID  AGE   RAM    PR          FOLDER',
        '1  500  1h0m  360M   -           ~/work/mine  (this session)',
        '2  600  2d3h  311M   MERGED #12  ~/work/other',
        '3  650  3h0m  117M*  -           ~/work/desk',
        '',
        'RAM is memory footprint, as top MEM and Activity Monitor show it.',
        '* RSS: footprint could not be read; RSS leaves out compressed and swapped pages, so it reads low.',
        'watch-my-ram only reports; it never stops anything.',
      ].join('\n'),
    )
  })

  test('index column: starts at 1, follows the shown order, widens at 10 rows', () => {
    const base = input()
    const many = Array.from({ length: 12 }, (_, i) => ({
      pid: 2000 + i,
      ageSec: 60,
      rssKb: (100 - i) * 1024,
      folder: `/Users/u/w${i}`,
      isSelf: false,
      isMerged: false,
    }))
    const lines = buildRollView({ ...base, sessions: many, memoryKb: new Map() }).sessions.lines.map(one => one.text)
    expect(lines[0]?.startsWith(' #  PID')).toBe(true)
    expect(lines[1]?.startsWith(' 1  2000')).toBe(true)
    expect(lines[9]?.startsWith(' 9  2008')).toBe(true)
    expect(lines[10]?.startsWith('10  2009')).toBe(true)
    expect(lines[12]?.startsWith('12  2011')).toBe(true)
    // Fewer than 10 rows: a one-character column.
    expect(buildRollView(base).sessions.lines[1]?.text.startsWith('1  500')).toBe(true)
  })

  test('a PR cell reads "…" while gh has not answered for its folder, "-" once it has', () => {
    const base = input()
    const pending = buildRollView({ ...base, sessions: base.sessions.map(one => ({ ...one, isPrPending: true })) })
    expect(pending.sessions.lines[1]?.text).toContain('  …  ')
    // A known PR shows even while others are pending.
    expect(pending.sessions.lines[2]?.text).toContain('MERGED #12')
    expect(buildRollView(base).sessions.lines[1]?.text).toContain('  -  ')
  })

  test('countPrs: entries of a list answer, 0 for anything else', () => {
    expect(countPrs('[{"number":1},{"number":2}]')).toBe(2)
    expect(countPrs('{"a":1}')).toBe(0)
    expect(countPrs('oops')).toBe(0)
  })

  test('repo lines: folder, git common dir and branch; broken lines left out', () => {
    const repo = '/r/hub/.git'
    const text = [`/w/a\t${repo}\tfeat/x`, `/w/b\t${repo}\t`, 'not a line', '', '/w/c\t/r/orph\tmain'].join('\n')
    expect(parseRepoLines(text)).toEqual([
      { folder: '/w/a', repo, branch: 'feat/x' },
      { folder: '/w/b', repo, branch: '' },
      { folder: '/w/c', repo: '/r/orph', branch: 'main' },
    ])
  })

  test('repo shell run: folders go in as arguments, never into the script', () => {
    const argv = repoArgv(['/w/a b', '/w/$(rm -rf x)'])
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(argv[2]).not.toContain('/w/')
    expect(argv.slice(3)).toEqual(['sh', '/w/a b', '/w/$(rm -rf x)'])
  })

  test('feature branches only: not main, master or detached', () => {
    expect(['feat/x', 'main', 'master', ''].map(isFeatureBranch)).toEqual([true, false, false, false])
  })

  test('gh pr list: branch → newest PR; anything not a list gives none', () => {
    const json = JSON.stringify([
      { number: 9, state: 'CLOSED', headRefName: 'feat/x' },
      { number: 12, state: 'MERGED', headRefName: 'feat/x' },
      { number: 11, state: 'OPEN', headRefName: 'feat/y' },
      { number: 'x', state: 'OPEN', headRefName: 'feat/z' },
    ])
    expect([...parsePrList(json)]).toEqual([
      ['feat/x', { number: 12, state: 'MERGED' }],
      ['feat/y', { number: 11, state: 'OPEN' }],
    ])
    expect(parsePrList('not json').size).toBe(0)
    expect(parsePrList('{"a":1}').size).toBe(0)
  })

  test('refresh rules: tables every 5 min while open, gh answers for 10 min', () => {
    expect(isTableStale(false, undefined, 0)).toBe(false)
    expect(isTableStale(true, undefined, 0)).toBe(true)
    expect(isTableStale(true, 0, TABLE_REFRESH_MS - 1)).toBe(false)
    expect(isTableStale(true, 0, TABLE_REFRESH_MS)).toBe(true)
    expect(isTableStale(false, 0, TABLE_REFRESH_MS * 10)).toBe(false)
    expect(isPrCacheFresh(undefined, 0)).toBe(false)
    expect(isPrCacheFresh(0, PR_CACHE_MS - 1)).toBe(true)
    expect(isPrCacheFresh(0, PR_CACHE_MS)).toBe(false)
  })
})

describe('toast limit', () => {
  test('one toast per five minutes', () => {
    expect(canToast(undefined, 0)).toBe(true)
    expect(canToast(0, 299_999)).toBe(false)
    expect(canToast(0, 300_000)).toBe(true)
  })
})
