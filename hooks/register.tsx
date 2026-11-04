// orphanage: warns when the Mac runs out of memory and shows who holds it.
// It only reads (vm_stat, sysctl, ps, footprint, lsof, git, gh) and draws; it
// never blocks, rewrites or stops a command, a process or a session.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { RollView, Sample } from '../types'
import { SAMPLE_PERIOD_MS, formatBand, isFresh, isOver, parseMeasurement, parseSample, resolveThreshold } from './lib/memory'
import {
  PS_ARGV,
  claudeAbove,
  claudeSessions,
  orphanDevProcesses,
  otherSessionTests,
  parseSnapshot,
  sessionPid,
} from './lib/processes'
import type { Snapshot } from './lib/processes'
import {
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
} from './lib/roll-call'
import type { FolderRepo, PrState, SessionRow } from './lib/roll-call'
import { canToast, isTestCommand } from './lib/test-command'

type $ = EngineInterface

const COMMAND = 'orphanage'
const PANE = 'orphanage'
/** Rows asked for an inline pane: about a screenful of sessions. */
const PANE_ROWS = 40
/** How many PRs one `gh pr list` asks for; a full list falls back to `gh pr view` for unmatched branches. */
const PR_LIST_LIMIT = 200
const MEASURE_ARGV = ['/bin/sh', '-c', '/usr/bin/vm_stat; /usr/sbin/sysctl -n vm.swapusage hw.memsize'] as const

// The shape tags decline what an earlier version stored, which a reload keeps.
const sampleState = atom({ plugin: 'orphanage', key: 'sample' } as const, null, { shape: 'sample-2' })
const rollState = atom({ plugin: 'orphanage', key: 'roll' } as const, null, { shape: 'roll-1' })

// Module state: a reload starts these over, which costs at most one extra
// sample, toast or `gh` call. The sample and the tables live in `$.state`.
let thresholdOption: unknown
let inFlight: Promise<Sample | undefined> | undefined
let rollInFlight: Promise<RollView> | undefined
let lastToastAt: number | undefined
let tick: Timer | undefined
/**
 * Per repository (git common dir): branch → PR as gh listed it at `at`;
 * `isFull` when the list hit its limit, `viewed` the branches asked alone since.
 */
const prCache = new Map<string, { at: number; byBranch: Map<string, PrState>; isFull: boolean; viewed: Set<string> }>()
/** Per folder, the last PR answer drawn (null: none), so a refresh redraws it at once instead of `…`. */
const knownPrs = new Map<string, PrState | null>()

async function cacheFile($: $): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home === undefined ? undefined : `${home}/.claude/orphanage/sample.json`
}

async function measure($: $, now: number): Promise<Sample | undefined> {
  const ran = await $.process.run(MEASURE_ARGV, { timeoutMs: 5000 })

  return parseMeasurement(ran.stdout, now)
}

/**
 * Reads the shared cache when another session wrote it within the period,
 * otherwise measures and writes it; the result goes into `$.state`, which
 * redraws the band. `force` skips the cache (the roll-call wants it now).
 */
async function refresh($: $, force = false): Promise<Sample | undefined> {
  // One sample at a time: a caller arriving mid-sample shares its result,
  // even a forced caller (that result is at most one cache period old).
  inFlight ??= sample($, force).finally(() => {
    inFlight = undefined
  })

  return inFlight
}

async function sample($: $, force: boolean): Promise<Sample | undefined> {
  try {
    const path = await cacheFile($)
    const now = await $.clock.now()
    let found: Sample | undefined
    if (!force && path !== undefined) {
      const stat = await $.fs.stat(path).catch(() => undefined)
      if (stat !== undefined && isFresh(stat.mtimeMs, now)) {
        found = parseSample(await $.fs.read(path).catch(() => ''))
      }
    }
    if (found === undefined) {
      found = await measure($, now)
      if (found !== undefined && path !== undefined) {
        await $.fs.write(path, JSON.stringify(found)).catch(() => undefined)
      }
    }
    if (found !== undefined) {
      const fresh = found
      await update($, sampleState, () => fresh)
    }

    return found
  } catch {
    return undefined
  }
}

