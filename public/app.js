'use strict';

// ── Viewport lock — stops iOS keyboard from shifting the layout ───────────────
//
// Root cause (WebKit bug 153852): iOS Safari scrolls the layout viewport when
// an input is focused, even with overflow:hidden on body. position:fixed
// elements appear to jump because they're anchored to the layout viewport.
//
// Two-layer defence:
//
// Layer 1 — PREVENT (touchstart trick):
//   Move the input to translateY(-8000px) before iOS computes how much to
//   scroll. Safari sees the element off-screen and concludes 0 scroll is
//   needed. We restore the element in the next rAF, before the user notices.
//
// Layer 2 — COMPENSATE (visualViewport):
//   If iOS scrolled anyway, visualViewport.offsetTop tells us by how much.
//   We translate3d #app by exactly that amount to visually cancel the shift.
//   translate3d keeps the element on the GPU compositor — no reflow/repaint.
//
// Layer 3 — CLEANUP (focusout):
//   iOS 17/18 regression: offsetTop sometimes doesn't fully reset after the
//   keyboard closes. We force-clear the transform 400 ms after blur.

const appEl = document.getElementById('app');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

let vpFramePending = false;
function lockViewport() {
  if (vpFramePending) return;
  vpFramePending = true;
  requestAnimationFrame(() => {
    vpFramePending = false;
    if (!appEl) return;
    const vv = window.visualViewport;
    if (vv) {
      appEl.style.height = `${vv.height}px`;
      // Only apply transform when there's an actual offset — avoids creating a
      // stacking-context when it's not needed.
      appEl.style.transform = vv.offsetTop
        ? `translate3d(0,${vv.offsetTop}px,0)`
        : '';
      document.documentElement.style.setProperty('--real-vh', `${vv.height * 0.01}px`);
    } else {
      appEl.style.height = `${window.innerHeight}px`;
    }
  });
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', lockViewport);
  window.visualViewport.addEventListener('scroll', lockViewport);
}
window.addEventListener('resize', lockViewport);
lockViewport();

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, '');
}

function typeLabel(obj) {
  if (obj === 'kana_vocabulary') return 'Vocab';
  return obj.charAt(0).toUpperCase() + obj.slice(1);
}

function needsReading(subject) {
  return subject.object !== 'radical' && subject.object !== 'kana_vocabulary';
}

// ── WanaKana — bind/unbind per card ──────────────────────────────────────────
// We call unbind before every bind to avoid double-binding.
// Do NOT use wanakana.isBound() — it is not reliable across versions.
function bindWanakana() {
  if (!window.wanakana) return;
  const el = $('answer-input');
  try { wanakana.unbind(el); } catch (_) {}
  // No IMEMode — this enables live romaji→hiragana conversion as you type.
  // IMEMode:true suppresses conversion (lets the IME do it), which breaks
  // romaji input on an English keyboard, which is the common case on iPhone.
  wanakana.bind(el);
}

function unbindWanakana() {
  if (!window.wanakana) return;
  try { wanakana.unbind($('answer-input')); } catch (_) {}
}

