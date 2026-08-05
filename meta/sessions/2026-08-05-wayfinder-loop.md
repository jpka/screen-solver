# 2026-08-05 — Wayfinder loop on the Screen Solver map

| | |
|---|---|
| Repo / branch | `jpka/screen-solver` · `claude/wayfinder-screen-solver-loop-xf9m79` |
| Environment | Claude Code on the web (remote container, ephemeral) |
| Model | `claude-opus-5`, switched to `claude-sonnet-5` at ~15:00 UTC |
| Span | ~02:57–16:30 UTC (with a long idle gap after the loop stopped) |
| Objective | Run `/wayfinder` against map issue #1 on a loop, each call in its own thread |

The user's standing instruction for the whole run:

> when you want me to decide, document the options considered in the relevant
> issue and go with your recommendation

## Outcome

Three map tickets resolved, one ticket chartered, one session lost to a usage
limit. The map went from 7/10 to 11/12 tickets closed.

| Ticket | Result | Commit |
|---|---|---|
| #9 Cost control | Closed — four nested limits sized against a computed cost model | `4958ddd` |
| #10 Packaging and distribution | Closed — electron-builder NSIS, per-user, unsigned | `931a1a8` |
| #11 Solve-call prompt design | Closed — answer-first output contract | `fcea243` |
| #13 Failure and edge-case behavior | Chartered by #10, unblocked by #11, **still open** | — |

Tooling committed separately as `689b48c` (see *Environment work* below).

Remaining fog on the map: answer history persistence. The "detection as a
separate pass" fog closed inside #11 — the `# No exercise on screen` bail token
turned out to be the v1 detector.

## How the loop was run

`/loop` with no interval → dynamic self-pacing. Each iteration spawned one
`general-purpose` subagent (the user asked for "its own separate thread"), and
the subagent's completion notification was the wake signal. `ScheduleWakeup` was
armed each turn at 1800s purely as a fallback heartbeat in case a session hung.

The per-iteration prompt was rebuilt each time rather than reused verbatim. It
carried: how to invoke the skill, the environment workarounds, the *current*
frontier as observed, an instruction to read the previous tickets' resolution
comments, and the decision-delegation clause. Iterations 2+ also carried the
specific amendments the previous session had handed forward.

Sessions ran 9–15 minutes and 125k–473k tokens each.

## What went wrong

**The skill wasn't installed.** `/wayfinder` didn't exist in the container, and
neither did `gh`. Iteration 1 ran on the protocol reconstructed from
`docs/agents/issue-tracker.md`, which documents wayfinding operations precisely
enough to follow. The user then supplied `npx skills@latest add mattpocock/skills`
and iterations 2+ used the real skill. Worth noting the reconstruction produced a
usable result — the repo's own docs were sufficient — but it was luck, not
design.

**GitHub GraphQL is blocked in this environment.** REST is served, GraphQL 403s.
So `gh issue view` / `gh issue list` / `gh pr view` all fail, and every command
in `docs/agents/issue-tracker.md` is written in that porcelain form. Fix was to
pass `gh api repos/{owner}/{repo}/...` equivalents into each subagent prompt
rather than editing the tracker doc, which is correct for the user's local
machine. This is friction that recurs every session until it's written down
somewhere durable.

**A dead session left a stale claim.** Iteration 4 hit a usage limit immediately
after assigning #13 to the user — the protocol's "claim" step — and died. An
assigned ticket is invisible to the frontier query, so the next session would
have found an empty frontier and concluded the map was done. Caught and released
manually. **This is the sharpest failure mode of the run:** the claim is a write
that outlives the process holding it, with no lease or expiry. Any unattended
wayfinder loop needs a stale-claim check before the frontier query.

**Usage limits kill background agents mid-flight.** The failure surfaced as a
task notification with a partial result, not as an exception. The reset time in
the message ("resets 7am UTC") disagreed with the container clock (14:52 UTC),
so the retry was armed at the maximum 3600s and left to re-arm rather than
guessing at the true reset.

**No Anthropic API key was reachable** (401 from `api.anthropic.com`). #11 needed
measured token counts and had to bracket them with two tokenizers instead. The
session labelled every figure with its direction of bias and explicitly declined
to claim `effort: medium` + `max_tokens: 8000` won't truncate. Good behavior
under the constraint, but the constraint was avoidable — a key in the environment
would have made the ticket's central numbers real.

