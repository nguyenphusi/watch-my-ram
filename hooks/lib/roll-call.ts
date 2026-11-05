// The roll-call: parsers for lsof's and footprint's output, the view the pane
// and the text answer both draw, and the refresh rules. Pure functions; the
// command hook gathers the inputs.

import type { RollLine, RollView, Sample } from '../../types'
import { alertWord, formatUsage, resolveThreshold } from './memory'
import type { Proc } from './processes'

/** The roll-call tables refresh on their own at most this often while the pane is open. */
export const TABLE_REFRESH_MS = 5 * 60_000
/** How long one `gh pr view` answer is reused for a folder and branch. */
export const PR_CACHE_MS = 10 * 60_000

/** Commands whose listening ports count as dev servers. */
const DEV_PORT_COMMANDS = new Set([
  'node', 'bun', 'deno', 'tsx', 'vite', 'vitest', 'esbuild', 'workerd',
  'python', 'python3', 'Python', 'ruby', 'php',
])

/** `lsof -a -d cwd -Fn -p …` → pid → cwd. */
export function parseLsofCwd(text: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined) cwds.set(pid, line.slice(1))
  }

  return cwds
}

export type ListenPort = { pid: number; command: string; port: number }

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → dev-server ports, one per pid and port. */
export function parseLsofListen(text: string): ListenPort[] {
  const ports = new Map<string, ListenPort>()
  let pid = 0
  let command = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n') && DEV_PORT_COMMANDS.has(command)) {
      const port = Number(/:(\d+)$/.exec(line)?.[1])
      if (Number.isInteger(port)) ports.set(`${pid}:${port}`, { pid, command, port })
    }
  }

  return [...ports.values()].sort((a, b) => a.port - b.port)
}

/**
 * `footprint --noCategories -f bytes -p … -p …` → pid → footprint in KiB.
 *
 * Footprint is what top's MEM and Activity Monitor's Memory show: it still
 * counts pages macOS compressed or swapped out, which RSS drops, so a session
 * left idle for days reads tens of MB in RSS while holding hundreds.
 */
export function parseFootprint(text: string): Map<number, number> {
  const sizes = new Map<number, number>()
  for (const match of text.matchAll(/\[(\d+)\]:.*?Footprint:\s+(\d+) B/g)) {
    sizes.set(Number(match[1]), Number(match[2]) / 1024)
  }

  return sizes
}

/**
 * Whether a working directory looks like a project: not `/`, not the home
 * folder itself, and not under an app or system location. A port's owner
 * with such a cwd (or under a Claude session) counts as a dev server; an
 * app's helper (Raycast's backend runs node with cwd `/`) does not.
 */
export function isProjectFolder(cwd: string | undefined, home: string | undefined): boolean {
  if (cwd === undefined || cwd === '/' || cwd === home) return false
  const outside = ['/Applications/', '/System/', '/Library/', '/usr/', '/private/', '/opt/']
  if (home !== undefined) outside.push(`${home}/Library/`, `${home}/Applications/`)

  return !outside.some(prefix => `${cwd}/`.startsWith(prefix))
}

export type PrState = { number: number; state: string }

/**
 * One shell run for every folder: its repository (the git common dir, shared
 * by all worktrees of a repo) and its branch, one tab-separated line each.
 * Folders reach the shell as arguments, never as part of the script.
 */
export function repoArgv(folders: readonly string[]): string[] {
  return [
    '/bin/sh',
    '-c',
    'for d; do c=$(/usr/bin/git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue; ' +
      'b=$(/usr/bin/git -C "$d" branch --show-current 2>/dev/null); printf "%s\\t%s\\t%s\\n" "$d" "$c" "$b"; done',
    'sh',
    ...folders,
  ]
}

export type FolderRepo = { folder: string; repo: string; branch: string }

/** The output of `repoArgv` → folder, repo and branch per line; lines that do not parse are left out. */
export function parseRepoLines(text: string): FolderRepo[] {
  return text.split('\n').flatMap(line => {
    const [folder = '', repo = '', branch = ''] = line.split('\t')

    return folder !== '' && repo !== '' ? [{ folder, repo, branch }] : []
  })
}

/** Branches worth a PR lookup: not empty (detached), not main or master. */
export const isFeatureBranch = (branch: string): boolean => branch !== '' && branch !== 'main' && branch !== 'master'