// ── Answer checking ───────────────────────────────────────────────────────────
function normMeaning(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function checkMeaning(input, subject) {
  const user = normMeaning(input);
  if (!user) return false;
  const accepted = [
    ...subject.data.meanings
      .filter((m) => m.accepted_answer)
      .map((m) => normMeaning(m.meaning)),
    ...(subject.data.auxiliary_meanings || [])
      .filter((m) => m.type === 'whitelist')
      .map((m) => normMeaning(m.meaning)),
  ];
  return accepted.some((a) => a === user);
}

function checkReading(input, subject) {
  const user = input.trim();
  if (!user) return false;
  return subject.data.readings
    .filter((r) => r.accepted_answer)
    .map((r) => r.reading)
    .includes(user);
}

// ── Review session state ──────────────────────────────────────────────────────
let reviewQueue = [];
let reviewIndex = 0;
let sessionCards = 0;
let sessionCorrect = 0;

// Per-assignment SRS tracking
const progress = new Map();
function getProgress(id) {
  if (!progress.has(id)) {
    progress.set(id, { wrongMeaning: 0, wrongReading: 0, meaningDone: false, readingDone: false });
  }
  return progress.get(id);
}

// Per-card state
let wrongThisCard = 0;
let answeredCorrectly = false;

function buildQueue(items) {
  const cards = [];
  for (const { assignment, subject } of items) {
    cards.push({ assignment, subject, promptType: 'meaning' });
    if (needsReading(subject)) {
      cards.push({ assignment, subject, promptType: 'reading' });
    }
  }
  shuffle(cards);
  return cards;
}

// ── Render a review card ──────────────────────────────────────────────────────
function renderReviewCard() {
  const { subject, promptType } = reviewQueue[reviewIndex];
  const type = subject.object;
  const isReading = promptType === 'reading';

  // Progress
  $('progress-text').textContent = `${reviewIndex} / ${reviewQueue.length}`;
  $('progress-fill').style.width = `${(reviewIndex / reviewQueue.length) * 100}%`;

  // Badge + character
  const badge = $('type-badge');
  badge.textContent = typeLabel(type);
  badge.className = `type-badge ${type}`;

  const charEl = $('char-display');
  charEl.textContent = subject.data.characters || subject.data.slug;
  charEl.className = `char-display ${type}`;

  // Prompt
  $('section-label').textContent = isReading ? 'Reading' : 'Meaning';
  $('answer-input').placeholder = isReading ? 'Type reading…' : 'Type meaning…';

  // WanaKana: only active on reading cards
  if (isReading) {
    bindWanakana();
  } else {
    unbindWanakana();
  }

  // Reset card
  wrongThisCard = 0;
  answeredCorrectly = false;

  $('quiz-section').className = 'quiz-section';
  $('answer-input').value = '';
  $('answer-input').disabled = false;
  $('answer-submit').disabled = false;
  $('answer-result').textContent = '';
  $('answer-result').className = 'result-row';
  $('answer-giveup').classList.add('hidden');

  // Hide info + next
  $('item-info').classList.add('hidden');
  $('next-btn').classList.add('hidden');

  // Collapse any open reveals
  collapseReveal('meaning');
  collapseReveal('reading');
  collapseReveal('explanation');

  // Reset the info panel scroll so old content doesn't bleed through
  const info = $('item-info');
  if (info) info.scrollTop = 0;

  setTimeout(() => $('answer-input').focus(), 80);
}

// ── Reveal toggle helpers ─────────────────────────────────────────────────────
function collapseReveal(name) {
  const btn = $(`${name}-reveal-btn`);
  const content = $(`${name}-reveal`);
  if (!btn || !content) return;
  content.classList.add('hidden');
  btn.classList.remove('open');
  btn.textContent = `Show ${name} ▾`;
}

function toggleReveal(name) {
  const btn = $(`${name}-reveal-btn`);
  const content = $(`${name}-reveal`);
  const isOpen = !content.classList.contains('hidden');
  if (isOpen) {
    content.classList.add('hidden');
    btn.classList.remove('open');
    btn.textContent = `Show ${name} ▾`;
  } else {
    content.classList.remove('hidden');
    btn.classList.add('open');
    btn.textContent = `Hide ${name} ▴`;
  }
}

// ── Reveal info panel after answering ────────────────────────────────────────
function revealInfo() {
  const { subject, promptType } = reviewQueue[reviewIndex];
  const isReading = promptType === 'reading';

  // Populate meaning content
  const meanings = subject.data.meanings
    .filter((m) => m.accepted_answer)
    .map((m) => m.meaning)
    .join(', ');
  $('info-meanings').innerHTML = `<strong>Meanings:</strong> ${meanings}`;

  // Populate reading content
  if (needsReading(subject) && subject.data.readings?.length) {
    const readings = subject.data.readings
      .filter((r) => r.accepted_answer)
      .map((r) => r.reading)
      .join('、 ');
    $('info-readings').innerHTML = `<strong>Readings:</strong> ${readings}`;

    if (subject.object === 'kanji') {
      const primary = subject.data.readings.find((r) => r.primary);
      $('info-pos').innerHTML = primary ? `<strong>Type:</strong> ${primary.type}` : '';
    } else {
      $('info-pos').textContent = '';
    }
  }

  // Populate mnemonics
  const mm = stripTags(subject.data.meaning_mnemonic || '');
  const rm = needsReading(subject) ? stripTags(subject.data.reading_mnemonic || '') : '';
  $('info-meaning-mnemonic').innerHTML = mm ? `<strong>Meaning:</strong> ${mm}` : '';
  $('info-reading-mnemonic').innerHTML = rm ? `<strong>Reading:</strong> ${rm}` : '';
  if (mm || rm) {
    $('explanation-reveal-btn').classList.remove('hidden');
  } else {
    $('explanation-reveal-btn').classList.add('hidden');
  }

  // Auto-open what they just answered; hide the other behind a button.
  // Meaning card → open meaning, reading stays hidden.
  // Reading card → open reading, meaning stays hidden.
  if (isReading) {
    // Show what they answered (reading)
    $('reading-reveal-btn').classList.remove('hidden');
    $('reading-reveal').classList.remove('hidden');
    $('reading-reveal-btn').classList.add('open');
    $('reading-reveal-btn').textContent = 'Hide reading ▴';
    // Meaning hidden behind toggle (only if subject has reading — meaning cards for radicals are fine)
    $('meaning-reveal-btn').classList.remove('hidden');
  } else {
    // Show what they answered (meaning)
    $('meaning-reveal-btn').classList.remove('hidden');
    $('meaning-reveal').classList.remove('hidden');
    $('meaning-reveal-btn').classList.add('open');
    $('meaning-reveal-btn').textContent = 'Hide meaning ▴';
    // Reading hidden behind toggle (only show button if subject has readings)
    if (needsReading(subject)) {
      $('reading-reveal-btn').classList.remove('hidden');
    }
  }

  const info = $('item-info');
  info.classList.remove('hidden');
  info.classList.add('fade-in');
  setTimeout(() => info.classList.remove('fade-in'), 250);

  const nextBtn = $('next-btn');
  nextBtn.classList.remove('hidden');
  nextBtn.classList.add('fade-in');
  setTimeout(() => nextBtn.classList.remove('fade-in'), 250);
}

// ── Submit review to WaniKani when both parts done ────────────────────────────
async function maybeSubmitReview(assignmentId, subject) {
  const p = getProgress(assignmentId);
  const bothDone = needsReading(subject) ? (p.meaningDone && p.readingDone) : p.meaningDone;
  if (!bothDone) return;
  try {
    await api('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        assignment_id: assignmentId,
        incorrect_meaning_answers: p.wrongMeaning,
        incorrect_reading_answers: p.wrongReading,
      }),
    });
  } catch (e) {
    console.warn('Review submit failed:', e.message);
  }
}

