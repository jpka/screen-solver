# 09 — Cost model

Throwaway arithmetic backing ticket [#9 — Cost control](https://github.com/jpka/screen-solver/issues/9).
Not product code. `node cost-model.js` prints everything.

## Why it exists

The ticket asks for "specific limits and their defaults, justified against the
grounded per-call cost." That justification needs a number for a *solve*, not a
number per token — and the per-solve number depends on four things that interact:
model, image size after downscaling, thinking volume (via `effort`), and the
`max_tokens` ceiling. This script makes those four knobs explicit so the defaults
in the ticket are computed rather than asserted, and so they can be recomputed
when prices move.

## Grounded inputs

| Model | $/MTok in | $/MTok out | Vision tier |
|---|---|---|---|
| `claude-opus-5` | 5 | 25 | high-res: 2576 px long edge, ~4784 image tokens max |
| `claude-sonnet-5` | 3 | 15 (intro 2 / 10 through 2026-08-31) | high-res: same |
| `claude-haiku-4-5` | 1 | 5 | standard: 1568 px long edge, ~1600 image tokens max |

Image tokens ≈ `(width × height) / 750`, capped by the model's tier.
Prompt caching: write 1.25× (5 min TTL) or 2× (1 h TTL), read 0.1×; minimum
cacheable prefix 512 t on `claude-opus-5`, 1024 t on `claude-sonnet-5`.

**Thinking tokens bill at the output rate.** On `claude-opus-5` adaptive thinking
is on by default and `effort` defaults to `high` — so the naive "just swap the
model string" configuration is also the most expensive one.

## Load-bearing results

- **A solve costs $0.02–$0.09**, and $0.13–$0.21 in the worst configuration where
  the answer runs to the `max_tokens` ceiling. Shipped defaults land at **$0.025**.
- **`effort` is a bigger lever than image size.** Downscaling a 1440p capture from
  native to 1024 px long edge saves $0.012/call; moving `effort` from `high` to
  `low` saves $0.028/call. Input is only 29–47% of a call.
- **Unguarded, a misfiring change detector on a 5 s interval costs $18/hour**
  at defaults and $153/hour in the worst configuration. That number is what
  justifies a hard circuit breaker independent of the spend cap.
- **Prompt caching only helps once the system prompt clears the model's minimum**
  (1024 t on `claude-sonnet-5`), and then only with the **1-hour** TTL — the
  5-minute TTL expires between problems at kata pacing. At 2000 t it saves ~17%
  of a 20-solve session; at 600 t it is not cacheable at all.
- **A cheap Haiku "is there a question here?" detector pass is nearly free**
  ($0.0011/check at 1024 px) and pays for itself if it suppresses more than 4% of
  would-be solves — relevant to the map's open "detection as a separate pass" fog.

## Caveats

- Image-token counts are the documented approximation, not `count_tokens` against
  real captures. Re-measure once the WGC pipeline exists.
- Output-token volumes (600 / 1200 / 2500 / 4000 for low / medium / high / xhigh)
  are estimates for a kata-sized answer plus thinking, not measured. Ticket #11
  should replace them with real numbers when it validates the solve prompt.
- The price table is a snapshot. This is exactly why the ticket requires the
  shipped table to be user-editable rather than compiled in.