/** Every 60 s: the memory sample; and, while the pane is open, the tables once they are 5 min old. */
async function onTick($: $): Promise<void> {
  await refresh($)
  try {
    const isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    const view = await read($, rollState)
    if (isTableStale(isPaneOpen, view?.at, await $.clock.now())) await refreshRoll($)
  } catch {
    // No surface, or the tables failed: the pane keeps what it shows.
  }
}

async function runLsofCwd($: $, pids: string) {
  return $.process
    .run(['/usr/sbin/lsof', '-a', '-d', 'cwd', '-Fn', '-p', pids], { timeoutMs: 10_000 })
    .catch(() => undefined)
}

async function snapshot($: $, timeoutMs: number): Promise<Snapshot> {
  return parseSnapshot((await $.process.run(PS_ARGV, { timeoutMs })).stdout)
}

/** The roll-call tables, gathered now (one gathering at a time) and kept in `$.state` for the pane. */
async function refreshRoll($: $): Promise<RollView> {
  rollInFlight ??= gatherRoll($).finally(() => {
    rollInFlight = undefined
  })

  return rollInFlight
}

async function gatherRoll($: $): Promise<RollView> {
  const [snap, home, now] = await Promise.all([
    // A failed ps still answers: the tables are then just empty.
    snapshot($, 10_000).catch(() => parseSnapshot('')),
    $.env.get('HOME'),
    $.clock.now(),
  ])
  const sessions = claudeSessions(snap)
  const orphans = orphanDevProcesses(snap)
  const self = sessionPid(snap)
  const pids = sessions.map(one => one.pid).join(',')
  const memoryPids = [...sessions, ...orphans].map(one => String(one.pid))
  const [cwdRun, listenRun, footprintRun] = await Promise.all([
    pids === '' ? undefined : runLsofCwd($, pids),
    $.process.run(['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 10_000 }).catch(() => undefined),
    memoryPids.length === 0
      ? undefined
      : $.process
          .run(['/usr/bin/footprint', '--noCategories', '-f', 'bytes', ...memoryPids.flatMap(pid => ['-p', pid])], {
            timeoutMs: 10_000,
          })
          .catch(() => undefined),
  ])
  const cwds = parseLsofCwd(cwdRun?.stdout ?? '')
  const listening = parseLsofListen(listenRun?.stdout ?? '')
  // A port's owner outside every session needs its own cwd to judge it.
  const loose = [...new Set(listening.map(port => port.pid))].filter(pid => claudeAbove(snap.procs, pid) === undefined)
  const looseCwds = parseLsofCwd((loose.length === 0 ? undefined : await runLsofCwd($, loose.join(',')))?.stdout ?? '')
  const ports = listening.flatMap(port => {
    const owner = claudeAbove(snap.procs, port.pid)
    if (owner !== undefined) return [{ ...port, folder: cwds.get(owner) }]
    const cwd = looseCwds.get(port.pid)

    return isProjectFolder(cwd, home) ? [{ ...port, folder: cwd }] : []
  })
  /** `isFinal` false: a folder with no answer yet reads `…`; true: it reads `-`. */
  const viewWith = (isFinal: boolean): RollView =>
    buildRollView({
      at: now,
      sessions: sessions.map((one): SessionRow => {
        const folder = cwds.get(one.pid)
        const pr = folder === undefined ? undefined : knownPrs.get(folder)

        return {
          pid: one.pid,
          ageSec: one.ageSec,
          rssKb: one.rssKb,
          folder,
          isSelf: one.pid === self,
          prNumber: pr?.number,
          isMerged: pr?.state === 'MERGED',
          isPrPending: !isFinal && folder !== undefined && !knownPrs.has(folder),
        }
      }),
      orphans,
      ports,
      memoryKb: parseFootprint(footprintRun?.stdout ?? ''),
      home,
    })

  // Draw the tables now with the PRs already known (new folders as `…`);
  // gh (about 1.5 s per repo) fills the rest after.
  const early = viewWith(false)
  await update($, rollState, () => early)
  const folders = [...new Set(cwds.values())]
  const found = await folderPrs($, folders, now)
  for (const folder of folders) knownPrs.set(folder, found.get(folder) ?? null)
  const view = viewWith(true)
  await update($, rollState, () => view)

  return view
}

export const register: Register = (on, options) => {
  thresholdOption = options.threshold_gb

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Roll-call pane: live Claude sessions, merged PRs, orphan dev processes, dev ports, memory in use',
    })
    void refresh($)
    tick?.cancel()
    tick = $.clock.every(SAMPLE_PERIOD_MS, () => void onTick($))

    return next(e)
  })

  // No session.end hook: it also fires on /clear, after which no
  // session.start comes, so cancelling there would freeze the band. A reload
  // drops the timers itself.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Text } = $.ui.resolve(e)
    const sample = await read($, sampleState)
    if (sample === null) return <Text dimColor>orphanage · measuring…</Text>
    const threshold = resolveThreshold(thresholdOption, sample.installedBytes)
    const text = `orphanage · ${formatBand(sample, threshold)}`

    // Short, and cut rather than wrapped where the terminal is narrower still.
    return isOver(sample, threshold) ? (
      <Text color="error" wrap="truncate-end">
        {text}
      </Text>
    ) : (
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    )
  })

  // Read only: the one control is Refresh; nothing here acts on a process.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [sample, view] = await Promise.all([read($, sampleState), read($, rollState)])
    const isRed = sample !== null && isOver(sample, resolveThreshold(thresholdOption, sample.installedBytes))
    const section = (part: RollView['sessions']) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{part.title}</Text>
        {part === view?.sessions && (
          <Text dimColor wrap="truncate-end">
            If rows are cut off: focus the pane (ctrl+x tab), then ↑/↓ or the mouse wheel.
          </Text>
        )}
        {part.lines.map((line, i) => (
          <Text
            wrap="truncate-end"
            dimColor={i === 0}
            bold={line.isSelf === true}
            color={line.isMerged === true ? 'merged' : undefined}
          >
            {line.text}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {/* Refresh sits on the first row: an inline pane shows only its top rows until scrolled. */}
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => void refreshRoll($).catch(() => undefined)} />
        </Box>
        {/* Wraps rather than truncates, so "alert above N GB" stays readable in a narrow pane. */}
        <Text wrap="wrap" color={isRed ? 'error' : undefined}>
          {memoryLine(sample, thresholdOption)}
        </Text>
        {view === null ? (
          <Text dimColor>Gathering sessions, processes and ports…</Text>
        ) : (
          <Box flexDirection="column">
            {/* The short sections first: an unscrolled inline pane still shows them. Both empty: one row. */}
            {view.orphans.lines.length === 0 && view.ports.lines.length === 0 ? (
              <Text wrap="truncate-end">
                {view.orphans.title} · {view.ports.title}
              </Text>
            ) : (
              <Box flexDirection="column">
                {section(view.orphans)}
                {section(view.ports)}
              </Box>
            )}
            {section(view.sessions)}
            <Box flexDirection="column" marginTop={1}>
              {view.notes.map(note => (
                <Text dimColor wrap="truncate-end">
                  {note}
                </Text>
              ))}
              <Text dimColor wrap="truncate-end">
                Tables refresh on open, on Refresh, and every 5 min while this pane is open.
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: COMMAND }, async $ => {
    // Ask for a tall inline pane; the surface gives what the layout spares and the rest scrolls.
    const opened = await $.ui.open({ id: PANE, title: 'orphanage', rows: PANE_ROWS })
    if (opened.isPlaced) {
      await Promise.all([refresh($, true), refreshRoll($)])

      return { text: 'Opened the orphanage pane.' }
    }
    // No pane here (`claude -p`, a surface that places none): answer in text.
    await $.ui.close({ id: PANE }).catch(() => undefined)
    const [fresh, view] = await Promise.all([refresh($, true), refreshRoll($)])
    // A failed measure still has the last 60 s sample to show.
    const shown = fresh ?? (await read($, sampleState))

    return { text: formatRollCall(view, memoryLine(shown, thresholdOption)) }
  })

  // Warn only: whatever happens here, the command goes on exactly as given.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      if (isTestCommand(e.command)) {
        const now = await $.clock.now()
        if (canToast(lastToastAt, now)) {
          const others = otherSessionTests(await snapshot($, 3000))
          const first = others[0]
          if (first !== undefined) {
            lastToastAt = now
            const where = first.folder ?? `pid ${first.pid}`
            const more = others.length > 1 ? ` (+${others.length - 1} more)` : ''
            $.ui.toast(
              `Tests are already running in ${where}${more}. Parallel test runs heat the Mac; yours will run anyway.`,
              { timeoutMs: 8000 },
            )
          }
        }
      }
    } catch {
      // A failed check must never touch the command.
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}