// ── Answer submit ─────────────────────────────────────────────────────────────
function submitAnswer() {
  if (answeredCorrectly) return;
  const val = $('answer-input').value.trim();
  if (!val) return;

  const { assignment, subject, promptType } = reviewQueue[reviewIndex];
  const isReading = promptType === 'reading';
  const p = getProgress(assignment.id);
  const correct = isReading ? checkReading(val, subject) : checkMeaning(val, subject);

  if (correct) {
    answeredCorrectly = true;
    sessionCards++;
    sessionCorrect++;

    if (isReading) { p.wrongReading += wrongThisCard; p.readingDone = true; }
    else           { p.wrongMeaning += wrongThisCard; p.meaningDone = true; }
    maybeSubmitReview(assignment.id, subject);

    $('quiz-section').classList.add('correct');
    $('answer-result').textContent = '✓ Correct';
    $('answer-result').className = 'result-row correct';
    $('answer-input').disabled = true;
    $('answer-submit').disabled = true;
    $('answer-giveup').classList.add('hidden');
    revealInfo();

  } else {
    wrongThisCard++;
    $('quiz-section').classList.add('incorrect');
    $('answer-result').textContent = '✗ Not quite — try again';
    $('answer-result').className = 'result-row incorrect';
    $('answer-input').value = '';
    $('answer-input').focus();
    setTimeout(() => $('quiz-section').classList.remove('incorrect'), 650);
    if (wrongThisCard >= 1) $('answer-giveup').classList.remove('hidden');
  }
}

