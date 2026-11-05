// Memory in use = RAM in use (active + wired + compressor pages from vm_stat)
// + swap used (sysctl vm.swapusage). The alert follows macOS's own memory
// pressure level unless the person set a GB threshold. Pure functions: no `$`
// here, so tests can feed sample command output straight in.

import type { Pressure, Sample } from '../../types'

export const GB = 1024 ** 3
export const SAMPLE_PERIOD_MS = 60_000
/** The automatic threshold, as a multiple of the installed RAM. */
export const AUTO_THRESHOLD_FACTOR = 1.25

/** RAM in use, in bytes, from `vm_stat` output; undefined when unreadable. */
export function parseVmStatRamBytes(text: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const pages = (label: string): number => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm').exec(text)

    return Number(match?.[1])
  }
  const used =
    pages('Pages active') +
    pages('Pages wired down') +
    pages('Pages occupied by compressor')
  const bytes = used * pageSize

  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

/** Swap used, in bytes, from `sysctl -n vm.swapusage`; undefined when unreadable. */
export function parseSwapUsedBytes(text: string): number | undefined {
  const match = /used = ([\d.]+)([KMG])/.exec(text)
  if (match === null) return undefined
  const bytes = Number(match[1]) * (UNIT[match[2] ?? ''] ?? NaN)

  return Number.isFinite(bytes) ? bytes : undefined
}

/** Installed RAM, in bytes, from `sysctl -n hw.memsize`: a line holding only the number. */
export function parseInstalledBytes(text: string): number | undefined {
  const bytes = Number(/^(\d{8,})\s*$/m.exec(text)?.[1])

  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined
}

/**
 * macOS memory pressure from `sysctl kern.memorystatus_vm_pressure_level`
 * (1 normal, 2 warning, 4 critical, as Activity Monitor's graph shows it);
 * undefined when missing or unknown.
 */
export function parsePressure(text: string): Pressure | undefined {
  const level = Number(/^kern\.memorystatus_vm_pressure_level:\s*(\d+)\s*$/m.exec(text)?.[1])

  return isPressure(level) ? level : undefined
}

const isPressure = (value: unknown): value is Pressure => value === 1 || value === 2 || value === 4

/**
 * Parses the output of `vm_stat; sysctl -n vm.swapusage hw.memsize;
 * sysctl kern.memorystatus_vm_pressure_level` run as one shell command into a
 * sample stamped `at`. The pressure level is optional: without it the alert
 * falls back to the automatic GB threshold.
 */
export function parseMeasurement(text: string, at: number): Sample | undefined {
  const ramBytes = parseVmStatRamBytes(text)
  const swapBytes = parseSwapUsedBytes(text)
  const installedBytes = parseInstalledBytes(text)
  if (ramBytes === undefined || swapBytes === undefined || installedBytes === undefined) return undefined
  const pressure = parsePressure(text)

  return pressure === undefined ? { at, ramBytes, swapBytes, installedBytes } : { at, ramBytes, swapBytes, installedBytes, pressure }
}

/** A cached sample read back from JSON; undefined for anything malformed or older. */
export function parseSample(json: string): Sample | undefined {
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null) return undefined
    const { at, ramBytes, swapBytes, installedBytes, pressure } = value as Record<string, unknown>
    const numbers = [at, ramBytes, swapBytes, installedBytes]
    const isValid =
      numbers.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) && (installedBytes as number) > 0

    if (!isValid) return undefined
    const sample: Sample = {
      at: at as number,
      ramBytes: ramBytes as number,
      swapBytes: swapBytes as number,
      installedBytes: installedBytes as number,
    }

    return isPressure(pressure) ? { ...sample, pressure } : sample
  } catch {
    return undefined
  }
}

/**
 * Whether a cache file last written at `mtimeMs` still counts as current:
 * younger than half a period, so the band never shows a reading older than
 * about 1.5 periods (cache age + this session's own timer).
 */
export function isFresh(mtimeMs: number, now: number): boolean {
  const age = now - mtimeMs

  return age >= 0 && age < SAMPLE_PERIOD_MS / 2
}

export function usedBytes(sample: Sample): number {
  return sample.ramBytes + sample.swapBytes
}

export type Threshold = { gb: number; isAuto: boolean }

/**
 * The alert threshold: the person's `threshold_gb` when it is a positive
 * number (to one decimal), else automatic, 1.25 × installed RAM to one
 * decimal (16 GB → 20, 8 GB → 10). Empty, 0 (or below 0.05), negative or
 * text all mean automatic.
 */