/**
 * The PR of each folder's current branch: one shell run maps every folder to
 * its repository and branch, then one `gh pr list` per repository (all at
 * once) answers every branch of it. Each repository's list is reused for
 * 10 min. Folders on main/master, detached, or without a PR are left out.
 */
async function folderPrs($: $, folders: readonly string[], now: number): Promise<Map<string, PrState>> {
  const found = new Map<string, PrState>()
  if (folders.length === 0) return found
  // Two git calls per folder in one run: generous time, as heavy swap slows every spawn.
  const ran = await $.process.run(repoArgv(folders), { timeoutMs: 30_000 }).catch(() => undefined)
  const byRepo = new Map<string, FolderRepo[]>()
  for (const one of parseRepoLines(ran?.stdout ?? '')) {
    if (isFeatureBranch(one.branch)) byRepo.set(one.repo, [...(byRepo.get(one.repo) ?? []), one])
  }
  await Promise.all(
    [...byRepo].map(async ([repo, members]) => {
      let cached = prCache.get(repo)
      if (!isPrCacheFresh(cached?.at, now)) {
        const listed = await listPrs($, members[0]?.folder ?? '').catch(() => undefined)
        // A failed gh is not cached, so the next refresh asks again.
        if (listed === undefined) return
        cached = { at: now, ...listed, viewed: new Set() }
        prCache.set(repo, cached)
      }
      const entry = cached
      if (entry === undefined) return
      for (const one of members) {
        // A full list may have cut an old PR off: ask for that branch alone, once per cache period.
        if (!entry.byBranch.has(one.branch) && entry.isFull && !entry.viewed.has(one.branch)) {
          entry.viewed.add(one.branch)
          const pr = await viewPr($, one.branch, one.folder).catch(() => undefined)
          if (pr !== undefined) entry.byBranch.set(one.branch, pr)
        }
        const pr = entry.byBranch.get(one.branch)
        if (pr !== undefined) found.set(one.folder, pr)
      }
    }),
  )

  return found
}

