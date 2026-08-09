---
name: merge
description: Use when work in a worktree of this repo is finished and should land on main — "merge this back", "ship it", "commit and push", "close out this worktree" — or before removing any worktree or deleting a branch.
---

# Merging a worktree back to main

**Run `scripts/merge-to-main.sh`. Never hand-roll the git sequence.** Each mode is one
call that answers everything at once; none of them needs a follow-up question to interpret.

Run from the root of the worktree being merged.

Invoked as `/merge`. Any argument is the intended commit subject — take it as `-m` rather
than writing your own. With no argument, read the `check` diff and write one.

## The three calls

```bash
scripts/merge-to-main.sh check
```

Read the report, then decide. It covers status, the branch diff, whether main moved, a
conflict prediction, the `build.js` allowlist, tests, and the main worktree's own state.
Do not re-ask any of that with a separate `git` call — it is already on screen.

```bash
scripts/merge-to-main.sh merge -m "Subject line" -b "Body paragraph.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Tests → commit → `merge --no-ff` → tests on merged main → store build → **push to origin**.
All-or-nothing; it stops at the first failure and says what broke.

```bash
scripts/merge-to-main.sh cleanup
```

Only after hand-testing the extension. Removes the worktree, deletes the branch with `-d`.

## Commit message

Three required parts, matching the repo's history:

| Part | Shape |
|---|---|
| `-m` subject | One line, imperative, sentence case, no trailing period. Also names the merge commit. |
| `-b` body | A paragraph on **why**, not a restatement of the diff. |
| trailer | Last line of `-b`: `Co-Authored-By: <model> <noreply@anthropic.com>` |

## When a step fails

| Report says | Do |
|---|---|
| `CONFLICTS in:` (from `check`) | Merge main into the branch here first, resolve, re-run `check`. |
| `NOT shipped by the store build` | Add the file to `INCLUDE` in `build.js`, or confirm it is dev-only. |
| `MERGE CONFLICT` | Main worktree is mid-merge. Resolve there, or `git -C <main> merge --abort`. |
| `BUILD FAILED` | Merge is committed, nothing pushed. Fix on main, then push by hand. |
| `PUSH REJECTED` | origin moved. Integrate as the message shows. Never force-push. |
| main worktree is dirty | Commit or stash there first — `merge` refuses, correctly. |

After `cleanup` the current directory is gone; run later commands from the main worktree path.

## Why not hand-roll it

Three merges were measured before this script existed: 64s, 117s and 356s — of which
**87–90% was model round trips**, eight to nineteen separate `git` calls at ~12s each. The
git work itself totalled about 1.4 seconds. Nothing about this repo is slow; asking about it
one question at a time is.

| Excuse | Reality |
|---|---|
| "It's just a commit and a push" | That is the sequence that took 356s. Two calls beats nineteen. |
| "I'll check status first, then decide" | `check` already printed status. A separate call buys nothing and costs a turn. |
| "I can `git checkout main` here" | You cannot — main is checked out in the main worktree. The script merges there via `-C`. |
| "Fast-forward is cleaner than `--no-ff`" | The history is one merge commit per worktree. Keep it. |
| "Tests passed in the worktree, skip the merged run" | The merged tree is a tree neither side tested. That is what step 4 is for. |
| "Push was rejected, force it" | A rejection means origin moved. Read it, integrate it. |
