# gorphan

Clean up old local git branches from one interactive list in your terminal.

Branches pile up: `feature/login-fix`, `bugfix/123`, `test-branch`... The PR gets merged, but the local branch stays. A few months later `git branch` shows 50 names and you don't remember which ones are safe to delete. `gorphan` works that out for you.

```
$ gorphan

12 merged, 3 stale, 1 active (compared with origin/main)
? Select branches to delete
❯◉ feature/login-fix          92 days ago   ✅ Merged  (remote gone)
 ◉ bugfix/payment-123         35 days ago   ✅ Merged
 ◉ feat/new-onboarding         6 days ago   ✅ Squash-merged
 ◯ experiment/redis          124 days ago   ⚠️  Stale
 - feature/new-dashboard       2 days ago   🔵 Active

↑↓ navigate • space select • a all • i invert • ⏎ submit
? Delete 3 branches? (y/N) y
  🗑  feature/login-fix 3f199daf
  🗑  bugfix/payment-123 cfe7e099
  🗑  feat/new-onboarding 81e8cf91
```

## Install

```
npm install -g gorphan
```

To try it without installing:

```
npx gorphan
```

## Usage

Run it inside any git repository:

```
gorphan                       # find candidates, show them, confirm, delete
gorphan --dry-run             # show what would be deleted, change nothing
gorphan -y                    # delete without the confirmation prompt
gorphan --merged              # only branches merged into the default branch
gorphan --gone                # only branches whose upstream is gone
gorphan feature/login-fix     # delete one (or more) branches by name
```

## How branches are sorted

| Status | Rule | Ticked by default |
|---|---|---|
| ✅ Merged | All its commits are in `origin/<default branch>` | yes |
| ✅ Squash-merged | Its GitHub PR was merged **and** the local branch tip is the same commit as the PR head | yes |
| ⚠️ Stale | Not merged, and no commit for 30+ days or its remote branch was deleted | no |
| 🔵 Active | Not merged, recent commits | can't be selected |

The default branch (`main`, `master`, ...) is detected from `origin/HEAD`. Before sorting, `gorphan` runs `git fetch --prune` so it compares against the latest remote state.

Why the squash check matters: a squash merge creates a brand-new commit on main, so git itself thinks your branch was never merged. `gorphan` asks GitHub instead (through the [`gh` CLI](https://cli.github.com)). The commit check means a branch you kept working on after the merge is **not** treated as merged.

## Options

| Option | What it does |
|---|---|
| `--merged` | List only merged branches (including squash merges) |
| `--gone` | List only branches whose remote branch was deleted |
| `--dry-run` | Show what would be deleted, delete nothing |
| `-y`, `--yes` | Skip the prompt. With no filter it deletes only merged branches; with `--merged` / `--gone` it deletes everything the filter lists; with branch names it also deletes unmerged ones |
| `--days N` | Days without a commit before a branch counts as stale (default `30`) |
| `--no-fetch` | Skip `git fetch --prune` |
| `--no-gh` | Skip the squash-merge check |
| `-h`, `--help` | Show help |

`--merged --gone` together lists branches matching either filter. With a filter, every listed branch starts ticked.

`gorphan <branch>...` deletes a merged branch right away and asks before deleting an unmerged one.

## Safety

- Never touches `main`, `master`, `develop`, `dev`, `staging`, the branch you are on, or a branch checked out in another worktree.
- A branch is only deleted without asking when it is fully contained in the default branch, or its merged PR points at the same commit. Anything else needs an explicit yes.
- Nothing is deleted until you confirm, unless you pass `-y`.
- Every deleted branch is logged with its commit hash, so you can bring it back.

## Undo a delete

Each deletion is appended to `~/.gorphan.log`:

```
2026-11-05T09:23:54Z  /path/to/repo  git branch feature/login-fix 3f199daf...
```

Copy the `git branch <name> <sha>` part and run it in that repo. The branch comes back exactly as it was.

## Requirements

- Node.js 20.17+, 22.13+ or 23.5+
- git 2.23+
- Optional: [`gh`](https://cli.github.com), logged in, for squash-merge detection. Without it, squash-merged branches show up as Stale instead of Merged.

## Troubleshooting

**`npm install -g` fails with `EACCES: permission denied`.** Your global npm folder is owned by root. Either use `npx gorphan`, or point npm at a folder you own (once):

```
npm config set prefix ~/.local    # make sure ~/.local/bin is on your PATH
```

Don't use `sudo npm install -g`.

**"squash-merge check skipped".** `gh` isn't installed or isn't logged in. Run `gh auth login`, or pass `--no-gh` to hide the message.

**It compares against the wrong branch.** `gorphan` uses whatever `origin/HEAD` points to. Refresh it with `git remote set-head origin --auto`.

## License

MIT