async function listPrs($: $, folder: string): Promise<{ byBranch: Map<string, PrState>; isFull: boolean } | undefined> {
  const listed = await runGh(
    $,
    ['pr', 'list', '--state', 'all', '--json', 'number,state,headRefName', '--limit', String(PR_LIST_LIMIT)],
    folder,
  )
  if (listed.exitCode !== 0) return undefined
  const byBranch = parsePrList(listed.stdout)

  return { byBranch, isFull: countPrs(listed.stdout) >= PR_LIST_LIMIT }
}

/** `gh pr view <branch>`: the fallback for a branch older than the newest 200 PRs. */
async function viewPr($: $, branch: string, folder: string): Promise<PrState | undefined> {
  const view = await runGh($, ['pr', 'view', branch, '--json', 'number,state'], folder)
  if (view.exitCode !== 0) return undefined
  const pr = JSON.parse(view.stdout) as Partial<PrState>

  return typeof pr.number === 'number' && typeof pr.state === 'string' ? { number: pr.number, state: pr.state } : undefined
}

/**
 * `gh` by PATH, then at Homebrew's two homes: a session Claude Desktop starts
 * may not have Homebrew on its PATH.
 */
async function runGh($: $, args: readonly string[], cwd: string) {
  for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      return await $.process.run([gh, ...args], { cwd, timeoutMs: 15_000 })
    } catch {
      // Not there (or it timed out): try the next spelling.
    }
  }
  throw new Error('gh not found')
}
