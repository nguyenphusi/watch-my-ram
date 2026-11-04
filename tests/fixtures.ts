// Trimmed samples of the commands the mod reads. Paths and pids are made up;
// the shapes match what macOS prints.

export const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3544.
Pages active:                                 164238.
Pages inactive:                               160368.
Pages wired down:                             194322.
Pages stored in compressor:                  3617769.
Pages occupied by compressor:                 481328.
`

export const SWAP = 'total = 23552.00M  used = 22320.94M  free = 1231.06M  (encrypted)\n'

/** `sysctl -n hw.memsize` of a 16 GB Mac. */
export const MEMSIZE_16 = '17179869184\n'

/** vm_stat + swap + installed RAM: RAM 12.8 of 16 GB, swap 21.8 GB, 34.6 GB in use. */
export const MEASUREMENT = VM_STAT + SWAP + MEMSIZE_16

const DESKTOP_CLAUDE =
  '/Users/u/Library/Application Support/Claude/claude-code/2.1.317/claude.app/Contents/MacOS/claude'
const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

type Row = [pid: number, ppid: number, rss: number, etime: string, comm: string, args: string]

/**
 * This session is claude 500. Another session (600) runs vitest (611); this
 * session has its own background vitest (701) and a shell that only mentions
 * vitest (700); 702 is `rg vitest` run by Claude Desktop's session (650); 660
 * is the browser extension's native host, not a session.
 */
const ROWS: Row[] = [
  [1, 0, 6576, '15-06:48:48', '/sbin/launchd', '/sbin/launchd'],
  [400, 1, 4000, '01:10:00', '/bin/zsh', '/bin/zsh -l'],
  [500, 400, 200000, '01:00:00', 'claude', 'claude'],
  [600, 1, 150000, '02-03:00:00', '/Users/u/.local/bin/claude', '/Users/u/.local/bin/claude --resume'],
  [610, 600, 3000, '02:00', '/bin/zsh', '/bin/zsh -c pnpm test'],
  [611, 610, 90000, '01:59', 'node', 'node /Users/u/work/other/node_modules/.bin/vitest run'],
  [650, 1, 120000, '03:00:00', DESKTOP_CLAUDE, `${DESKTOP_CLAUDE} --output-format stream-json`],
  [660, 1, 3000, '01:00:00', '/Users/u/.local/bin/claude', '/Users/u/.local/bin/claude --chrome-native-host'],
  [700, 500, 3000, '00:30', '/bin/zsh', '/bin/zsh -c cat vitest.config.ts'],
  [701, 500, 80000, '00:20', 'node', 'node /Users/u/work/mine/node_modules/vitest/vitest.mjs run'],
  [702, 650, 2000, '00:05', '/opt/homebrew/bin/rg', 'rg vitest src'],
  [800, 1, 60000, '05:00', 'node', 'node /Users/u/x/server.js'],
  [801, 1, 70000, '04:00', CHROME, `${CHROME} --headless=new`],
  [900, 600, 50000, '10:00', 'node', 'node /Users/u/work/other/node_modules/.bin/vite'],
]

/** What the snapshot shell prints: `$PPID`, `pid comm` lines, `---`, `pid ppid rss etime args` lines. */
function snapshotText(rows: readonly Row[]): string {
  const pad = (value: number | string, width: number): string => String(value).padStart(width)

  return [
    '500',
    ...rows.map(([pid, , , , comm]) => `${pad(pid, 5)} ${comm}`),
    '---',
    ...rows.map(
      ([pid, ppid, rss, etime, , args]) => `${pad(pid, 5)} ${pad(ppid, 5)} ${pad(rss, 6)} ${pad(etime, 11)} ${args}`,
    ),
    '',
  ].join('\n')
}

export const PS = snapshotText(ROWS)

/** The same machine with 28 more idle sessions: 31 in all, as on the Owner's Mac. */
export const PS_31 = snapshotText([
  ...ROWS,
  ...Array.from({ length: 28 }, (_, i): Row => [
    1000 + i,
    1,
    40000 + i * 1000,
    '1-02:00:00',
    '/Users/u/.local/bin/claude',
    '/Users/u/.local/bin/claude',
  ]),
])

/** Same machine with no other session's test running. */
export const PS_ALONE = snapshotText(ROWS.filter(([pid]) => pid !== 611))

export const LSOF_CWD = `p500
fcwd
n/Users/u/work/mine
p600
fcwd
n/Users/u/work/other
p650
fcwd
n/Users/u/work/desk
p800
fcwd
n/Users/u/x
p908
fcwd
n/
`

/**
 * 900 is vite under session 600; 800 an orphan node server in a project
 * folder; 908 an app's own node backend (cwd `/`, like Raycast's), which is
 * no dev server.
 */
export const LSOF_LISTEN = `p800
cnode
f21
n*:3000
p900
cnode
f20
n*:5173
p908
cnode
f142
n127.0.0.1:7265
p950
cControlCe
f9
n*:7000
`

/**
 * `footprint --noCategories -f bytes -p …`, trimmed. 500 and 600 hold far
 * more than their RSS (pages compressed or swapped out); 650 and the orphans
 * are missing, as for a process footprint cannot read.
 */
export const FOOTPRINT = `======================================================================
claude [500]: 64-bit    Footprint: 377487360 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 377487360 B
    phys_footprint_peak: 513181160 B

======================================================================
claude [600]: 64-bit    Footprint: 326107136 B (16384 bytes per page)
======================================================================
footprint: Unable to find pid for process matching '650'
`
