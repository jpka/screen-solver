# Solve-call prompt design

Parent: [Screen Solver](../map.md)
Type: grilling
Status: open
Blocked by: 04

## Question

What should the system prompt — the `systemPrompt` string the provider seam ([ticket 04](04-provider-seam.md)) takes at construction time — actually say?

Decide:

- **Output format.** How the prompt instructs the model to produce runnable code plus an explanation — language marker, comment style, how much walkthrough versus just the answer.
- **Structured vs. freeform.** Whether the prompt asks for a fixed shape (e.g. problem restatement, approach, code, complexity) or leaves the response freeform.
- **Partial-problem screenshots.** How the prompt should handle a screenshot that only shows part of the problem (a scrolled pane, cut-off constraints) — told to say what's missing rather than guess forward, or something else.
- **Language/environment default.** Katas span many languages; what the prompt assumes when the screenshot doesn't make the target language obvious.

Deliverable: the system prompt text (or a template for it), justified against these questions.
