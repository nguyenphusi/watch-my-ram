# Contributing to watch-my-ram

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- watch-my-ram **only reads and warns**. Changes that kill, close or block processes, sessions or commands are out of scope. See [Is it safe?](README.md#is-it-safe) for the full promise.

## Set up

You need the latest Claude Code and Node 23.6+ (for the mascot script). The checks and unit tests run on any OS; only running the mod itself needs macOS.

Pure logic lives in `hooks/lib/` with unit tests in `tests/`; `hooks/register.tsx` only wires the hooks together. New logic should go in `hooks/lib/` with a test.

## Before you open a pull request

- Run every check listed under [Development](README.md#development) in the README.
- If you changed the mascot in `hooks/lib/mascot.ts`, regenerate the SVGs as described there and commit them.
- If you changed what the mod runs, reads or writes, update the [Is it safe?](README.md#is-it-safe) section.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles, for example `fix: ...` or `feat: ...`.

CI tests against the latest Claude Code release. If CI fails on a part you didn't touch, a new Claude Code release may have changed something; say so in the PR and we'll look at it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
