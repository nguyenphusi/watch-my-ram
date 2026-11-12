# Contributing to watch-my-ram

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- watch-my-ram **only reads and warns**. Changes that kill, close or block processes, sessions or commands are out of scope. See [Is it safe?](README.md#is-it-safe) for the full promise.

## Set up

You need macOS, Claude Code 2.1.287 or later, and Node 23.6+ (for the mascot script). See [Development](README.md#development) for the commands.

Pure logic lives in `hooks/lib/` with unit tests in `tests/`; `hooks/register.tsx` only wires the hooks together. New logic should go in `hooks/lib/` with a test.

## Before you open a pull request

Run these and make sure they pass. CI runs the same checks on every pull request.

```sh
claude plugin validate .
claude plugin test .
node scripts/export-mascot-svgs.mts --check
```

- If you changed the mascot in `hooks/lib/mascot.ts`, run `node scripts/export-mascot-svgs.mts` and commit the new SVGs.
- If you changed what the mod runs, reads or writes, update the [Is it safe?](README.md#is-it-safe) section.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles, for example `fix: ...` or `feat: ...`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
