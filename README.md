# watch-my-ram

A mod (plugin) for Claude Code on macOS. It warns early when the Mac is running out of memory and shows who is holding it. It **only reads and warns**: it never blocks or changes a command, and never kills a process or closes a session.

## Why this exists

AI coding agents start dev servers, test runners and browsers, and often leave them behind: sessions stay open after their PR merges, several worktrees run tests at once, and processes outlive the agent that started them. On a 16 GB Mac that adds up to tens of GB of swap, heat and lag.

watch-my-ram shows how much memory is in use and which sessions and processes hold it, so you know what to close.

## What the mod does

1. **A band above the prompt**, always shown:

   ```
   watch-my-ram · 34.3 GB in use · RAM 12.9/16 + swap 21.4 · alert >20 (auto)
   ```

   This reads as follows. 34.3 GB of memory is in use. 12.9 GB of it is in physical RAM (the Mac has 16 GB) and 21.4 GB is in swap. The band turns red when the total goes above the **alert level** of 20 GB. That 20 is the alert threshold, not the Mac's capacity. The band is dim below the threshold and red above it.

   The band is kept short (about 75 characters) so Claude Code's own text does not draw over it. The pane and the `/watch-my-ram` command use the full sentence: `34.3 GB in use (RAM 12.9 of 16 GB + swap 21.4 GB) · alert above 20 GB (auto)`.

   *Memory in use* is RAM in use plus swap used:
   - RAM in use: the active, wired and "occupied by compressor" pages from `vm_stat`, times the page size.
   - Swap used: from `sysctl vm.swapusage`.
   - Installed RAM: from `sysctl hw.memsize`, read in the same run.
   - Units: 1 GB = 1024³ bytes.

   The band measures once every 60 seconds, and all sessions share one cache file, `~/.claude/watch-my-ram/sample.json`. If the file is fresh (under 30 seconds old), a session reads it. If it is old, missing or broken, that session measures and writes it again. So even with 20 sessions open, the Mac runs `vm_stat` + `sysctl` only about once a minute.

2. **The `/watch-my-ram` command** answers at once, without a Claude turn. Where you see the answer depends on where you run it:
   - **In a terminal**, the roll-call is printed in the chat. Claude can read it too, and the prompt box then offers a dim suggestion, *"Suggest what I could clean up from the watch-my-ram roll-call above. Advice only: …"*. Press Tab to take it, then Enter to send.
   - **In Claude Desktop (and VS Code)**, it opens a **pane** named `watch-my-ram` with three buttons on its first row:
     - **Refresh** fetches the tables again.
     - **Ask Claude for suggestions** sends Claude the roll-call on screen and asks what you could close to free memory, biggest win first.
     - **Close** closes the pane (Esc does too, once the pane has the focus).
   - **Claude only advises.** Both the suggestion and the button ask for advice only: Claude is told not to run any command or stop, close, kill or delete anything. You decide what to close and do it yourself (or ask Claude to, in your own words, through the usual permission prompts).
   - **What it shows:**
     - A memory line, which follows the 60-second sample.
     - The live Claude sessions, numbered from 1: pid, folder or worktree, age, RAM, and whether the PR is MERGED. Sessions with a merged PR are drawn in a different colour, and the current session is bold and marked `(this session)`.
     - Orphan dev processes, meaning processes with PPID 1: node, tsx, vite, vitest, playwright and headless chromium.
     - Dev ports in LISTEN.
   - **The RAM column** is the memory footprint, the same figure as the MEM column of top and Activity Monitor, which counts compressed and swapped-out pages too. A value marked `*` is RSS, used when the footprint cannot be read.
   - **Dev ports:** a port counts as a dev port only when its process runs under a Claude session or inside a project folder (not `/`, `~`, `/Applications`, `~/Library` …).
   - **When the tables are fetched:** only when you run the command, when Refresh is pressed, and automatically at most once every 5 minutes while the pane is open.
   - **PR state** is fetched in a batch: one `gh pr list` per repository (worktrees of the same repository share it), matched by branch name and remembered for 10 minutes.
   - **Drawing:** the session table shows at once (about 1 second); the PR column shows `…` and fills in when `gh` answers.
   - **Layout:** the pane asks for a tall area, and what does not fit scrolls. The orphan-process and dev-port summary sits above the session table, so it is always visible.
   - **Headless:** `claude -p "/watch-my-ram"` prints the same roll-call as text.
   - **Cost:** `ps`, `footprint`, `lsof`, `git` and `gh` run only when you run the command, when Refresh is pressed, or every 5 minutes while the pane is open; never in the 60-second loop.

