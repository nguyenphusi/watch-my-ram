/** One memory reading, shared between sessions through the cache file. */
export type Sample = {
  /** When it was measured, milliseconds since the epoch. */
  at: number
  /** RAM in use: active + wired + compressor pages, in bytes. */
  ramBytes: number
  /** Swap used, in bytes. */
  swapBytes: number
  /** Installed RAM (`hw.memsize`), in bytes. */
  installedBytes: number
}

/** One row of the roll-call: a session, an orphan or a port, ready to draw. */
export type RollLine = { text: string; isMerged?: boolean; isSelf?: boolean }

/** The roll-call tables as of `at`, drawn by the pane and the text answer alike. */
export type RollView = {
  at: number
  sessions: { title: string; lines: RollLine[] }
  orphans: { title: string; lines: RollLine[] }
  ports: { title: string; lines: RollLine[] }
  notes: string[]
}

declare module 'claude-code' {
  interface PluginState {
    orphanage: { sample: Shaped<Sample | null>; roll: Shaped<RollView | null> }
  }
}
