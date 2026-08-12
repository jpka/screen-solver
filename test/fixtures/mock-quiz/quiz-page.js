// The mock quiz's manual rig: one page that puts each of `quiz.json`'s
// problems on screen the way a kata site would, and says the spoken ones out
// loud through the machine's speakers so the app's own loopback capture picks
// them up.
//
// Dependency-free vanilla JS for the same reason `static/client/app.js` is
// (AGENTS.md, "Product code: toolchain and layout"), and it reads the fixture
// over `fetch` rather than importing it, because nothing served to a browser
// in this repo can reach a module under `src/` or `test/`. `quiz.json` is
// therefore the one copy of the quiz; `quiz.ts` next door is the typed read
// side the automated suite uses.
//
// Two rules this page is built around:
//
//   1. The spoken script is never rendered on the stage. A voice-only problem
//      exists to prove the model bails on a screen with no exercise on it; a
//      page that printed the question would be testing the opposite thing.
//   2. Nothing here talks to the Screen Solver host. Solves are triggered from
//      the real web client, on whatever device you would really use -- this
//      page only produces the screen and the sound.

(() => {
  'use strict';

  /** How long to leave between two spoken lines. Not the fixture's own gaps -- see `atSeconds`. */
  const SPEECH_GAP_MS = 700;

  const KIND_LABELS = {
    screen: 'screen only',
    voice: 'voice only',
    'voice-about-screen': 'voice about the screen',
  };

  const PRESS_LABELS = {
    screen: 'press “Solve now”',
    voice: 'press “Solve with transcript”',
    'voice-about-screen': 'press “Solve with transcript”',
  };

  const stage = document.getElementById('stage');
  const position = document.getElementById('rig-position');
  const kindLabel = document.getElementById('rig-kind');
  const pressLabel = document.getElementById('rig-press');
  const prevButton = document.getElementById('prev-problem');
  const nextButton = document.getElementById('next-problem');
  const speakButton = document.getElementById('speak');
  const stopButton = document.getElementById('stop-speaking');
  const presentButton = document.getElementById('present');
  const voiceSelect = document.getElementById('voice-select');
  const rateInput = document.getElementById('rate');
  const speechStatus = document.getElementById('speech-status');
  const crib = document.getElementById('crib');
  const cribBody = document.getElementById('crib-body');

  const speech = window.speechSynthesis ?? null;

  /** @type {{problems: Array<object>} | null} */
  let quiz = null;
  let index = 0;
  /** Bumped on every navigation and every stop, so a queued line from a superseded run never speaks. */
  let speechRun = 0;

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                  */
  /* ---------------------------------------------------------------------- */

  fetch('./quiz.json')
    .then((response) => {
      if (!response.ok) throw new Error(`GET quiz.json -> ${response.status}`);
      return response.json();
    })
    .then((loaded) => {
      quiz = loaded;
      index = indexFromHash();
      render();
    })
    .catch((error) => {
      stage.innerHTML = '';
      const problem = document.createElement('p');
      problem.className = 'load-error';
      problem.textContent =
        `Could not load quiz.json (${error.message}). ` +
        'Serve this directory with `npm run mock-quiz` rather than opening the file directly — ' +
        'a file:// page cannot fetch its own siblings.';
      stage.append(problem);
    });

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ---------------------------------------------------------------------- */

  function current() {
    return quiz === null ? null : quiz.problems[index] ?? null;
  }

  function render() {
    const problem = current();
    if (problem === null) return;

    document.title = problem.screen.windowTitle;
    window.location.hash = problem.id;

    position.textContent = `${index + 1} / ${quiz.problems.length} · ${problem.id}`;
    kindLabel.textContent = KIND_LABELS[problem.kind] ?? problem.kind;
    kindLabel.dataset.kind = problem.kind;
    pressLabel.textContent = PRESS_LABELS[problem.kind] ?? '';

    speakButton.disabled = problem.spoken.length === 0 || speech === null;
    speakButton.textContent =
      problem.spoken.length === 0 ? 'Nothing to speak' : `Speak (${problem.spoken.length})`;

    stage.innerHTML = '';
    stage.append(
      problem.screen.kind === 'exercise'
        ? exercisePage(problem.screen)
        : noExercisePage(problem.screen),
    );

    renderCrib(problem);
    setSpeechStatus(speech === null ? 'This browser has no speech synthesis.' : 'Idle.');
  }

  /** A kata page: statement, examples, constraints, editor pane, sample tests. */
  function exercisePage(screen) {
    const page = element('article', 'page');

    page.append(siteBar(screen));

    const title = element('h1', 'exercise-title');
    title.textContent = screen.title;
    page.append(title);

    const columns = element('div', 'columns');

    const left = element('section', 'statement');
    for (const paragraph of screen.statement) {
      const p = element('p');
      p.textContent = paragraph;
      left.append(p);
    }
    if (screen.examples.length > 0) {
      left.append(heading('Examples'));
      for (const example of screen.examples) {
        const pre = element('pre', 'example');
        pre.textContent = example;
        left.append(pre);
      }
    }
    if (screen.constraints.length > 0) {
      left.append(heading('Constraints'));
      const list = element('ul', 'constraints');
      for (const constraint of screen.constraints) {
        const item = element('li');
        item.textContent = constraint;
        list.append(item);
      }
      left.append(list);
    }

    const right = element('section', 'editor-column');

    const toolbar = element('div', 'editor-toolbar');
    const language = element('span', 'language-select');
    language.textContent = screen.languageLabel;
    toolbar.append(language, element('span', 'editor-tab-run'));
    right.append(toolbar);

    const editor = element('pre', 'editor');
    editor.textContent = screen.starterCode;
    right.append(editor);

    right.append(heading('Sample tests', 'tests-heading'));
    const tests = element('pre', 'sample-tests');
    tests.textContent = screen.sampleTests;
    right.append(tests);

    columns.append(left, right);
    page.append(columns);
    return page;
  }

  /** A page with nothing solvable on it -- the whole point of the voice-only problems. */
  function noExercisePage(screen) {
    const page = element('article', 'page page-no-exercise');
    page.append(siteBar(screen));

    const title = element('h1', 'exercise-title');
    title.textContent = screen.title;
    page.append(title);

    const description = element('p', 'page-description');
    description.textContent = screen.description;
    page.append(description);

    const list = element('ul', 'catalogue');
    for (const item of screen.items) {
      const entry = element('li');
      entry.textContent = item;
      list.append(entry);
    }
    page.append(list);
    return page;
  }

  function siteBar(screen) {
    const bar = element('div', 'site-bar');
    const brand = element('span', 'site-brand');
    brand.textContent = screen.site;
    const nav = element('nav', 'site-nav');
    for (const label of ['Practice', 'Discuss', 'Leaderboard', 'Account']) {
      const link = element('span', 'site-nav-item');
      link.textContent = label;
      nav.append(link);
    }
    bar.append(brand, nav);
    return bar;
  }

  function renderCrib(problem) {
    cribBody.innerHTML = '';

    const why = element('p', 'crib-why');
    why.textContent = problem.why;
    cribBody.append(why);

    if (problem.spoken.length > 0) {
      cribBody.append(heading('Spoken script'));
      const list = element('ol', 'crib-script');
      for (const line of problem.spoken) {
        const item = element('li');
        item.textContent = `${line.atSeconds}s — ${line.text}`;
        list.append(item);
      }
      cribBody.append(list);
    }

    cribBody.append(heading('Expected'));
    const expected = element('p');
    expected.textContent =
      problem.expected.outcome === 'bail'
        ? `Bail: the heading "# ${problem.expected.title}", no code block.`
        : `A solution headed "# ${problem.expected.title}".`;
    cribBody.append(expected);

    if (problem.expected.mustMention.length > 0) {
      const list = element('ul', 'crib-checklist');
      for (const fragment of problem.expected.mustMention) {
        const item = element('li');
        item.textContent = fragment;
        list.append(item);
      }
      cribBody.append(list);
    }

    const notes = element('p', 'crib-notes');
    notes.textContent = problem.expected.notes;
    cribBody.append(notes);

    const answer = element('details', 'crib-answer');
    const summary = document.createElement('summary');
    summary.textContent = 'A good answer, for comparison';
    const pre = element('pre');
    pre.textContent = problem.scriptedAnswer;
    answer.append(summary, pre);
    cribBody.append(answer);
  }

  /* ---------------------------------------------------------------------- */
  /* Speech                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Speaks the current problem's lines in order, through whatever output
   * device the browser is using -- which is the whole mechanism under test on
   * the audio side: Windows render-loopback captures that device, so this is
   * real speech arriving on the real capture path, not injected text.
   *
   * The fixture's `atSeconds` is ordering information, not a schedule: the rig
   * speaks each line as soon as the previous one finishes. Sitting out a
   * sixteen-second silence to be faithful to a transcript's timing would make
   * the rig unusable and prove nothing the transcript window's own unit tests
   * don't already cover.
   */
  function speakCurrent() {
    const problem = current();
    if (problem === null || speech === null || problem.spoken.length === 0) return;

    stopSpeaking();
    const run = speechRun;
    stopButton.disabled = false;

    const lines = problem.spoken.slice();

    const speakNext = (position) => {
      if (run !== speechRun) return;
      const line = lines[position];
      if (line === undefined) {
        setSpeechStatus(`Spoke ${lines.length} line${lines.length === 1 ? '' : 's'}.`);
        stopButton.disabled = true;
        return;
      }

      setSpeechStatus(`Speaking line ${position + 1} of ${lines.length}…`);
      const utterance = new SpeechSynthesisUtterance(line.text);
      utterance.rate = Number(rateInput.value);
      const voice = selectedVoice();
      if (voice !== null) utterance.voice = voice;
      utterance.onend = () => {
        if (run !== speechRun) return;
        window.setTimeout(() => speakNext(position + 1), SPEECH_GAP_MS);
      };
      utterance.onerror = () => {
        if (run !== speechRun) return;
        setSpeechStatus(`Speech failed on line ${position + 1}.`);
        stopButton.disabled = true;
      };
      speech.speak(utterance);
    };

    speakNext(0);
  }

  function stopSpeaking() {
    speechRun += 1;
    stopButton.disabled = true;
    if (speech !== null) speech.cancel();
  }

  function selectedVoice() {
    if (speech === null) return null;
    const wanted = voiceSelect.value;
    if (wanted === '') return null;
    return speech.getVoices().find((voice) => voice.voiceURI === wanted) ?? null;
  }

  /** Voices arrive asynchronously in most browsers, so this runs again on `voiceschanged`. */
  function populateVoices() {
    if (speech === null) return;
    const voices = speech.getVoices();

    const previous = voiceSelect.value;
    voiceSelect.innerHTML = '';
    // Always present, even before (or without) any voice list: an empty
    // dropdown reads as "speech is broken" when the browser default is in
    // fact perfectly able to speak.
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Browser default';
    voiceSelect.append(auto);

    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceSelect.append(option);
    }
    voiceSelect.value = previous;
  }

  function setSpeechStatus(text) {
    speechStatus.textContent = text;
  }

  /* ---------------------------------------------------------------------- */
  /* Navigation                                                               */
  /* ---------------------------------------------------------------------- */

  function go(delta) {
    if (quiz === null) return;
    stopSpeaking();
    index = (index + delta + quiz.problems.length) % quiz.problems.length;
    render();
  }

  function indexFromHash() {
    const id = window.location.hash.replace(/^#/, '');
    if (id === '' || quiz === null) return 0;
    const found = quiz.problems.findIndex((problem) => problem.id === id);
    return found === -1 ? 0 : found;
  }

  function setPresenting(presenting) {
    document.body.classList.toggle('presenting', presenting);
    presentButton.textContent = presenting ? 'Show bar' : 'Hide bar';
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                   */
  /* ---------------------------------------------------------------------- */

  prevButton.addEventListener('click', () => go(-1));
  nextButton.addEventListener('click', () => go(1));
  speakButton.addEventListener('click', speakCurrent);
  stopButton.addEventListener('click', () => {
    stopSpeaking();
    setSpeechStatus('Stopped.');
  });
  presentButton.addEventListener('click', () =>
    setPresenting(!document.body.classList.contains('presenting')),
  );

  if (speech !== null) {
    populateVoices();
    speech.addEventListener('voiceschanged', populateVoices);
  } else {
    voiceSelect.disabled = true;
    rateInput.disabled = true;
  }

  // The rig bar is hidden while presenting, so the keys are the only way back
  // -- and the only way to drive the quiz once the browser window is the one
  // being captured and every pixel of chrome counts.
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    switch (event.key) {
      case 'ArrowLeft':
        go(-1);
        break;
      case 'ArrowRight':
        go(1);
        break;
      case 's':
        speakCurrent();
        break;
      case 'Escape':
        stopSpeaking();
        setSpeechStatus('Stopped.');
        break;
      case 'p':
        setPresenting(!document.body.classList.contains('presenting'));
        break;
      case 'e':
        crib.open = !crib.open;
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  window.addEventListener('hashchange', () => {
    const next = indexFromHash();
    if (next !== index) {
      index = next;
      stopSpeaking();
      render();
    }
  });

  // Speech keeps going after a navigation away otherwise -- Chrome's queue
  // outlives the page it was started from.
  window.addEventListener('beforeunload', stopSpeaking);

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    return node;
  }

  function heading(text, className) {
    const node = element('h2', className);
    node.textContent = text;
    return node;
  }
})();