3. **Parallel test warning**: when Claude is about to run a test command (`vitest`, `npx vitest`, `playwright test`, `pnpm test*`, `pnpm -r test`, `npm run test*`, `yarn test` …) while another session is running vitest or playwright, the mod shows a toast naming that session's folder. Your command **still runs unchanged**. At most 1 toast every 5 minutes per session. `ps` runs only when the command matches a test command.

## Requirements

- macOS (the mod reads `vm_stat`, `sysctl`, `footprint` and `lsof`).
- Claude Code 2.1.287 or later, which runs mods (tested on 2.1.318).
- Optional: the GitHub CLI `gh`, signed in, to fill the PR column of `/watch-my-ram`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install watch-my-ram --marketplace nguyenphusi/watch-my-ram
```

Answer `y` to add the marketplace, then pick the **user** scope so every session loads the mod.

From a shell:

```sh
claude plugin install watch-my-ram --marketplace nguyenphusi/watch-my-ram
```

In the Claude Desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `nguyenphusi/watch-my-ram`, then **Add plugin**.

The install may end with a note like `1 userConfig option not yet set`. That is expected, not an error: the one option is the alert threshold, and leaving it unset means automatic.

Installed at user scope, the mod loads in every `claude` session started afterwards: terminal sessions, sessions inside other tools' terminals, and the local session Claude Desktop runs for its Code tab, where the band is drawn too. In a session that is already open, type `/reload-plugins` or restart it.

To update, refresh the marketplace and then the plugin, and restart open sessions (or run `/reload-plugins` in them):

```sh
claude plugin marketplace update watch-my-ram
claude plugin update watch-my-ram@watch-my-ram
```

## Change the threshold

The default is **automatic**: 1.25 × the Mac's installed RAM, rounded to one decimal. A 16 GB Mac gets 20 GB, and an 8 GB Mac gets 10 GB. The band shows `(auto)` while the automatic threshold is in use.

To set a specific number:

- In a session: open `/config`, find the row **watch-my-ram › Memory alert threshold (GB)**, and enter a number of GB. The mod reloads with the new threshold, and the band changes on its next draw. Enter `0` to go back to automatic.
- From a shell: `echo '{"threshold_gb":"24"}' | claude plugin configure watch-my-ram@watch-my-ram --values-stdin`. To go back to automatic: `echo '{"threshold_gb":"0"}' | claude plugin configure watch-my-ram@watch-my-ram --values-stdin` (an empty value `""` is treated as "no change").

## Disable / uninstall

```sh
claude plugin disable watch-my-ram@watch-my-ram     # turn off, keep it installed
claude plugin enable watch-my-ram@watch-my-ram      # turn back on
claude plugin uninstall watch-my-ram@watch-my-ram   # remove it completely
claude plugin marketplace remove watch-my-ram       # then forget the marketplace
rm -r ~/.claude/watch-my-ram                        # optional: the shared memory sample
```

To hide the band in one session only: in a terminal, press `[-]` at the end of the band (or ctrl+x ctrl+a); in Claude Desktop, press **Hide** at the end of the band. Running `/watch-my-ram` shows it again.

## What the mod reads, and what it never does

- Reads: `vm_stat`, `sysctl -n vm.swapusage hw.memsize` (periodically); `ps` (when a test command matches, or when the `/watch-my-ram` tables are fetched); `footprint`, `lsof`, `git rev-parse` / `git branch --show-current`, `gh pr list` (plus `gh pr view` for a branch older than a repository's newest 200 PRs) only when the `/watch-my-ram` tables are fetched.
- Writes: only `~/.claude/watch-my-ram/sample.json` (4 numbers).
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