export function resolveThreshold(option: unknown, installedBytes: number): Threshold {
  const own = typeof option === 'number' ? option : typeof option === 'string' && option.trim() !== '' ? Number(option) : NaN
  // Shown and compared at one decimal, so the label never says less than what is tested.
  const rounded = Math.round(own * 10) / 10
  if (Number.isFinite(rounded) && rounded > 0) return { gb: rounded, isAuto: false }

  return { gb: Math.round((AUTO_THRESHOLD_FACTOR * installedBytes) / GB * 10) / 10, isAuto: true }
}

export function isOver(sample: Sample, threshold: Threshold): boolean {
  return usedBytes(sample) > threshold.gb * GB
}

export type Level = 'ok' | 'warning' | 'critical'

/** What the alert is based on: the person's GB threshold, macOS pressure, or the automatic GB fallback. */
type Basis = 'own' | 'pressure' | 'auto'

const basisOf = (sample: Sample, threshold: Threshold): Basis =>
  !threshold.isAuto ? 'own' : sample.pressure !== undefined ? 'pressure' : 'auto'

const PRESSURE_NAME: Record<Pressure, string> = { 1: 'normal', 2: 'warning', 4: 'critical' }

/**
 * How alarmed the band should look. A GB threshold set in /config decides on
 * its own (above it: critical). Otherwise macOS's pressure level decides
 * (warning, critical), and a sample without one falls back to the automatic
 * GB threshold.
 */
export function alertLevel(sample: Sample, threshold: Threshold): Level {
  if (basisOf(sample, threshold) === 'pressure') {
    return sample.pressure === 4 ? 'critical' : sample.pressure === 2 ? 'warning' : 'ok'
  }

  return isOver(sample, threshold) ? 'critical' : 'ok'
}

/** The alert word of the roll-call memory line: `ok`, `WARNING`, `CRITICAL`, or `OVER` for a GB threshold. */
export function alertWord(sample: Sample, threshold: Threshold): string {
  const level = alertLevel(sample, threshold)
  if (level === 'ok') return 'ok'

  return basisOf(sample, threshold) === 'pressure' ? level.toUpperCase() : 'OVER'
}

/** Bytes as GB to one decimal: `12.9`. */
const gb = (bytes: number): string => (bytes / GB).toFixed(1)
/** One decimal, dropped when it is zero: `22.5`, `16`. */
const short = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** Installed RAM as GB, one decimal dropped when zero: `16`. */
const installedGb = (sample: Sample): string => short(Math.round((sample.installedBytes / GB) * 10) / 10)

/** What the alert follows, long (`alert above 20 GB (auto)`) or short (`alert >20 (auto)`). */
function alertLabel(sample: Sample, threshold: Threshold, isShort: boolean): string {
  const basis = basisOf(sample, threshold)
  if (basis === 'pressure' && sample.pressure !== undefined) {
    return `${isShort ? 'pressure' : 'macOS memory pressure'} ${PRESSURE_NAME[sample.pressure]}`
  }
  const auto = basis === 'auto' ? ' (auto)' : ''

  return isShort ? `alert >${short(threshold.gb)}${auto}` : `alert above ${short(threshold.gb)} GB${auto}`
}

/**
 * `32.9 GB in use (RAM 12.9 of 16 GB + swap 20.1 GB) · macOS memory pressure warning`,
 * or `… · alert above 24 GB` with a threshold set in /config.
 */
export function formatUsage(sample: Sample, threshold: Threshold): string {
  const installed = installedGb(sample)

  return `${gb(usedBytes(sample))} GB in use (RAM ${gb(sample.ramBytes)} of ${installed} GB + swap ${gb(sample.swapBytes)} GB) · ${alertLabel(sample, threshold, false)}`
}

/**
 * The band's short form, about 60 characters (76 with the `watch-my-ram · `
 * prefix), so it fits beside what Claude Code draws on the same row:
 * `34.5 GB in use · RAM 12.9/16 + swap 21.6 · pressure warning`.
 * The pane and the text answer keep the long form (`formatUsage`).
 */
export function formatBand(sample: Sample, threshold: Threshold): string {
  const installed = installedGb(sample)

  return `${gb(usedBytes(sample))} GB in use · RAM ${gb(sample.ramBytes)}/${installed} + swap ${gb(sample.swapBytes)} · ${alertLabel(sample, threshold, true)}`
}
