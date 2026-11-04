# orphanage

A mod (plugin) for Claude Code on macOS. It warns early when the Mac is running out of memory and shows who is holding it. It **only reads and warns**: it never blocks or changes a command, and never kills a process or closes a session.

## What the mod does

1. **A band above the prompt**, always shown:

   ```
   orphanage · 34.3 GB in use · RAM 12.9/16 + swap 21.4 · alert >20 (auto)
   ```

   This reads as follows. 34.3 GB of memory is in use. 12.9 GB of it is in physical RAM (the Mac has 16 GB) and 21.4 GB is in swap. The band turns red when the total goes above the **alert level** of 20 GB. That 20 is the alert threshold, not the Mac's capacity. The band is dim below the threshold and red above it.

   The band is kept short (about 70 characters) so Claude Code's own text does not draw over it. The pane and the `/orphanage` command use the full sentence: `34.3 GB in use (RAM 12.9 of 16 GB + swap 21.4 GB) · alert above 20 GB (auto)`.

   *Memory in use* is RAM in use plus swap used:
   - RAM in use: the active, wired and "occupied by compressor" pages from `vm_stat`, times the page size.
   - Swap used: from `sysctl vm.swapusage`.
   - Installed RAM: from `sysctl hw.memsize`, read in the same run.
   - Units: 1 GB = 1024³ bytes.

   The band measures once every 60 seconds, and all sessions share one cache file, `~/.claude/orphanage/sample.json`. If the file is fresh (under 30 seconds old), a session reads it. If it is old, missing or broken, that session measures and writes it again. So even with 20 sessions open, the Mac runs `vm_stat` + `sysctl` only about once a minute.

2. **The `/orphanage` command** answers at once, without a Claude turn, and opens a **pane** named `orphanage`.
   - **View only:** the pane's single control is **Refresh** (on the first row). Nothing in it acts on a process or a session.
   - **What it shows:**
     - A memory line, which follows the 60-second sample.
     - The live Claude sessions: pid, folder or worktree, age, RAM, and whether the PR is MERGED. Sessions with a merged PR are drawn in a different colour, and the current session is bold and marked `(this session)`.
     - Orphan dev processes, meaning processes with PPID 1: node, tsx, vite, vitest, playwright and headless chromium.
     - Dev ports in LISTEN.
   - **The RAM column** is the memory footprint, the same figure as the MEM column of top and Activity Monitor, which counts compressed and swapped-out pages too. A value marked `*` is RSS, used when the footprint cannot be read.
   - **Dev ports:** a port counts as a dev port only when its process runs under a Claude session or inside a project folder (not `/`, `~`, `/Applications`, `~/Library` …).
   - **When the tables are fetched:** only when the pane opens, when Refresh is pressed, and automatically at most once every 5 minutes while the pane is open.
   - **PR state** is fetched in a batch: one `gh pr list` per repository (worktrees of the same repository share it), matched by branch name and remembered for 10 minutes.
   - **Drawing:** the session table shows at once (about 1 second); the PR column shows `…` and fills in when `gh` answers.
   - **Layout:** the pane asks for a tall area. What does not fit can be scrolled: focus the pane (ctrl+x tab), then use ↑/↓ or the mouse wheel. The orphan-process and dev-port summary sits above the session table, so it is always visible.
   - **Without a pane:** where no pane can be drawn (for example `claude -p "/orphanage"`), the command returns the same content as a text table.
   - **Cost:** `ps`, `footprint`, `lsof`, `git` and `gh` run only when the pane opens, when Refresh is pressed, or every 5 minutes while it is open; never in the 60-second loop.

3. **Parallel test warning**: when Claude is about to run a test command (`vitest`, `npx vitest`, `playwright test`, `pnpm test*`, `pnpm -r test`, `npm run test*`, `yarn test` …) while another session is running vitest or playwright, the mod shows a toast naming that session's folder. Your command **still runs unchanged**. At most 1 toast every 5 minutes per session. `ps` runs only when the command matches a test command.

## Requirements

- macOS (the mod reads `vm_stat`, `sysctl`, `footprint` and `lsof`).
- Claude Code 2.1.287 or later, which runs mods (tested on 2.1.318).
- Optional: the GitHub CLI `gh`, signed in, to fill the PR column of `/orphanage`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install orphanage --marketplace nguyenphusi/orphanage-claude-code-mod
```

Answer `y` to add the marketplace, then pick the **user** scope so every session loads the mod.

From a shell:

```sh
claude plugin install orphanage --marketplace nguyenphusi/orphanage-claude-code-mod
```

In the Claude Desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `nguyenphusi/orphanage-claude-code-mod`, then **Add plugin**.

The install may end with a note like `1 userConfig option not yet set`. That is expected, not an error: the one option is the alert threshold, and leaving it unset means automatic.

Installed at user scope, the mod loads in every `claude` session started afterwards: terminal sessions, sessions inside other tools' terminals, and the local session Claude Desktop runs for its Code tab, where the band is drawn too. In a session that is already open, type `/reload-plugins` or restart it.

To update: `claude plugin marketplace update orphanage`, then `/reload-plugins` in open sessions.

## Change the threshold

The default is **automatic**: 1.25 × the Mac's installed RAM, rounded to one decimal. A 16 GB Mac gets 20 GB, and an 8 GB Mac gets 10 GB. The band shows `(auto)` while the automatic threshold is in use.

To set a specific number:

- In a session: open `/config`, find the row **orphanage › Memory alert threshold (GB)**, and enter a number of GB. The mod reloads with the new threshold, and the band changes on its next draw. Enter `0` to go back to automatic.
- From a shell: `echo '{"threshold_gb":"24"}' | claude plugin configure orphanage@orphanage --values-stdin`. To go back to automatic: `echo '{"threshold_gb":"0"}' | claude plugin configure orphanage@orphanage --values-stdin` (an empty value `""` is treated as "no change").

## Disable / uninstall

```sh
claude plugin disable orphanage@orphanage     # turn off, keep it installed
claude plugin enable orphanage@orphanage      # turn back on
claude plugin uninstall orphanage@orphanage   # remove it completely
claude plugin marketplace remove orphanage    # then forget the marketplace
rm -r ~/.claude/orphanage                     # optional: the shared memory sample
```

To hide the band in one session only: press `[-]` at the end of the band (or ctrl+x ctrl+a).

## What the mod reads, and what it never does

- Reads: `vm_stat`, `sysctl -n vm.swapusage hw.memsize` (periodically); `ps` (when a test command matches, or when the `/orphanage` tables are fetched); `footprint`, `lsof`, `git rev-parse` / `git branch --show-current`, `gh pr list` (plus `gh pr view` for a branch older than a repository's newest 200 PRs) only when the `/orphanage` tables are fetched.
- Writes: only `~/.claude/orphanage/sample.json` (4 numbers).
- Never: blocks or changes a Bash command, kills or closes a process or session, or prints another process's command-line arguments.

## Development

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .    # a test session that loads the mod from this folder
```

Pure logic lives in `hooks/lib/` (with unit tests in `tests/`); `hooks/register.tsx` only wires the hooks together.

## License

[MIT](LICENSE)
