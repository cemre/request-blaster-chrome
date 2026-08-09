#!/usr/bin/env bash
#
# Merge a worktree branch into main in as few round trips as possible.
#
# Why this exists: merging a finished worktree used to take 1–6 minutes, and
# measuring three of those merges showed 87–90% of the wall clock was model
# round trips, not work. Git itself totalled ~1.4s. The cost was never the
# merge — it was asking eight to nineteen separate questions about it, each one
# a ~12s turn. So this script answers all of them at once.
#
#   scripts/merge-to-main.sh check                 ← everything needed to decide
#   scripts/merge-to-main.sh merge -m "Subject"    ← commit, merge, verify, push
#   scripts/merge-to-main.sh cleanup               ← drop worktree and branch
#
# Three calls, and the last two are optional in the same breath. Each mode is
# all-or-nothing and prints a report; nothing here needs a follow-up question to
# interpret.

set -euo pipefail

MAIN_BRANCH=main

usage() {
  cat <<'TXT'
Merge a worktree branch into main, in as few round trips as possible.

  merge-to-main.sh check                 preflight: status, diff, conflicts,
                                         allowlist, tests, main worktree state
  merge-to-main.sh merge -m "Subject"    commit, merge --no-ff, re-test,
                    [-b "Body"]          build, push
  merge-to-main.sh cleanup               remove worktree, delete branch

-m is the one-line subject; it also names the merge commit. -b is the body
paragraph beneath it — the repo's commits carry one, ending in a
Co-Authored-By trailer.

Run from the worktree being merged. Each mode is one call and prints a full
report — no follow-up questions needed to interpret it.
TXT
  exit "${1:-1}"
}

# --- where are we -----------------------------------------------------------
# --show-toplevel is this worktree; the first entry of `worktree list` is always
# the main one, which is where main is checked out and where the merge lands.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git worktree" >&2; exit 1; }
WT=$(git rev-parse --show-toplevel)
MAIN_WT=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
BRANCH=$(git branch --show-current || true)

# Run the suite in a given worktree and echo node's own one-line tallies. Zero
# dependencies, so this works in a worktree that has never seen `npm install`.
run_tests() {
  local root=$1 out
  if ! out=$(cd "$root" && npm test 2>&1); then
    printf '%s\n' "$out" | tail -25
    return 1
  fi
  printf '%s\n' "$out" | grep -E '(tests|pass|fail) [0-9]+$' | sed 's/^[^a-z]*//' | tr '\n' ' '
}

