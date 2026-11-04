// Memory in use = RAM in use (active + wired + compressor pages from vm_stat)
// + swap used (sysctl vm.swapusage). Pure functions: no `$` here, so tests
// can feed sample command output straight in.

import type { Sample } from '../../types'

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
 * Parses the output of `vm_stat; sysctl -n vm.swapusage hw.memsize` run as
 * one shell command into a sample stamped `at`.
 */
export function parseMeasurement(text: string, at: number): Sample | undefined {
  const ramBytes = parseVmStatRamBytes(text)
  const swapBytes = parseSwapUsedBytes(text)
  const installedBytes = parseInstalledBytes(text)
  if (ramBytes === undefined || swapBytes === undefined || installedBytes === undefined) return undefined

  return { at, ramBytes, swapBytes, installedBytes }
}

/** A cached sample read back from JSON; undefined for anything malformed or older. */
export function parseSample(json: string): Sample | undefined {
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null) return undefined
    const { at, ramBytes, swapBytes, installedBytes } = value as Record<string, unknown>
    const numbers = [at, ramBytes, swapBytes, installedBytes]
    const isValid =
      numbers.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) && (installedBytes as number) > 0

    return isValid
      ? {
          at: at as number,
          ramBytes: ramBytes as number,
          swapBytes: swapBytes as number,
          installedBytes: installedBytes as number,
        }
      : undefined
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

/** Bytes as GB to one decimal: `12.9`. */
const gb = (bytes: number): string => (bytes / GB).toFixed(1)
/** One decimal, dropped when it is zero: `22.5`, `16`. */
const short = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** Installed RAM as GB, one decimal dropped when zero: `16`. */
const installedGb = (sample: Sample): string => short(Math.round((sample.installedBytes / GB) * 10) / 10)

/** `32.9 GB in use (RAM 12.9 of 16 GB + swap 20.1 GB) · alert above 20 GB (auto)` */
export function formatUsage(sample: Sample, threshold: Threshold): string {
  const installed = installedGb(sample)
  const alert = `alert above ${short(threshold.gb)} GB${threshold.isAuto ? ' (auto)' : ''}`

  return `${gb(usedBytes(sample))} GB in use (RAM ${gb(sample.ramBytes)} of ${installed} GB + swap ${gb(sample.swapBytes)} GB) · ${alert}`
}

/**
 * The band's short form, about 60 characters (76 with the `watch-my-ram · `
 * prefix), so it fits beside what Claude Code draws on the same row:
 * `34.5 GB in use · RAM 12.9/16 + swap 21.6 · alert >20 (auto)`.
 * The pane and the text answer keep the long form (`formatUsage`).
 */
export function formatBand(sample: Sample, threshold: Threshold): string {
  const installed = installedGb(sample)

  return `${gb(usedBytes(sample))} GB in use · RAM ${gb(sample.ramBytes)}/${installed} + swap ${gb(sample.swapBytes)} · alert >${short(threshold.gb)}${threshold.isAuto ? ' (auto)' : ''}`
}
