# Cost control

Parent: [Screen Solver](../map.md)
Type: grilling
Status: resolved
Blocked by: 03

## Question

What stops this app from quietly spending real money?

An always-on loop that sends a large screenshot to a frontier vision model is a standing bill. Change detection (ticket 05) removes the redundant calls; this ticket bounds what's left.

**Grounded cost baseline** (v1 is Anthropic-only, [decided in ticket 03](03-vision-provider-comparison.md)): `claude-opus-5` is $5/$25 per MTok input/output, `claude-sonnet-5` is $3/$15 per MTok, and both sit in the high-resolution vision tier — up to ~4784 image tokens per image at the 2576px long-edge cap. Use these numbers directly; there is no comparison document to wait on.

Decide:

- **The budget mechanism.** A hard call ceiling per hour or per day, a spend estimate the user sets, or a cooldown floor between calls. Which, and what happens when it's hit — stop, warn, or degrade to a cheaper model.
- **Visibility.** Does the app show a running count or estimated spend, computed from the grounded per-call numbers above?
- **Manual pause.** How the user stops the loop without closing the app, and whether the app should auto-pause when the target window has been idle for a while.
- **Image size as a cost lever.** Whether to downscale or crop before sending — weigh the ~4784-token ceiling against fidelity loss on small problem text.
- **Runaway protection.** What happens if change detection misfires and every tick registers as a change — is there a circuit breaker independent of the budget?
- **Default posture.** Whether the app ships conservative (low ceiling, user raises it) or permissive.

Deliverable: the specific limits and their defaults, justified against the grounded per-call cost above.
