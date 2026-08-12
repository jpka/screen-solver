# The mock quiz

A fixed set of problems covering the three ways a question can reach this app,
used by an automated suite and by a human at a real Windows machine — from one
fixture, so the two can't test different quizzes.

| Kind | On screen | Said out loud | Button | Right answer |
| --- | --- | --- | --- | --- |
| `screen` | the exercise | nothing | Solve now | a solution |
| `voice` | no exercise | the whole problem | Solve speech only | a solution to the spoken question |
| `voice` | no exercise | the whole problem | Solve with transcript | `# No exercise on screen` |
| `voice-about-screen` | the exercise | a constraint on it | Solve with transcript | a solution shaped by what was said |

The `voice` row now has a button of its own, and two right answers depending
on which one is pressed. **Solve speech only** sends nothing but the
transcript — no screenshot exists for that request at all, so the transcript
*is* the question, and a real answer is the correct one: an idiomatic name and
signature the model invents itself, and a language it either takes from the
speech or assumes and declares (a `> **Missing:**` line, same mechanism a
partially-visible screen already uses for an assumption). **Solve with
transcript**, pressed on the very same problem, still sends the catalogue or
call screenshot the problem shows — and that screenshot still has no exercise
on it, so that button must still bail with `# No exercise on screen`. The
system prompt makes the screenshot the sole authority on whether there is
anything to solve whenever a screenshot exists at all ("someone talking about
a problem is not a problem on screen"), and the mock quiz is built to prove
the new speech-only capability didn't quietly relax that: every `voice`
problem carries both expectations, and a run where the screen-carrying button
answers the spoken question anyway is a failing run, not an impressive one.

One `voice` problem, `voice-only-no-question`, exists for the other new
marker: its speech is small talk that asks nothing a program could answer, so
even its own speech-only button must bail — with `# No question in the recent
speech` rather than `# No exercise on screen`, since that request never saw a
screen to report on. `quiz.ts`'s `expectationFor(problem, route)` is how a
test (or a human at the crib sheet) asks "what should pressing THIS button
produce for THIS problem" without hand-branching on kind.

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
5. Walk the quiz. For each problem the rig's bar says which button(s) its kind
   calls for — a `voice` problem names both, since it now has two right
   answers to check, one per button:
   - `←` / `→` move between problems,
   - `s` speaks the current problem's lines,
   - `p` hides the rig bar for a clean screenshot,
   - `e` opens the crib sheet — the spoken script, what a good answer contains
     for each button that applies, and a worked answer to compare against.
6. Press the button (or, for a `voice` problem, each button in turn) the bar
   names, and grade what comes back against the crib sheet.

**Close the crib sheet before you press Solve.** It is on screen while it is
open, which turns a voice-only problem into a screen problem and hands the
model the answer key. The rig says so in the panel itself, in the one place
you'll be looking when it matters.

### What to look for

- A `screen` problem: the heading is the title on screen, the code block
  reproduces the visible signature exactly (`positiveSum(arr)`, not
  `sumPositive(numbers)`), and the sample tests' return type is respected.
- A `voice` problem, pressed **Solve speech only**: a real answer, headed with
  a title the model wrote itself (there is no on-screen title to copy), a
  signature and language it chose the same way, and — since nothing on screen
  fixed the language — a `> **Missing:**` line naming the assumption. For
  `voice-only-no-question`, whose speech asks nothing answerable, the right
  answer is instead `# No question in the recent speech` verbatim, one
  sentence naming what was said instead, no code.
- The same `voice` problem, pressed **Solve with transcript** instead:
  `# No exercise on screen` verbatim, one sentence naming what is there
  instead, no code — even though the identical speech just got a real answer
  through the other button. Anything that solves the spoken problem here is a
  failure worth filing; the screen stays authoritative whenever a screenshot
  is actually sent.
- A `voice-about-screen` problem: the exercise from the screen, solved the way
  the speech asked (iteratively, in linear time), with one clause saying the
  spoken constraint steered it — and nothing invented that was only spoken.
- Afterwards: `answers.jsonl` has a line per solved problem (now including a
  spoken-only one, with a `null` target) and none for the bails, `usage.jsonl`
  has one per attempt with `bail: true` on the bails, and `transcript.jsonl`
  has every line the rig said.
