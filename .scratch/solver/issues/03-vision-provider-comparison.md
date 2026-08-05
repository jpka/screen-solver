# Vision provider comparison

Parent: [Screen Solver](../map.md)
Type: research
Status: resolved
Blocked by: —

## Question

For the specific job of *reading a screenshot of a dense coding-problem statement and producing a working solution*, how do the candidate vision LLM providers compare — and which is the v1 default?

The map has settled that the provider is pluggable, so this is not a lock-in decision. It is a "what ships first, and what shapes does the seam have to accommodate" decision.

Compare across **Anthropic** and **OpenAI** at minimum (add others if the research surfaces a strong candidate):

- **Vision quality on dense text.** A kata screenshot is small-font problem text, code blocks, and often a partially-scrolled pane — not a photo. Which models read that reliably?
- **Image input mechanics.** Accepted encodings, max resolution before downscaling, and what the provider does to an image that exceeds it. Relevant because a 1440p browser window is a large image.
- **Image token cost per call.** The dominant cost driver for this app — a full-window screenshot on a high-resolution model can be several thousand tokens. Quantify per-call cost at realistic window sizes.
- **Streaming.** Whether token-by-token streaming works alongside image input, since the app streams the answer as it arrives.
- **Rate limits** at a hobbyist tier, and what happens on a burst.
- **API shape differences** that the seam in ticket 04 will have to absorb — how images attach to a request, how streaming events are framed, how errors and refusals surface.

**Grounded starting point (already verified, don't re-derive):** the Anthropic Messages API takes images as base64 or URL `image` content blocks, supports native streaming, and its current vision-capable models are `claude-opus-5` (1M context, $5/$25 per MTok) and `claude-sonnet-5` ($3/$15). Opus 5 and Sonnet 5 both sit in the high-resolution tier — 2576px long edge, up to ~4784 image tokens per image — which is directly relevant to the cost question above. Compare the others against this baseline.

Land on: a recommended v1 default provider and model, with the cost-per-call number that justifies it.

## Notes

Two background research attempts were launched on this ticket and both were killed before producing findings — no comparison document exists at `../research/vision-providers.md`. The user then cancelled the comparison and made the call directly (see Answer below).

## Answer

**Resolved directly by the user, without the planned comparison research: use the Anthropic API only for v1.** No cross-provider comparison is needed.

- Model choice within Anthropic (`claude-opus-5` vs `claude-sonnet-5`) is not decided here — left to ticket 04 (provider seam) or a later ticket if it needs its own decision.
- The seam (ticket 04) still gets designed so a second provider could be added later — "pluggable" survives as an architecture goal even though only Anthropic ships in v1.
- Ticket 08 (cost control) uses the grounded Anthropic numbers directly instead of waiting on this ticket: `claude-opus-5` $5/$25 per MTok, `claude-sonnet-5` $3/$15 per MTok, both up to ~4784 image tokens per image at the 2576px high-resolution tier.
