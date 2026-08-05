# Configuration and API key storage

Parent: [Screen Solver](../map.md)
Type: grilling
Status: open
Blocked by: 02

## Question

What is configurable, where does that configuration live, and how is the API key stored?

Two halves — ordinary settings, and one genuinely security-relevant decision.

**Configuration:**

- What the user can set: capture interval, target window, provider and model, change-detection sensitivity, anything ticket 06 surfaces.
- Where it's stored and in what format.
- How the target window is remembered across restarts — a window handle is not stable, so what identifies "the window I picked last time", and what happens when it can't be found.
- Whether settings are edited in-app or in a file, and whether changes take effect live or need a restart.

**API key storage** — this is the decision that matters:

- Windows Credential Manager, DPAPI-encrypted local file, an environment variable, or plaintext config. What each actually protects against on a single-user desktop machine, and what it doesn't.
- Whether the key is ever written somewhere it could end up in a log, a crash dump, or a screenshot the app itself takes.
- What the first-run experience is for getting a key in, without the app ever displaying it back.
- Where the key lives at runtime once loaded.

Be concrete about the threat model rather than defaulting to the most elaborate option — this is a personal tool on a personal machine, and the right answer should be argued for, not assumed.