**`skills experimental_install` corrupted the install.** Tried it as the
lockfile-restore path; it converted one skill from symlink to copy, changed its
layout, then failed on the second with "No skills found". Reverted to a clean
`skills add`. The experimental label is accurate.

## Mistakes made by the agent

Recorded because they're the most extractable part.

**Hid files from git with `.git/info/exclude`.** When the skill install dropped
`.agents/`, `.claude/`, and `skills-lock.json` into the tree, the reflex was to
stop them polluting the wayfinder commits — done by appending to
`.git/info/exclude`. That's a local-only, invisible mechanism, and it would have
silently blocked the later request to commit exactly those files. Caught and
reverted when the pinning work started. A real `.gitignore` was the right tool
from the start; the wrong instinct was treating "keep it out of *this* commit" as
"keep it out of the repo".

**Used `--all` alongside a narrower flag.** In the pinning hook,
`skills add --all --agent claude-code`: `--all` expands to `--agent '*'` and
overrode the narrower flag, fanning the install across 75 agent targets and
leaving a stray `./agent/` directory. Not caught by the validation run — it
surfaced only when the SessionStart hook fired on resume and dirtied the tree.
Fixed to explicit `--skill '*' --agent claude-code -y`.

**Over-trusted a verification command.** After that fix, the re-validation
checked `.agents/skills` and reported "0 skills", read as a silent failure. The
install had actually succeeded into `.claude/skills/` — the CLI picks a
copy-vs-symlink layout depending on detected environment. The check asserted one
specific layout rather than the property that mattered (are the skills loadable).

## What worked, and is worth extracting

**One subagent per iteration, sequential.** Isolation kept each ticket's
research out of the next one's context, and the parent stayed small enough to
run the whole loop. Sequential rather than parallel was correct here because
each ticket consumed the previous ones' decisions.

**Amendment hand-off between tickets.** Each session ended by naming the
constraints it had imposed on other tickets (#9 → #5 and #11; #10 → #8, #9, #3,
#6, #7, #2; #11 → #5, #7, #13, #9). Feeding those forward in the next prompt is
most of why later tickets stayed coherent with earlier ones. This is the pattern
most worth turning into something reusable — right now it survives only because
the parent agent copies it by hand.

**Tickets that dissolve their own premise.** #10 existed because #2 flagged
border suppression as MSIX-gated. The session verified against WebRTC source that
the border can't be suppressed from the chosen capture path at all, which made
the planned spike moot and collapsed the packaging decision. Worth noticing that
the ticket's value was in invalidating the question, not answering it.

**Evidence over assertion.** #9 built a cost model rather than asserting
defaults; #11 measured what it could and bracketed what it couldn't. #6, earlier,
had already found that a hover flyout produced more apparent change than a real
navigation event — a result no amount of reasoning would have produced.

## Unresolved tension

`#11` and `#13` are `wayfinder:grilling` tickets. The skill states that an agent
must never answer its own questions on a HITL grilling ticket — they are meant to
be a conversation with the user. The standing decision-delegation instruction
overrode that for #10 and #11. Every fork was written into the ticket with
options and trade-offs before the pick, so the reasoning is auditable, but #11 in
particular was designed to be a conversation and wasn't one.

Open question for the next run: is blanket delegation the right default for
grilling tickets, or should the loop stop and queue those for the user while
proceeding with the rest?

## Environment work (commit `689b48c`)

Pinned the tooling so future sessions don't rediscover the same gaps:

- `skills` CLI pinned as an npm devDependency; `skills-lock.json` committed as a
  drift record. The CLI has no documented way to pin `mattpocock/skills` to a
  ref, so each run fetches upstream HEAD.
- `gh` pinned as a checksum-verified release download (2.63.2). There is no
  official npm package — the `gh` package on the registry is an unrelated tool,
  and installing it under that name would silently break every `gh api` call.
- Both provisioned by a `SessionStart` hook, gated on `$CLAUDE_CODE_REMOTE`.

Not yet addressed: the GraphQL-blocked-`gh`-porcelain workaround still lives only
in per-session prompts.

## Next session starts here

- #13 Failure and edge-case behavior — open, unassigned, unblocked, `wayfinder:grilling`
- Check for stale claims before running the frontier query
- Decide the grilling-ticket delegation question above
- An `ANTHROPIC_API_KEY` would let #11's bracketed figures be measured
