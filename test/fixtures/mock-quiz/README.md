# The mock quiz

A fixed set of problems covering the three ways a question can reach this app,
used by an automated suite and by a human at a real Windows machine — from one
fixture, so the two can't test different quizzes.

| Kind | On screen | Said out loud | Button | Right answer |
| --- | --- | --- | --- | --- |
| `screen` | the exercise | nothing | Solve now | a solution |
| `voice` | no exercise | the whole problem | Solve with transcript | `# No exercise on screen` |
| `voice-about-screen` | the exercise | a constraint on it | Solve with transcript | a solution shaped by what was said |

The `voice` row is the one worth being clear about: a spoken-only problem is
*expected to bail*. The system prompt makes the screenshot the sole authority
on whether there is anything to solve ("someone talking about a problem is not
a problem on screen"), so a run where the model answers the spoken question is
a failing run, not an impressive one. Two of the six problems exist to catch
exactly that.

## Files

- `quiz.json` — the quiz. The only copy; everything else reads it.
- `quiz.ts` — the typed, validated read side, used by `test/e2e/mock-quiz.e2e.test.ts`.
- `index.html`, `quiz-page.js`, `quiz-page.css` — the manual rig: a fake kata
  site that renders each problem and speaks the voice lines through the
  machine's speakers.

`quiz.json` rather than a `.ts` module holding the same array because the rig is
a browser page, and nothing served to a browser in this repo can import from
`src/` or `test/` (`AGENTS.md`, "Hidden-renderer IPC / preload scripts"). One
file, `fetch`ed by the page and `readFile`d by the suite.

## Automated

```
npm test                                  # the whole suite, quiz included
node --test test/e2e/mock-quiz.e2e.test.ts   # just this
```

It boots the real host (`bootstrapHost`, real config store, real solve loop,
real JSONL logs) and walks every problem in the fixture through the HTTP
surface a browser has. The provider and the transcription socket are faked, so
what it proves is the plumbing, not the model: which route carries speech and
which never does, that a screenshot goes out on every solve, that the text
reaching the model is the speech that was captured, and that each problem
leaves the right pair of log lines — including the bail's usage-only line.

Adding a problem to `quiz.json` adds it to that walk automatically. `quiz.ts`
rejects a problem whose kind, screen, speech and expected outcome don't line
up, so the taxonomy can't quietly rot.

## Manual

What this can't fake: real speech, out of real speakers, into Windows'
render-loopback capture, transcribed by real Deepgram, answered by a real
model. That is the whole reason the rig exists.

1. Start the app (`npm start`) with `ANTHROPIC_API_KEY` and `DEEPGRAM_API_KEY`
   in `.env`, and open the web client on your phone or a second window.
2. Serve the quiz and open it in a browser window on the machine being watched:

   ```
   npm run mock-quiz     # http://127.0.0.1:4321
   ```

3. In the web client, pick the quiz's browser window as the target. Its title
   tracks the problem on screen, so the picker shows e.g. `Sum of Positive |
   Codewars`.
4. Press **Start recording** in the client. Check the transcript pane fills as
   you speak or as the rig does — the audio device the browser plays through
   has to be the one Windows is rendering to, and it must not be muted.
5. Walk the quiz. For each problem the rig's bar says which button its kind
   calls for:
   - `←` / `→` move between problems,
   - `s` speaks the current problem's lines,
   - `p` hides the rig bar for a clean screenshot,
   - `e` opens the crib sheet — the spoken script, what a good answer contains,
     and a worked answer to compare against.
6. Press the button the bar names, and grade what comes back against the crib
   sheet.

**Close the crib sheet before you press Solve.** It is on screen while it is
open, which turns a voice-only problem into a screen problem and hands the
model the answer key. The rig says so in the panel itself, in the one place
you'll be looking when it matters.

### What to look for

- A `screen` problem: the heading is the title on screen, the code block
  reproduces the visible signature exactly (`positiveSum(arr)`, not
  `sumPositive(numbers)`), and the sample tests' return type is respected.
- A `voice` problem: `# No exercise on screen` verbatim, one sentence naming
  what is there instead, no code. Anything that solves the spoken problem is a
  failure worth filing.
- A `voice-about-screen` problem: the exercise from the screen, solved the way
  the speech asked (iteratively, in linear time), with one clause saying the
  spoken constraint steered it — and nothing invented that was only spoken.
- Afterwards: `answers.jsonl` has a line per solved problem and none for the
  bails, `usage.jsonl` has one per attempt with `bail: true` on the voice-only
  ones, and `transcript.jsonl` has every line the rig said.
