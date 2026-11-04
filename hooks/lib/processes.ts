// One `ps` snapshot, read into a table of processes. Pure functions.
//
// The snapshot is one shell run printing three parts:
//   1. `$PPID`: the pid that started the shell (the session's own claude);
//   2. `pid comm` per process: comm is the executable's full path, kept whole
//      even with spaces (Claude Desktop's lives under "Application Support");
//   3. after a `---` line, `pid ppid rss etime args` per process.

export type Proc = {
  pid: number
  ppid: number
  rssKb: number
  ageSec: number
  args: string
  /** Basename of the executable (comm), e.g. `claude`, `node`. */
  exec: string
}

export type Snapshot = { selfPpid: number | undefined; procs: Map<number, Proc> }

/** The argv the mod runs for a snapshot. */
export const PS_ARGV = [
  '/bin/sh',
  '-c',
  'echo $PPID; /bin/ps -axww -o pid=,comm=; echo ---; exec /bin/ps -axww -o pid=,ppid=,rss=,etime=,args=',
] as const

const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/

/** `[[dd-]hh:]mm:ss` → seconds; 0 when unreadable. */
export function parseEtime(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (match === null) return 0
  const [, d = '0', h = '0', m = '0', s = '0'] = match

  return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s)
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export function parseSnapshot(text: string): Snapshot {
  const lines = text.split('\n')
  const first = Number(lines[0]?.trim())
  const split = lines.indexOf('---')
  const comms = new Map<number, string>()
  for (const line of lines.slice(1, Math.max(split, 1))) {
    const match = /^\s*(\d+)\s(.+)$/.exec(line)
    if (match !== null) comms.set(Number(match[1]), match[2]?.trim() ?? '')
  }
  const procs = new Map<number, Proc>()
  for (const line of lines.slice(split + 1)) {
    const match = LINE.exec(line)
    if (match === null) continue
    const [, pid, ppid, rss, etime = '', args = ''] = match
    procs.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      ageSec: parseEtime(etime),
      args,
      exec: basename(comms.get(Number(pid)) ?? args.trimStart().split(/\s+/, 1)[0] ?? ''),
    })
  }

  return { selfPpid: Number.isInteger(first) && first > 0 ? first : undefined, procs }
}

export const isClaude = (proc: Proc): boolean => proc.exec === 'claude'

/** pid and every ancestor of it, nearest first, stopping at launchd. */
export function ancestry(procs: Map<number, Proc>, pid: number): number[] {
  const chain: number[] = []
  let current = procs.get(pid)
  while (current !== undefined && !chain.includes(current.pid)) {
    chain.push(current.pid)
    if (current.ppid <= 1) break
    current = procs.get(current.ppid)
  }

  return chain
}

/** The nearest claude process at or above pid; undefined when none. */
export function claudeAbove(procs: Map<number, Proc>, pid: number): number | undefined {
  return ancestry(procs, pid).find(one => {
    const proc = procs.get(one)

    return proc !== undefined && isClaude(proc)
  })
}

/** This session's claude pid: the nearest claude at or above the shell's parent. */
export function sessionPid(snapshot: Snapshot): number | undefined {
  const { selfPpid, procs } = snapshot
  if (selfPpid === undefined) return undefined

  return claudeAbove(procs, selfPpid) ?? selfPpid
}

const TEST_RUNTIMES = new Set(['node', 'bun', 'deno', 'vitest', 'playwright'])
const TEST_ARGS =
  /(?:^|[\s/])(?:vitest|playwright)(?:\.m?js)?(?=\s|$)|vitest\/dist\/|@playwright\/test\/cli|playwright\/cli\.js/

/** A running vitest or playwright process (not `rg vitest`, a shell or an editor). */
export function isTestProcess(proc: Proc): boolean {
  return TEST_RUNTIMES.has(proc.exec) && TEST_ARGS.test(proc.args)
}

/** The project folder in a script path: everything before its dependency folder. */
export function folderFromArgs(args: string): string | undefined {
  const folder = /(\/\S*?)\/node_modules\//.exec(args)?.[1]

  // An npx cache folder names no project.
  return folder?.includes('/_npx/') ? undefined : folder
}

export type OtherTest = { pid: number; sessionPid: number | undefined; folder: string | undefined }

/**
 * Test processes that are not under this session: one entry per other session
 * (or per stray test with no session above it).
 */
export function otherSessionTests(snapshot: Snapshot): OtherTest[] {
  const self = sessionPid(snapshot)
  const seen = new Map<string, OtherTest>()
  for (const proc of snapshot.procs.values()) {
    if (!isTestProcess(proc)) continue
    const chain = ancestry(snapshot.procs, proc.pid)
    if (self !== undefined && chain.includes(self)) continue
    const owner = claudeAbove(snapshot.procs, proc.pid)
    const key = owner === undefined ? `pid:${proc.pid}` : `session:${owner}`
    if (!seen.has(key)) {
      seen.set(key, { pid: proc.pid, sessionPid: owner, folder: folderFromArgs(proc.args) })
    }
  }

  return [...seen.values()]
}

const ORPHAN_EXECS = new Set(['node', 'tsx', 'vite', 'vitest', 'playwright'])

/** Dev processes whose parent died (re-parented to launchd, PPID 1). */
export function orphanDevProcesses(snapshot: Snapshot): Proc[] {
  return [...snapshot.procs.values()].filter(
    proc =>
      proc.ppid === 1 &&
      (ORPHAN_EXECS.has(proc.exec) ||
        (/chrom(e|ium)/i.test(proc.args) && /--headless/.test(proc.args))),
  )
}

/** Claude sessions, without the browser extension's native-host helper. */
export function claudeSessions(snapshot: Snapshot): Proc[] {
  return [...snapshot.procs.values()].filter(
    proc => isClaude(proc) && !proc.args.includes('--chrome-native-host'),
  )
}
