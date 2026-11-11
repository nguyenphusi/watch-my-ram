// Writes the README mascots (assets/mascot-<level>.svg) from hooks/lib/mascot.ts, so they never drift from the band.
// Run from the repo root with Node 23.6+ (runs .ts directly):
//   node scripts/export-mascot-svgs.mts           write the files
//   node scripts/export-mascot-svgs.mts --check   exit 1 if a committed file differs
import { readFileSync, writeFileSync } from 'node:fs'

import { mascotSvg } from '../hooks/lib/mascot.ts'

const FILES = { ok: 'normal', warning: 'warning', critical: 'critical' } as const
const check = process.argv.includes('--check')
let stale = 0

for (const [level, name] of Object.entries(FILES) as [keyof typeof FILES, string][]) {
  const path = `assets/mascot-${name}.svg`
  // The same drawing at 3x, so the README can show it larger without blurring.
  const svg = mascotSvg(level).replace('width="48" height="36"', 'width="144" height="108"') + '\n'
  if (!check) {
    writeFileSync(path, svg)
    continue
  }
  let current = ''
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // A missing file counts as stale.
  }
  if (current !== svg) {
    console.error(`${path} is out of date: run node scripts/export-mascot-svgs.mts`)
    stale++
  }
}

process.exit(stale === 0 ? 0 : 1)