# --- check ------------------------------------------------------------------
cmd_check() {
  echo "=== where ==="
  echo "worktree : $WT"
  echo "main     : $MAIN_WT"
  echo "branch   : ${BRANCH:-<detached>}"

  echo
  # --porcelain, not `diff --quiet`: an untracked new file is the single most
  # common thing waiting in a finished worktree, and diff does not see it.
  echo "=== uncommitted here ==="
  git -C "$WT" status --short || true
  [[ -n $(git -C "$WT" status --porcelain) ]] || echo "(clean)"

  local base
  base=$(git merge-base "$MAIN_BRANCH" HEAD)

  echo
  echo "=== this branch vs merge-base ==="
  git -C "$WT" log --oneline "$base"..HEAD | cat
  git -C "$WT" diff --stat "$base"..HEAD | tail -20

  echo
  echo "=== has main moved since the base? ==="
  local moved
  moved=$(git -C "$WT" log --oneline "$base".."$MAIN_BRANCH" | cat)
  if [[ -n $moved ]]; then
    printf '%s\n' "$moved"
    echo "--- files main touched (integration risk lives here) ---"
    git -C "$WT" diff --name-only "$base".."$MAIN_BRANCH"
  else
    echo "(no — fast-forward territory)"
  fi

  # merge-tree resolves the merge in memory against the object store, so this
  # predicts conflicts without checking anything out or touching either worktree.
  echo
  echo "=== conflict prediction ==="
  if git -C "$WT" merge-tree --write-tree "$MAIN_BRANCH" HEAD >/dev/null 2>&1; then
    echo "clean — merge will not conflict"
  else
    # Output is: tree OID, the conflicted paths, a blank line, then a prose
    # "informational messages" section. Keep the middle.
    echo "CONFLICTS in:"
    git -C "$WT" merge-tree --write-tree --name-only "$MAIN_BRANCH" HEAD 2>/dev/null \
      | awk 'NR == 1 { next } NF == 0 { exit } { print }'
  fi

  # build.js ships an explicit allowlist, so a new top-level file is invisible
  # to the store build until someone adds it there. That has bitten a merge
  # before; catching it here costs nothing. Dev-only trees (test/, docs/,
  # scripts/, .claude/) are expected to show up here — the prompt is to confirm,
  # not to add them.
  echo
  echo "=== new files vs build.js allowlist ==="
  local added include missing=()
  added=$(git -C "$WT" diff --name-only --diff-filter=A "$base"..HEAD || true)
  # Range-match to the first `];` — the array spans two lines, and a looser
  # pattern swallows the rest of the file's string literals.
  include=$(awk '/const INCLUDE/,/\];/' "$WT/build.js" | grep -o "'[^']*'" | tr -d "'")
  while IFS= read -r f; do
    [[ -z $f ]] && continue
    local top=${f%%/*}
    grep -qx "$top" <<<"$include" || missing+=("$f")
  done <<<"$added"
  if ((${#missing[@]})); then
    printf 'NOT shipped by the store build: %s\n' "${missing[*]}"
    echo "add to INCLUDE in build.js, or confirm it is dev-only"
  else
    echo "ok (allowlist: $(tr '\n' ' ' <<<"$include"))"
  fi

  echo
  echo "=== tests here ==="
  run_tests "$WT" && echo || echo "FAILED"

  echo
  echo "=== main worktree state ==="
  echo "on branch: $(git -C "$MAIN_WT" rev-parse --abbrev-ref HEAD)"
  git -C "$MAIN_WT" status --short | head || true
  [[ -n $(git -C "$MAIN_WT" status --porcelain) ]] || echo "(clean)"
}

# --- merge ------------------------------------------------------------------
cmd_merge() {
  local subject=${1:?merge needs -m "<commit subject>"} body=${2:-}

  [[ -n $BRANCH ]] || { echo "detached HEAD — nothing to merge" >&2; exit 1; }
  [[ $BRANCH != "$MAIN_BRANCH" ]] || { echo "already on $MAIN_BRANCH" >&2; exit 1; }

  # Refuse to merge into a main worktree that has its own uncommitted work —
  # the merge would blend into changes nobody reviewed.
  local main_head
  main_head=$(git -C "$MAIN_WT" rev-parse --abbrev-ref HEAD)
  [[ $main_head == "$MAIN_BRANCH" ]] || { echo "main worktree is on '$main_head', not $MAIN_BRANCH" >&2; exit 1; }
  if [[ -n $(git -C "$MAIN_WT" status --porcelain) ]]; then
    echo "main worktree is dirty — commit or stash it first:" >&2
    git -C "$MAIN_WT" status --short >&2
    exit 1
  fi

  echo "=== 1/6 tests on the branch ==="
  run_tests "$WT" && echo

  echo
  echo "=== 2/6 commit ==="
  if [[ -z $(git -C "$WT" status --porcelain) ]]; then
    echo "nothing to commit — branch is already buttoned up"
  else
    git -C "$WT" add -A
    # Second -m becomes the body paragraph, blank line inserted by git. Skipped
    # entirely when empty, so a bodyless commit stays a clean one-liner rather
    # than growing a trailing blank.
    if [[ -n $body ]]; then
      git -C "$WT" commit -q -m "$subject" -m "$body"
    else
      git -C "$WT" commit -q -m "$subject"
    fi
    git -C "$WT" log --oneline -1 | cat
  fi

  echo
  echo "=== 3/6 merge into $MAIN_BRANCH ==="
  # --no-ff throughout: the history here is a series of merge commits, one per
  # worktree, and a fast-forward would silently break that pattern.
  if ! git -C "$MAIN_WT" merge --no-ff "$BRANCH" -m "Merge $subject into $MAIN_BRANCH"; then
    echo
    echo "MERGE CONFLICT — main worktree left mid-merge. Resolve there, or:" >&2
    echo "  git -C \"$MAIN_WT\" merge --abort" >&2
    exit 1
  fi
  git -C "$MAIN_WT" log --oneline -1 | cat

  echo
  echo "=== 4/6 tests on merged $MAIN_BRANCH ==="
  run_tests "$MAIN_WT" && echo

  echo
  echo "=== 5/6 store build ==="
  # `npm run build` calls commitVersion(), which writes the bumped version back
  # into manifest.json on purpose so the store never sees a repeat. A merge-time
  # verification build is not a release, so put that bump back — otherwise every
  # merge silently burns a version number.
  if (cd "$MAIN_WT" && npm run build >/tmp/mtm-build.$$ 2>&1); then
    grep -E 'version|verified|files' /tmp/mtm-build.$$ | tail -5 || tail -3 /tmp/mtm-build.$$
    if ! git -C "$MAIN_WT" diff --quiet -- manifest.json; then
      git -C "$MAIN_WT" checkout -- manifest.json
      echo "(manifest version bump reverted — verification build, not a release)"
    fi
  else
    tail -20 /tmp/mtm-build.$$
    echo "BUILD FAILED — merge is committed, build is not clean" >&2
    rm -f /tmp/mtm-build.$$
    exit 1
  fi
  rm -f /tmp/mtm-build.$$

  echo
  echo "=== 6/6 push $MAIN_BRANCH ==="
  # Last, and only once main is green and builds: everything above is local and
  # revertible, this is the step that leaves the machine. No --force-with-lease
  # escape hatch here — git's own non-fast-forward refusal is the check worth
  # keeping, and a rejection means origin moved and wants reading, not overriding.
  if ! git -C "$MAIN_WT" push origin "$MAIN_BRANCH"; then
    echo
    echo "PUSH REJECTED — the merge is committed locally, origin does not have it." >&2
    echo "origin/$MAIN_BRANCH moved since this branch started. Integrate, don't force:" >&2
    echo "  git -C \"$MAIN_WT\" pull --no-rebase origin $MAIN_BRANCH" >&2
    echo "  git -C \"$MAIN_WT\" push origin $MAIN_BRANCH" >&2
    exit 1
  fi

  echo
  echo "=== done ==="
  git -C "$MAIN_WT" log --oneline --graph -4 | cat
  echo
  echo "pushed. worktree left in place for manual testing."
  echo "when satisfied:  scripts/merge-to-main.sh cleanup"
}

# --- cleanup ----------------------------------------------------------------
cmd_cleanup() {
  [[ -n $BRANCH ]] || { echo "detached HEAD — remove the worktree by hand" >&2; exit 1; }
  [[ $WT != "$MAIN_WT" ]] || { echo "this is the main worktree; not removing it" >&2; exit 1; }

  # -d, never -D: git refuses unless the branch is fully merged, which is
  # exactly the check worth keeping. An unmerged branch here means the merge
  # did not happen and the work is about to be thrown away.
  if ! git -C "$MAIN_WT" merge-base --is-ancestor HEAD "$MAIN_BRANCH"; then
    echo "branch '$BRANCH' is NOT fully merged into $MAIN_BRANCH — refusing to remove" >&2
    exit 1
  fi

  local dirty
  dirty=$(git -C "$WT" status --porcelain)
  [[ -z $dirty ]] || { echo "uncommitted work here — refusing to remove:" >&2; echo "$dirty" >&2; exit 1; }

  # Two things here sit inside the directory about to vanish: the shell's cwd,
  # and this script file itself. The cd fixes the first. The second is safe
  # because `worktree remove` unlinks rather than truncates, and the fd bash is
  # reading the script from stays valid across an unlink — but keep the removal
  # last, so nothing needs to be read back after the tree is gone.
  cd "$MAIN_WT"
  git worktree remove "$WT"
  git branch -d "$BRANCH"
  git worktree prune
  echo "removed worktree and branch '$BRANCH'"
  echo
  git -C "$MAIN_WT" log --oneline -3 | cat
}

# --- dispatch ---------------------------------------------------------------
mode=${1:-}; shift || true
case $mode in
  check)   cmd_check ;;
  merge)
    subject=""; body=""
    while (($#)); do
      case $1 in
        -m) subject=${2:-}; shift 2 ;;
        -b) body=${2:-}; shift 2 ;;
        *)  echo "unknown flag: $1" >&2; usage ;;
      esac
    done
    [[ -n $subject ]] || { echo "merge needs -m \"<commit subject>\"" >&2; exit 1; }
    # A multi-line -m would make a mess of "Merge <subject> into main"; the body
    # belongs in -b.
    [[ $subject != *$'\n'* ]] || { echo "-m must be one line; put the rest in -b" >&2; exit 1; }
    cmd_merge "$subject" "$body" ;;
  cleanup) cmd_cleanup ;;
  -h|--help) usage 0 ;;
  *)       usage ;;
esac