/**
 * `gh pr list --state all --json number,state,headRefName` → branch → PR.
 * Several PRs from one branch: the newest (highest number) wins.
 */
export function parsePrList(json: string): Map<string, PrState> {
  const byBranch = new Map<string, PrState>()
  try {
    const list: unknown = JSON.parse(json)
    if (!Array.isArray(list)) return byBranch
    for (const item of list as Record<string, unknown>[]) {
      const { number, state, headRefName } = item
      if (typeof number !== 'number' || typeof state !== 'string' || typeof headRefName !== 'string') continue
      const known = byBranch.get(headRefName)
      if (known === undefined || known.number < number) byBranch.set(headRefName, { number, state })
    }
  } catch {
    // Not JSON: no PRs known for this repo.
  }

  return byBranch
}

/** How many entries a `gh pr list --json` answer holds; 0 for anything not a list. */
export function countPrs(json: string): number {
  try {
    const list: unknown = JSON.parse(json)

    return Array.isArray(list) ? list.length : 0
  } catch {
    return 0
  }
}

/** Whether the tables are due for an automatic refresh: open, and none yet or older than 5 min. */
export function isTableStale(isPaneOpen: boolean, lastAt: number | undefined, now: number): boolean {
  return isPaneOpen && (lastAt === undefined || now - lastAt >= TABLE_REFRESH_MS)
}

/** Whether a cached `gh pr view` answer for a folder and branch can be reused. */
export function isPrCacheFresh(cachedAt: number | undefined, now: number): boolean {
  return cachedAt !== undefined && now - cachedAt >= 0 && now - cachedAt < PR_CACHE_MS
}

export type SessionRow = {
  pid: number
  ageSec: number
  rssKb: number
  folder: string | undefined
  isSelf: boolean
  prNumber?: number
  isMerged: boolean
  /** True while gh has not answered for this folder yet: the PR cell reads `…` instead of `-`. */
  isPrPending?: boolean
}

export type RollInput = {
  at: number
  sessions: SessionRow[]
  orphans: Proc[]
  /** Dev-server ports with the folder they serve: their session's, or their own cwd. */
  ports: (ListenPort & { folder?: string })[]
  /** Footprint per pid in KiB; a pid missing here falls back to its RSS, marked `*`. */
  memoryKb: ReadonlyMap<number, number>
  home: string | undefined
}

export function formatAge(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`

  return `${m}m`
}

/** A short name for an orphan: headless browsers by kind, the rest by executable. */
function orphanName(proc: Proc): string {
  return /chrom(e|ium)/i.test(proc.args) && /--headless/.test(proc.args) ? 'chromium --headless' : proc.exec
}

const mb = (kb: number): string => `${Math.round(kb / 1024)}M`

function shorten(path: string | undefined, home: string | undefined): string {
  if (path === undefined) return '?'

  return home !== undefined && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/**
 * Aligned text columns, led by a `#` column counting the rows 1, 2, 3 … in
 * the order given, right-aligned to the widest index.
 */
function table(cells: readonly string[], body: readonly (readonly string[])[]): string[] {
  const indexWidth = Math.max(1, String(body.length).length)
  const header = ['#'.padStart(indexWidth), ...cells]
  const rows = body.map((row, i) => [String(i + 1).padStart(indexWidth), ...row])
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map(row => (row[i] ?? '').length)))
  const line = (row: readonly string[]): string =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ')

  return [line(header), ...rows.map(line)]
}