// ── Give up ───────────────────────────────────────────────────────────────────
function giveUp() {
  if (answeredCorrectly) return;
  const { assignment, subject, promptType } = reviewQueue[reviewIndex];
  const isReading = promptType === 'reading';
  const p = getProgress(assignment.id);

  wrongThisCard++;
  answeredCorrectly = true;
  sessionCards++;

  const answer = isReading
    ? (subject.data.readings?.find((r) => r.primary)?.reading || '—')
    : (subject.data.meanings?.find((m) => m.primary)?.meaning || '—');

  if (isReading) { p.wrongReading += wrongThisCard; p.readingDone = true; }
  else           { p.wrongMeaning += wrongThisCard; p.meaningDone = true; }
  maybeSubmitReview(assignment.id, subject);

  $('quiz-section').classList.add('incorrect');
  $('answer-result').textContent = `Answer: ${answer}`;
  $('answer-result').className = 'result-row incorrect';
  $('answer-input').disabled = true;
  $('answer-submit').disabled = true;
  $('answer-giveup').classList.add('hidden');
  revealInfo();
}

// ── Next card ─────────────────────────────────────────────────────────────────
function nextReviewCard() {
  reviewIndex++;
  $('progress-fill').style.width = `${(reviewIndex / reviewQueue.length) * 100}%`;
  if (reviewIndex >= reviewQueue.length) { showComplete('review'); return; }
  renderReviewCard();
}

