# Solve-call prompt design — ticket #11

The deliverable is [`system-prompt.md`](./system-prompt.md): the literal string that becomes
`ProviderConfig.systemPrompt` in [#5](https://github.com/jpka/screen-solver/issues/5).
This file is the justification, the measurements, and the request shape around it.

| File | What it is |
|---|---|
| [`system-prompt.md`](./system-prompt.md) | **The deliverable.** Ships verbatim. |
| [`measure.js`](./measure.js) | Token measurement + cost arithmetic. `node measure.js`. |
| [`traces/`](./traces/) | Real model output on the [#6 capture frames](../../prototypes/05-change-detection/frames/). |

---

## What was measured vs. estimated

This session had **no Anthropic API key** (`api.anthropic.com` answered 401), so the honest
split matters:

| Claim | Status |
|---|---|
| System prompt is **1196–1496 tokens** | **Bracketed, not measured.** `count_tokens` was unreachable; two independent tokenizers plus the chars/3.6 rule give the range. Both proxies are documented to run *low* for `claude-sonnet-5` (cl100k undercounts Claude by ~15–20%; sonnet-5's new tokenizer emits ~30% more than sonnet-4.6 for the same text), so the true count is likely **above** the top of the bracket. The decision is a threshold test, and the bracket's low end already clears it. |
| Visible answer is **255–305 tokens** on these katas | **Measured** on real answers to real frames — same bracketing caveat on the tokenizer, same direction of bias. |
| Image cost is **1365 tokens** for the captured frames | **Computed** from Anthropic's documented `(w × h) / 750`, on the actual 1280×800 PNGs. |
| Thinking-token volume | **Not measured, and cannot be from here.** See "the ceiling is a thinking budget" below. |
| The prompt behaves correctly on partial / user-code / no-problem screens | **Observed** on four real frames — but by an operator with the design in context, not by `claude-sonnet-5` at `effort: medium` through the API. Fidelity caveat stated in full under "How the traces were produced". |

---

## The prompt, question by question

### Structured vs. freeform → **a fixed three-part skeleton, ordered for streaming**

`#7` already fixed the renderer's ordering: *"Code streams in first, then the explanation."*
That is not a preference the prompt may override — it is the pane's contract. So the answer is
**heading → code → prose**, and the reason is latency, not tidiness: on a streaming pane the
first thing emitted is the first thing read, and a problem restatement makes the user wait
through content they were staring at ten seconds ago.

Options weighed:

| Shape | For | Against | |
|---|---|---|---|
| Freeform | Model picks the best shape per problem | Ordering becomes non-deterministic — sometimes code first, sometimes a preamble. The pane's whole design assumes code first | rejected |
| Full academic structure (restatement → approach → code → complexity → edge cases) | Complete; good for study | Restatement is dead weight (the problem is on the other monitor); the user waits through it while the code they want streams last | rejected |
| **Heading → code → 2–3 short paragraphs** | Answer-first; the pane's contract; a heading that doubles as a history label | Slightly more rigid on unusual problems | **chosen** |

**The heading is load-bearing beyond aesthetics.** `#7`'s history drawer needs a per-entry
title and nothing else in the pipeline can supply one — change detection is a dHash, it never
reads text. Making line 1 `# <exercise title as shown on screen>` gives the drawer its label
for a `/^#\s+(.+)$/` match, costs about five tokens, reads naturally at the top of a focus
pane, and is a free sanity check: a wrong title is instant, visible evidence the model is
looking at the wrong window.

### Output format → **one fenced block, paste-ready, signature-exact**

The ticket asked about "language marker, comment style, how much walkthrough". Those matter,
but the frames surfaced a bigger lever the ticket didn't list.

**Signature fidelity is the top correctness requirement, and it isn't obvious from the prose.**
Codewars' harness calls the name it shows in the editor pane. In `09_new_problem.png` that is
`function solution(number)`; in `01_idle_a.png` it is `function highAndLow(numbers)`. Rename
either and the answer is worth nothing — it doesn't fail loudly, it fails as `solution is not
defined`. The prompt therefore names this explicitly ("`highAndLow` is not `highestAndLowest`")
rather than hoping it falls out of "write runnable code".

**The sample tests pin the return shape more precisely than the prose does.** "Return the
highest and lowest number" reads like it could be a tuple, an array, or an object. The visible
assertion — `assert.strictEqual(highAndLow("8 3 -5 42 …"), "42 -9")` — settles it: a
space-separated string. The prompt directs the model at the tests for exactly this.

**This retroactively justifies #9's refusal to crop.** #9 rejected cropping to #6's
instructions rectangle as a default, reasoning that answers need the signature and the selected
language. The frames confirm it stronger than #9 could: on Codewars the signature, the language
selector *and* the sample tests are all outside the instructions pane, and two of the three are
load-bearing for correctness. Cropping would remove the return-shape evidence, not just some
context.

Comment style: **sparing, only where the code is non-obvious.** The prose carries the reasoning;
duplicating it inline pads output tokens for no reader benefit.

### Partial-problem screenshots → **judge by determinacy, not by whether something is cut off**

The obvious rule — "if text is cut off, say so" — is wrong, and `04_scrolled.png` is the
counterexample. That frame has the opening sentence scrolled off the top: all the reader sees is
*"numbers, and have to return the highest and lowest number."* It is visibly truncated. It is
also **completely solvable**: the title, the three worked examples, the notes, the signature and
the sample tests between them determine the task exactly, and the missing half-sentence adds
nothing they don't. A prompt that flags every crop would fire a caveat here and cry wolf until
the caveat is ignored.

So the test is *what the answer needs*, not *what is missing*:

- **Determined anyway** → solve it, say nothing about the crop. ([trace b](./traces/b-04_scrolled.md) does exactly this.)
- **Something load-bearing is off screen** → still answer, with one `> **Missing:** …` line
  directly under the heading, *before* the code. Position matters: on a streaming pane the code
  arrives seconds ahead of the prose, so a caveat placed after the code arrives after the user
  has already read and copied it.
- **No exercise at all** → the bail path, below.

Two hard rules attach: never invent a constraint to fill a gap, and never silently pick one
reading of an ambiguous one — name the assumption. Options that shed the caveat entirely
("just guess forward") were rejected because a confidently wrong kata answer costs more than a
flagged one: the user reads the code, believes it, submits, and only the failing test tells them.

### Language default → **infer, with a stated precedence order; there is no fallback in practice**

Precedence: **starter scaffolding syntax → language selector → sample tests → site convention.**
Scaffolding wins ties because it is the thing the answer has to paste over. On the frames all
four agree (JavaScript / Node v18.x / a JS starter / chai tests), which is the normal case —
kata sites make the language explicit because they have to compile it.

The ticket asked what to assume "when the screenshot doesn't make the target language obvious."
The answer that survived contact with the evidence is: **that case barely exists on the sites in
scope, and where it does exist it usually isn't a language question at all** — it's Advent of
Code, which has no editor and no starter, and where the real question is "what does the program
read and print". So the prompt handles the no-editor case directly (write a self-contained
program that reads the puzzle input conventionally and prints the answer, and say which part it
solved) rather than shipping a Python default that would fire on almost nothing. A hard-coded
"assume Python" was drafted and cut: it added a rule for a case the evidence doesn't contain,
and the `> **Missing:**` line already covers a genuinely unreadable language.

### The user's half-written code → **take the signature, ignore the attempt**

`08_typing_settled.png` has the user's own in-progress line in the editor:
`// ...  return numbers.slice().sort((a,b)=>a-b);` — which is wrong (it sorts the split tokens
as strings and returns an array where a string is wanted). Three options:

| Option | Against | |
|---|---|---|
| Build on the user's approach | The editor pane is **excluded from #6's trigger gate**, so whatever code is there at solve time is arbitrary — it's whatever they'd typed when the *instructions* changed. Building on it makes the answer depend on something that isn't the trigger, and makes two solves of the same problem differ for no reason the user can see | rejected |
| Critique it ("your sort is comparing strings") | Turns an answer pane into a code review the user didn't ask for, and burns output tokens on their discarded draft | rejected |
| **Take the signature from it; write the solution you'd write** | Deterministic: same problem, same answer | **chosen** |

[Trace b](./traces/b-04_scrolled.md) and [trace c](./traces/c-08_typing_settled.md) are the same
frame with and without the user's code, and the answers are substantively identical — which is
the property this rule is for.

### "No exercise on screen" → **a bail token, and it doubles as instrumentation**

The prompt emits the literal heading `# No exercise on screen` plus one sentence, and no code,
when the window shows a dashboard, a problem list, an article, or — the synthetic negative built
for this ([trace d](./traces/d-neg_header_only.md), a 1280×210 crop of the page header) — a kata
*title* with no problem body. The instruction is explicit that a title alone is not enough to
reconstruct an exercise from, because that is precisely the tempting failure.

**This is where the map's open "detection as a separate pass" fog resolves.** #9 already settled
the cost half: a `claude-haiku-4-5` detector costs $0.0011 against a $0.025 solve, so it pays for
itself if it suppresses more than 4% of would-be solves. What stayed open was the quality
question — does a cheap model reliably recognize a kata page? — and that question cannot be
answered from a desk. It needs a rate.

The bail token produces that rate for free. Ship it in v1, count how often it fires, and the
counter *is* the "fraction of would-be solves a detector would suppress" figure #9's arithmetic
is missing. Below 4%, the detector never pays and the fog item is closed. Above 4%, it pays and
the decision has data instead of a guess. So: **no detector pass in v1; the in-prompt bail is
the v1 detector; revisit when the counter has real numbers.** That is a decision, not a deferral
— see "Handoffs" for where the counter lives.

---

## The request around the prompt

`#5` sealed request mechanics inside the seam, so these are seam-internal, but they are
prompt-design decisions and belong here.

**The user turn is the image plus one fixed line: `Solve the exercise in this screenshot.`**
A bare image-only user turn is legal, but the line is seven tokens of cheap insurance against
an ambiguous turn, and it sits *after* the cache breakpoint so it costs nothing per call beyond
its own tokens.

**No assistant prefill.** Prefilling `#` to force the heading is the technique an implementer
will reach for, and it is a dead end twice over: last-assistant-turn prefill **returns a 400 on
`claude-sonnet-5`** (and on every 4.6-and-later Opus/Sonnet model), and structured outputs —
the documented replacement — force JSON, which is the wrong container for a streaming markdown
pane. Written down here so nobody loses an hour to it.

**Thinking stays adaptive.** On `claude-sonnet-5`, omitting the `thinking` parameter *is*
adaptive thinking. #9's "never ship `thinking: {type: 'disabled'}`" holds and is now better
grounded: disabling it is documented to leak `<thinking>` tags into visible output and to make
the model occasionally write a tool call as plain text. `effort` is the cost lever; `thinking`
is not a knob to touch.

---

## Prompt caching: **turn it on, `ttl: "1h"`**

#9 left this conditional on this ticket's output and it now resolves cleanly.

```
system-prompt.md   5387 chars   anthropic 1274t   cl100k 1196t   chars/3.6 1496t   -> 1196–1496 t

  claude-sonnet-5   min 1024 t   CACHEABLE (low bracket clears by 172 t)
  claude-opus-5     min  512 t   CACHEABLE (low bracket clears by 684 t)
```

The prompt clears `claude-sonnet-5`'s 1024-token minimum on the *pessimistic* end of the
bracket, and both known tokenizer biases push the true number higher still. It clears
`claude-opus-5`'s 512 comfortably, so the decision holds if the user switches models.

**The inversion worth naming: above the threshold, a longer prompt is a *cheaper* prompt.**
Cache reads bill at 0.1×; a 1h write bills at 2×.

| Solves within the TTL window | Uncached | Cached (1h) | |
|---:|---:|---:|---|
| 1 | $0.0036 | $0.0072 | costs $0.0036 |
| 2 | $0.0072 | $0.0075 | costs $0.0004 |
| 3 | $0.0108 | $0.0079 | **saves $0.0029** |
| 20 | $0.0718 | $0.0140 | **saves $0.0578** |
| 60 | $0.2153 | $0.0283 | **saves $0.1869** |

Break-even is three solves inside the hour. So a prompt at ~1200 tokens *with* caching costs
less per session than one at 800 tokens without — which is why the prompt was allowed to grow
into the room rather than being squeezed. The extra room bought two things that earn it: the
no-editor clause (Advent of Code has no signature to match, and without the clause the
"reproduce the scaffolding exactly" rule has nothing to reproduce) and a worked example of the
bail format, which is the branch the app pattern-matches on and therefore the branch that most
needs pinning.

**Recommend on unconditionally, no adaptive logic.** The loss case is real but tiny: a user who
solves exactly one kata per hour, all day, pays about **3 cents/day** more than uncached. Logic
to detect that pattern and skip the cache costs more in complexity than it can ever save.

Mechanics: `cache_control: {type: "ephemeral", ttl: "1h"}` on the single system block. Render
order is tools → system → messages, so the breakpoint sits after the whole prompt and before the
image, which is correct — the image differs every call and must stay outside the cached prefix.
The cache is per-model, so a model switch in settings pays one cold write and then amortizes
again. **Pre-warming was considered and rejected**: it trades a guaranteed write for a
speculative read, and Anthropic's own guidance is to skip it exactly when traffic is bursty with
gaps longer than the TTL — which is the definition of kata pacing.

This makes #9's already-requested `cacheReadInputTokens` / `cacheCreationInputTokens` on
`done.usage` **mandatory rather than prophylactic**: with caching on from v1, a cost estimate
that ignores them is wrong on every call after the first.

---

## `effort: medium` + `max_tokens: 8000`: the ceiling is a thinking budget

#9 asked this ticket to validate that the pair doesn't truncate. Here is what can and cannot be
concluded without an API key.

**Measured:** the visible answer on these katas is **255–305 tokens** — under **4% of the 8000
ceiling**. #9's cost model assumed 1200 output tokens at medium effort. If that figure is right,
then roughly 900 of it is thinking, and #9's per-solve estimates are conservative rather than
optimistic. That is the useful reframing: **`max_tokens: 8000` is, in practice, entirely a
thinking budget.** Truncation requires thinking to exceed ~7700 tokens on a kata.

**Not measured, and not measurable from here:** the thinking volume itself. Two things make
truncation unlikely — `claude-sonnet-5` is documented to respect effort strictly at the low end,
scoping work to what was asked rather than going beyond it at `low`/`medium`; and `medium` on
sonnet-5 is documented as comparable to `claude-sonnet-4-6` at `high`, so it is not a starved
setting. But "unlikely" is not "validated," and the sample here is four frames of two easy katas
(6 kyu and 7 kyu) on one site in one language. A 1-kyu problem or a LeetCode Hard will produce a
longer answer *and* more thinking.

**So the recommendation is not "the number is fine" — it is "make truncation detectable."**
Keep `max_tokens: 8000` (lowering it trades a bounded cost saving for a failure that ships
broken code), and have the app *notice* when it happens instead of assuming it won't. A
truncated answer is the nastiest failure in this app's whole surface: a code block cut off
mid-function looks complete enough to copy, and the user finds out from a syntax error. The API
reports `stop_reason: "max_tokens"` for exactly this — the seam just has to pass it through.
That is an amendment to #5 and a new failure class for #13.

**#9's output-token estimates:** replaced for the visible portion (255–305 t measured, not the
guessed 1200), unreplaced for thinking. `measure.js` reports both, and the cost model's
`SYSTEM = 600` placeholder should become the measured ~1200 (or ~120 effective, cached) whenever
`09-cost-model/` is next re-run.

---

## How the traces were produced — and what they are worth

Four frames were run through the prompt: [`09_new_problem`](./traces/a-09_new_problem.md) (clean,
full view), [`04_scrolled`](./traces/b-04_scrolled.md) (partial), [`08_typing_settled`](./traces/c-08_typing_settled.md)
(user's code present), and a synthetic negative cropped from `01_idle_a.png` to the page header
only ([`d-neg_header_only`](./traces/d-neg_header_only.md)).

**Fidelity, stated plainly.** No API key was available and this session could not spawn a
subagent, so the prompt was executed by the operating agent (Claude Opus 5) rather than by
`claude-sonnet-5` at `effort: medium` through the seam. That is a real limitation with a real
direction of bias: an operator holding the prompt's design in context is *more* likely to comply
with its format than a cold model would be, so the traces are weak evidence about format
compliance and strong evidence about everything else — that the signature and return shape are
recoverable from these screenshots at all, that `04_scrolled` is solvable without a caveat, that
the user's code doesn't perturb the answer, that a title-only screen is correctly refused, and
roughly how long an answer runs. Re-run them against the real seam at first light; the format
claim is the one to re-check.

**Not covered by this sample:** any site other than Codewars, any language other than JavaScript,
any difficulty above 6 kyu, and Advent of Code's no-editor shape — which the prompt handles by
reasoning rather than by evidence, and which is the most likely place for it to be wrong.

---

## The prompt is in `config.json`, not in the settings UI

Ships as a default value in #8's `config.json`, editable by anyone who opens the file, and
**absent from the settings pane**. Rationale: it's a genuine power-user escape hatch that costs
nothing to expose in a file the user already owns, while the settings pane stays about the four
things that actually matter day to day (interval, target window, model, budget). A bad edit is
recoverable by deleting the key. One caveat belongs in the config comment: **an edited prompt
that drops below 1024 tokens silently loses caching** — no error, just a quietly larger bill.

---

## Handoffs and amendments

**To #5 (provider seam) — three amendments, all small, all load-bearing:**

1. **`done` must carry `stopReason`.** Without it the app cannot distinguish a complete answer
   from one guillotined at `max_tokens`, and the guillotined one is a half-written code block
   that looks runnable. This is the only way to honour #9's "validate that medium + 8000 doesn't
   truncate" without an oracle: don't assert it won't, detect it when it does.
2. **`SolveEvent` must distinguish thinking from answer text.** Two independent reasons.
   (a) #7's status pill already speaks `thinking` *and* `streaming` — it can only make that
   transition if the seam signals it, and with adaptive thinking on there is a real multi-second
   gap before the first answer token. (b) #9 requires that thinking text never reach the answer
   pane. Concretely: Anthropic's stream emits `content_block_delta` with `delta.type` of
   `thinking_delta` or `text_delta`; map only `text_delta` to `delta`, and emit
   `thinking_delta` as a distinct event rather than dropping it — dropping it forecloses (b)
   below for no saving.
3. **The seam sets `cache_control: {type: 'ephemeral', ttl: '1h'}` on the system block,
   always** — no config flag. It's request mechanics, correctly sealed inside per #5, and the
   prompt clears the minimum on both candidate models. If a user edits the prompt below the
   minimum it silently no-ops, which is harmless. #9's `cacheReadInputTokens` /
   `cacheCreationInputTokens` on `done.usage` are now mandatory, not prophylactic.

   Also for the implementer: `effort` goes inside `output_config`, not top-level.

**To #7 (the output window) — two, one free:**

- **The history drawer's per-entry title is the answer's first line.** Parse `/^#\s+(.+)$/`.
  Nothing else in the pipeline can produce a title, and this costs nothing.
- **Thinking summaries are free — consider showing them.** `thinking.display` defaults to
  `"omitted"` on `claude-sonnet-5`, which streams thinking blocks with *empty* text: to the pane
  that is a dead region for several seconds before the answer starts. Setting
  `display: "summarized"` returns a readable summary and is **billed identically** — display
  controls visibility only. Recommendation: set it, and render it as a de-emphasized strip that
  the answer replaces on the first `text_delta`. It converts the wait from "is this broken?" into
  visible progress for zero marginal cost. Requires seam amendment (2) above.

**To #13 (failure and edge-case behavior) — four additions to the taxonomy:**

- **Truncation** (`stop_reason: "max_tokens"`) is a failure class the ticket doesn't list.
  Detection is seam amendment (1). Response: mark the answer `truncated` in the pane and in
  history. It is the "bad output" analogue of #13's "bad frames" — and worse, because a bad
  frame is obvious while a truncated code block is not.
- **The thinking gap.** #7's pill already has a `thinking` state; #13 should specify the
  transition and what the pane holds meanwhile. Recommendation: **keep the previous answer
  visible until the first `text_delta`** rather than blanking on trigger, so a mis-fired solve
  doesn't destroy what the user was reading.
- **`# No exercise on screen`** is a *successful, fully-billed* response containing no answer —
  a state #13's taxonomy has no slot for. Recommendation: pill returns to `watching`, an
  unobtrusive in-pane line, **no history entry** (the drawer should hold answers), and **a
  counter in settings** — that counter is the measurement the detector-pass question needs.
- **`refusal` is reachable.** A proctored assessment or a security-flavoured exercise is exactly
  the shape a model may decline, and `claude-sonnet-5` carries elevated safeguards. #5 surfaces
  it immediately; #13 should give it its own message, because "retry" is useless and the generic
  error copy would invite it. Note `stop_details` can be `null` even on a refusal — branch on
  `stop_reason`.

**To #9 (cost control) — no caps change; two figures move in the safe direction:**

- Turn prompt caching **on**, `ttl: "1h"`. The effective per-call system cost drops from #9's
  assumed 600 tokens to ~120 (cached), so every one of #9's per-solve figures stays conservative.
- Replace `SYSTEM = 600` in `09-cost-model/cost-model.js` with the measured ~1200 uncached /
  ~120 cached, and the visible-output guess with 255–305 t, when it's next re-run. The four
  limits and their defaults are unaffected.

**Closing map fog — "detection as a separate pass":** decided for v1. **No separate detector
pass ships.** The in-prompt `# No exercise on screen` bail is the v1 detector; its counter is the
instrumentation that turns #9's 4% break-even from arithmetic into a measurement. Revisit after
v1 has run, with the rate in hand.