/** The tables, as lines ready to draw: sessions by RAM, largest first. */
export function buildRollView(input: RollInput): RollView {
  const { at, sessions, orphans, ports, memoryKb, home } = input
  let hasRss = false
  const memOf = (pid: number, rssKb: number): number => memoryKb.get(pid) ?? rssKb
  const memCell = (pid: number, rssKb: number): string => {
    const footprint = memoryKb.get(pid)
    if (footprint !== undefined) return mb(footprint)
    hasRss = true

    return `${mb(rssKb)}*`
  }

  const sorted = [...sessions].sort((a, b) => memOf(b.pid, b.rssKb) - memOf(a.pid, a.rssKb))
  const sessionCells = sorted.map(one => [
    String(one.pid),
    formatAge(one.ageSec),
    memCell(one.pid, one.rssKb),
    one.isMerged ? `MERGED #${one.prNumber ?? '?'}` : one.prNumber !== undefined ? `#${one.prNumber}` : one.isPrPending === true ? '…' : '-',
    `${shorten(one.folder, home)}${one.isSelf ? '  (this session)' : ''}`,
  ])
  const [sessionHeader = '', ...sessionRows] = table(['PID', 'AGE', 'RAM', 'PR', 'FOLDER'], sessionCells)
  const merged = sessions.filter(one => one.isMerged).length
  const totalKb = sessions.reduce((sum, one) => sum + memOf(one.pid, one.rssKb), 0)

  const orphanLines: RollLine[] =
    orphans.length === 0
      ? []
      : table(
          ['PID', 'AGE', 'RAM', 'NAME'],
          orphans.map(one => [String(one.pid), formatAge(one.ageSec), memCell(one.pid, one.rssKb), orphanName(one)]),
        ).map(text => ({ text }))
  const portLines: RollLine[] =
    ports.length === 0
      ? []
      : table(
          ['PORT', 'PID', 'NAME', 'FOLDER'],
          ports.map(one => [String(one.port), String(one.pid), one.command, shorten(one.folder, home)]),
        ).map(text => ({ text }))

  return {
    at,
    sessions: {
      title: `Claude sessions: ${sessions.length} (${mb(totalKb)} RAM, ${merged} with a merged PR)`,
      lines: [
        { text: sessionHeader },
        ...sessionRows.map((text, i) => ({
          text,
          isMerged: sorted[i]?.isMerged === true,
          isSelf: sorted[i]?.isSelf === true,
        })),
      ],
    },
    orphans: { title: `Orphan dev processes (parent died): ${orphans.length}`, lines: orphanLines },
    ports: { title: `Dev ports listening: ${ports.length}`, lines: portLines },
    notes: [
      'RAM is memory footprint, as top MEM and Activity Monitor show it.',
      ...(hasRss ? ['* RSS: footprint could not be read; RSS leaves out compressed and swapped pages, so it reads low.'] : []),
      'watch-my-ram only reports; it never stops anything.',
    ],
  }
}

/** `Memory: 32.9 GB in use (…) · macOS memory pressure warning · WARNING` */
export function memoryLine(sample: Sample | undefined | null, option: unknown): string {
  if (sample === undefined || sample === null) return 'Memory: not measured yet'
  const threshold = resolveThreshold(option, sample.installedBytes)

  return `Memory: ${formatUsage(sample, threshold)} · ${alertWord(sample, threshold)}`
}

/** The text answer, where no pane can be drawn: the same lines as the pane. */
export function formatRollCall(view: RollView, memory: string): string {
  const section = (part: { title: string; lines: RollLine[] }): string[] => [
    '',
    part.title,
    ...part.lines.map(one => one.text),
  ]

  // The short sections first, as in the pane, so the long session table comes last.
  return [memory, ...section(view.orphans), ...section(view.ports), ...section(view.sessions), '', ...view.notes].join('\n')
}

/** Offered dim in the empty prompt box after a roll-call in the chat; Tab takes it. */
export const SUGGESTED_PROMPT =
  'Suggest what I could clean up from the watch-my-ram roll-call above. Advice only: do not run, stop or close anything.'

/** What Claude reads (and the person does not see) beside a roll-call shown in the chat. */
export function rollCallContext(rollCall: string): string {
  return [
    'The user just ran /watch-my-ram. Its roll-call, for reference:',
    '',
    rollCall,
    '',
    'watch-my-ram only reads. If the user asks what to clean up, give advice only: do not run commands or stop, close, kill or delete anything unless they explicitly ask you to.',
  ].join('\n')
}

/** The prompt the pane's "Ask Claude" button sends: the roll-call on screen and a request for advice only. */
export function askClaudePrompt(rollCall: string): string {
  return [
    'Here is my current watch-my-ram roll-call:',
    '',
    rollCall,
    '',
    'Based only on this, suggest what I could close or stop to free memory, biggest win first. For each item, say what it is, roughly how much memory it would free, and how I would do it myself.',
    'This is advice only: do not run any command, and do not stop, close, kill or delete anything.',
  ].join('\n')
}