// ── Start reviews ─────────────────────────────────────────────────────────────
async function startReviews() {
  const btn = $('start-reviews-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('home-hint').textContent = '';

  try {
    const data = await api('/api/queue');
    if (!data.items.length) {
      $('home-hint').textContent = 'No reviews available right now!';
      btn.disabled = false; btn.textContent = 'Start Reviews';
      return;
    }
    reviewQueue = buildQueue(data.items);
    reviewIndex = 0; sessionCards = 0; sessionCorrect = 0;
    progress.clear();
    showScreen('review-screen');
    renderReviewCard();
  } catch (e) {
    $('home-hint').textContent = 'Failed to load reviews. Check your connection.';
    btn.disabled = false; btn.textContent = 'Start Reviews';
  }
}

// ── Lessons ───────────────────────────────────────────────────────────────────
let lessonQueue = [];
let lessonIndex = 0;

function renderLessonCard() {
  const { subject } = lessonQueue[lessonIndex];
  const type = subject.object;

  $('lesson-progress-text').textContent = `${lessonIndex + 1} / ${lessonQueue.length}`;
  $('lesson-progress-fill').style.width = `${((lessonIndex + 1) / lessonQueue.length) * 100}%`;

  const badge = $('lesson-type-badge');
  badge.textContent = typeLabel(type);
  badge.className = `type-badge ${type}`;

  const charEl = $('lesson-char-display');
  charEl.textContent = subject.data.characters || subject.data.slug;
  charEl.className = `char-display ${type}`;

  $('lesson-meanings').textContent = subject.data.meanings
    .filter((m) => m.accepted_answer).map((m) => m.meaning).join(', ');

  const readingRow = $('lesson-reading-row');
  if (needsReading(subject) && subject.data.readings?.length) {
    $('lesson-readings').textContent = subject.data.readings
      .filter((r) => r.accepted_answer).map((r) => r.reading).join('、 ');
    readingRow.classList.remove('hidden');
  } else {
    readingRow.classList.add('hidden');
  }

  const mm = subject.data.meaning_mnemonic;
  if (mm) {
    $('lesson-mnemonic').textContent = stripTags(mm);
    $('lesson-mnemonic-row').classList.remove('hidden');
  } else { $('lesson-mnemonic-row').classList.add('hidden'); }

  const rm = subject.data.reading_mnemonic;
  if (rm && needsReading(subject)) {
    $('lesson-reading-mnemonic').textContent = stripTags(rm);
    $('lesson-reading-mnemonic-row').classList.remove('hidden');
  } else { $('lesson-reading-mnemonic-row').classList.add('hidden'); }

  $('lesson-body').scrollTop = 0;  // reset scroll inside lesson info panel
}

async function nextLessonCard() {
  const { assignment } = lessonQueue[lessonIndex];
  try {
    await api(`/api/assignments/${assignment.id}/start`, { method: 'PUT' });
  } catch (e) { console.warn('Lesson start failed:', e.message); }

  lessonIndex++;
  if (lessonIndex >= lessonQueue.length) { showComplete('lesson'); return; }
  renderLessonCard();
}

async function startLessons() {
  const btn = $('start-lessons-btn');
  btn.disabled = true; btn.textContent = 'Loading…';
  $('home-hint').textContent = '';
  try {
    const data = await api('/api/lessons');
    if (!data.items.length) {
      $('home-hint').textContent = 'No lessons available right now!';
      btn.disabled = false; btn.textContent = 'Start Lessons';
      return;
    }
    lessonQueue = data.items; lessonIndex = 0;
    showScreen('lesson-screen');
    renderLessonCard();
  } catch (e) {
    $('home-hint').textContent = 'Failed to load lessons.';
    btn.disabled = false; btn.textContent = 'Start Lessons';
  }
}

// ── Complete ──────────────────────────────────────────────────────────────────
function showComplete(mode) {
  if (mode === 'review') {
    const pct = sessionCards ? Math.round((sessionCorrect / sessionCards) * 100) : 0;
    $('complete-emoji').textContent = pct === 100 ? '🎉' : pct >= 80 ? '✓' : '頑';
    $('complete-stats').textContent = `${sessionCorrect} / ${sessionCards} correct (${pct}%)`;
  } else {
    $('complete-emoji').textContent = '📖';
    $('complete-stats').textContent = `${lessonQueue.length} lesson${lessonQueue.length !== 1 ? 's' : ''} completed`;
  }
  showScreen('complete-screen');
}

// ── Home summary ──────────────────────────────────────────────────────────────
async function loadSummary() {
  try {
    const data = await api('/api/summary');
    const reviews = data.data?.reviews?.[0]?.subject_ids?.length ?? 0;
    $('reviews-count').textContent = reviews;
  } catch {
    $('reviews-count').textContent = '?';
  }
}

function returnHome() {
  unbindWanakana();
  loadSummary();
  $('start-reviews-btn').disabled = false; $('start-reviews-btn').textContent = 'Start Reviews';
  $('start-lessons-btn').disabled = false; $('start-lessons-btn').textContent = 'Start Lessons';
  $('home-hint').textContent = '';
  showScreen('home-screen');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  loadSummary();

  $('start-reviews-btn').addEventListener('click', startReviews);
  $('start-lessons-btn').addEventListener('click', startLessons);
  $('refresh-btn').addEventListener('click', loadSummary);
  $('done-btn').addEventListener('click', returnHome);

  $('review-back-btn').addEventListener('click', returnHome);
  $('answer-giveup').addEventListener('click', giveUp);
  $('next-btn').addEventListener('click', nextReviewCard);

  // Use form submit so the iOS keyboard's Return/Go key reliably triggers.
  // The button inside the form is type="submit", so tapping it also fires this.
  $('answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAnswer();
  });

  $('meaning-reveal-btn').addEventListener('click', () => toggleReveal('meaning'));
  $('reading-reveal-btn').addEventListener('click', () => toggleReveal('reading'));
  $('explanation-reveal-btn').addEventListener('click', () => toggleReveal('explanation'));

  $('lesson-back-btn').addEventListener('click', returnHome);
  $('lesson-next-btn').addEventListener('click', nextLessonCard);

  // ── iOS keyboard scroll prevention (Layer 1 + Layer 3) ─────────────────
  if (isIOS) {
    // Layer 1: on touchstart move the input way off-screen so Safari calculates
    // "needs 0 scroll to reveal this element", then restore before paint.
    $('answer-input').addEventListener('touchstart', () => {
      const el = $('answer-input');
      el.style.transform = 'translateY(-8000px)';
      requestAnimationFrame(() => { el.style.transform = ''; });
    }, { passive: true });

    // Layer 3: iOS 17/18 regression — offsetTop doesn't always reset to 0
    // after the keyboard closes. Force-clear the app transform after blur.
    document.addEventListener('focusout', () => {
      setTimeout(() => {
        if (appEl) appEl.style.transform = '';
        if (window.visualViewport) {
          document.documentElement.style.setProperty(
            '--real-vh', `${window.visualViewport.height * 0.01}px`
          );
        }
      }, 400);
    });
  }
});
