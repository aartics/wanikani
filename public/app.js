'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Answer checking ───────────────────────────────────────────────────────────
function normMeaning(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function checkMeaning(input, subject) {
  const user = normMeaning(input);
  if (!user) return false;
  const accepted = [
    ...subject.data.meanings.filter((m) => m.accepted_answer).map((m) => normMeaning(m.meaning)),
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

function needsReading(subject) {
  return subject.object !== 'radical' && subject.object !== 'kana_vocabulary';
}

function typeLabel(object) {
  if (object === 'kana_vocabulary') return 'Vocab';
  return object.charAt(0).toUpperCase() + object.slice(1);
}

// ── Review session state ──────────────────────────────────────────────────────
let reviewQueue = [];
let reviewIndex = 0;
let sessionCorrect = 0;
let sessionTotal = 0;

// Per-item state
let meaningDone = false;
let readingDone = false;
let wrongMeaning = 0;
let wrongReading = 0;
let meaningOk = false;
let readingOk = false;

// ── Render a review item ──────────────────────────────────────────────────────
function renderReviewItem() {
  const { subject } = reviewQueue[reviewIndex];
  const type = subject.object;

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

  // Reset per-item state
  meaningDone = false;
  readingDone = false;
  wrongMeaning = 0;
  wrongReading = 0;
  meaningOk = false;
  readingOk = false;

  // Meaning section — always visible, reset
  const mSec = $('meaning-section');
  mSec.className = 'quiz-section';
  $('meaning-input').value = '';
  $('meaning-input').disabled = false;
  $('meaning-submit').disabled = false;
  $('meaning-result').textContent = '';
  $('meaning-result').className = 'result-row';
  $('meaning-giveup').classList.add('hidden');

  // Reading section — hidden until meaning answered
  const rSec = $('reading-section');
  rSec.className = 'quiz-section hidden';
  $('reading-input').value = '';
  $('reading-input').disabled = false;
  $('reading-submit').disabled = false;
  $('reading-result').textContent = '';
  $('reading-result').className = 'result-row';
  $('reading-giveup').classList.add('hidden');

  // Info + next — hidden
  $('item-info').classList.add('hidden');
  $('next-btn').classList.add('hidden');

  // Focus
  setTimeout(() => $('meaning-input').focus(), 60);
}

function revealReadingSection() {
  const rSec = $('reading-section');
  rSec.classList.remove('hidden');
  rSec.classList.add('fade-in');
  setTimeout(() => rSec.classList.remove('fade-in'), 300);
  setTimeout(() => $('reading-input').focus(), 60);
}

function revealItemInfo() {
  const { subject } = reviewQueue[reviewIndex];
  const meanings = subject.data.meanings
    .filter((m) => m.accepted_answer)
    .map((m) => m.meaning)
    .join(', ');

  $('info-meanings').innerHTML = `<strong>Meanings:</strong> ${meanings}`;

  if (needsReading(subject)) {
    const readings = subject.data.readings
      .filter((r) => r.accepted_answer)
      .map((r) => r.reading)
      .join('、 ');
    $('info-readings').innerHTML = `<strong>Readings:</strong> ${readings}`;
    $('info-readings').classList.remove('hidden');

    // Show reading type (on'yomi / kun'yomi) for kanji
    if (subject.object === 'kanji') {
      const primaryReading = subject.data.readings.find((r) => r.primary);
      if (primaryReading) {
        $('info-reading-type').innerHTML = `<strong>Type:</strong> ${primaryReading.type}`;
        $('info-reading-type').classList.remove('hidden');
      }
    } else {
      $('info-reading-type').classList.add('hidden');
    }
  } else {
    $('info-readings').classList.add('hidden');
    $('info-reading-type').classList.add('hidden');
  }

  const info = $('item-info');
  info.classList.remove('hidden');
  info.classList.add('fade-in');
  setTimeout(() => info.classList.remove('fade-in'), 300);

  const nextBtn = $('next-btn');
  nextBtn.classList.remove('hidden');
  nextBtn.classList.add('fade-in');
  setTimeout(() => nextBtn.classList.remove('fade-in'), 300);
}

async function finishReviewItem() {
  revealItemInfo();

  if (meaningOk && readingOk) sessionCorrect++;
  sessionTotal++;

  const { assignment } = reviewQueue[reviewIndex];
  try {
    await api('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        assignment_id: assignment.id,
        incorrect_meaning_answers: wrongMeaning,
        incorrect_reading_answers: wrongReading,
      }),
    });
  } catch (e) {
    console.warn('Review submit failed (will retry on reload):', e.message);
  }
}

// ── Meaning submit ────────────────────────────────────────────────────────────
function submitMeaning() {
  if (meaningDone) return;
  const val = $('meaning-input').value.trim();
  if (!val) return;

  const { subject } = reviewQueue[reviewIndex];
  const correct = checkMeaning(val, subject);

  if (correct) {
    meaningDone = true;
    meaningOk = true;

    const mSec = $('meaning-section');
    mSec.classList.add('correct');
    $('meaning-result').textContent = '✓ Correct';
    $('meaning-result').className = 'result-row correct';
    $('meaning-input').disabled = true;
    $('meaning-submit').disabled = true;
    $('meaning-giveup').classList.add('hidden');

    if (needsReading(subject)) {
      revealReadingSection();
    } else {
      // Radical / kana vocab — no reading needed
      readingDone = true;
      readingOk = true;
      finishReviewItem();
    }
  } else {
    wrongMeaning++;
    $('meaning-section').classList.add('incorrect');
    $('meaning-result').textContent = '✗ Not quite — try again';
    $('meaning-result').className = 'result-row incorrect';
    $('meaning-input').value = '';
    $('meaning-input').focus();
    // Remove incorrect highlight after a beat so it feels responsive on retry
    setTimeout(() => $('meaning-section').classList.remove('incorrect'), 700);

    if (wrongMeaning >= 1) {
      $('meaning-giveup').classList.remove('hidden');
    }
  }
}

// ── Reading submit ────────────────────────────────────────────────────────────
function submitReading() {
  if (readingDone) return;
  const val = $('reading-input').value.trim();
  if (!val) return;

  const { subject } = reviewQueue[reviewIndex];
  const correct = checkReading(val, subject);

  if (correct) {
    readingDone = true;
    readingOk = true;

    $('reading-section').classList.add('correct');
    $('reading-result').textContent = '✓ Correct';
    $('reading-result').className = 'result-row correct';
    $('reading-input').disabled = true;
    $('reading-submit').disabled = true;
    $('reading-giveup').classList.add('hidden');

    finishReviewItem();
  } else {
    wrongReading++;
    $('reading-section').classList.add('incorrect');
    $('reading-result').textContent = '✗ Not quite — try again';
    $('reading-result').className = 'result-row incorrect';
    $('reading-input').value = '';
    $('reading-input').focus();
    setTimeout(() => $('reading-section').classList.remove('incorrect'), 700);

    if (wrongReading >= 1) {
      $('reading-giveup').classList.remove('hidden');
    }
  }
}

// ── Give up ───────────────────────────────────────────────────────────────────
function giveUpMeaning() {
  const { subject } = reviewQueue[reviewIndex];
  const answer = subject.data.meanings
    .filter((m) => m.primary)
    .map((m) => m.meaning)[0];

  meaningDone = true;
  meaningOk = false;
  wrongMeaning++;

  $('meaning-section').classList.add('incorrect');
  $('meaning-result').textContent = `Answer: ${answer}`;
  $('meaning-result').className = 'result-row incorrect';
  $('meaning-input').disabled = true;
  $('meaning-submit').disabled = true;
  $('meaning-giveup').classList.add('hidden');

  if (needsReading(subject)) {
    revealReadingSection();
  } else {
    readingDone = true;
    readingOk = false;
    finishReviewItem();
  }
}

function giveUpReading() {
  const { subject } = reviewQueue[reviewIndex];
  const answer = subject.data.readings
    .filter((r) => r.primary)
    .map((r) => r.reading)[0];

  readingDone = true;
  readingOk = false;
  wrongReading++;

  $('reading-section').classList.add('incorrect');
  $('reading-result').textContent = `Answer: ${answer}`;
  $('reading-result').className = 'result-row incorrect';
  $('reading-input').disabled = true;
  $('reading-submit').disabled = true;
  $('reading-giveup').classList.add('hidden');

  finishReviewItem();
}

// ── Next item ─────────────────────────────────────────────────────────────────
function nextReviewItem() {
  reviewIndex++;
  $('progress-fill').style.width = `${(reviewIndex / reviewQueue.length) * 100}%`;

  if (reviewIndex >= reviewQueue.length) {
    showComplete('review');
    return;
  }
  renderReviewItem();
}

// ── Start reviews ─────────────────────────────────────────────────────────────
async function startReviews() {
  const btn = $('start-reviews-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('home-hint').textContent = '';

  try {
    const data = await api('/api/queue');
    reviewQueue = data.items;

    if (!reviewQueue.length) {
      $('home-hint').textContent = 'No reviews available right now — check back later!';
      btn.disabled = false;
      btn.textContent = 'Start Reviews';
      return;
    }

    // Shuffle
    for (let i = reviewQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [reviewQueue[i], reviewQueue[j]] = [reviewQueue[j], reviewQueue[i]];
    }

    reviewIndex = 0;
    sessionCorrect = 0;
    sessionTotal = 0;

    showScreen('review-screen');
    renderReviewItem();
  } catch (e) {
    $('home-hint').textContent = 'Failed to load reviews. Check your connection.';
    btn.disabled = false;
    btn.textContent = 'Start Reviews';
  }
}

// ── Lesson session state ──────────────────────────────────────────────────────
let lessonQueue = [];
let lessonIndex = 0;

function renderLessonItem() {
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

  const meanings = subject.data.meanings
    .filter((m) => m.accepted_answer)
    .map((m) => m.meaning)
    .join(', ');
  $('lesson-meanings').textContent = meanings;

  const readingRow = $('lesson-reading-row');
  if (needsReading(subject) && subject.data.readings?.length) {
    const readings = subject.data.readings
      .filter((r) => r.accepted_answer)
      .map((r) => r.reading)
      .join('、 ');
    $('lesson-readings').textContent = readings;
    readingRow.classList.remove('hidden');
  } else {
    readingRow.classList.add('hidden');
  }

  const meaningMnemonic = subject.data.meaning_mnemonic;
  if (meaningMnemonic) {
    // Strip WaniKani's <radical>/<kanji> markup tags to plain text
    $('lesson-mnemonic').textContent = meaningMnemonic.replace(/<[^>]+>/g, '');
    $('lesson-mnemonic-row').classList.remove('hidden');
  } else {
    $('lesson-mnemonic-row').classList.add('hidden');
  }

  const readingMnemonic = subject.data.reading_mnemonic;
  if (readingMnemonic && needsReading(subject)) {
    $('lesson-reading-mnemonic').textContent = readingMnemonic.replace(/<[^>]+>/g, '');
    $('lesson-reading-mnemonic-row').classList.remove('hidden');
  } else {
    $('lesson-reading-mnemonic-row').classList.add('hidden');
  }
}

async function nextLessonItem() {
  // Mark current lesson as started
  const { assignment } = lessonQueue[lessonIndex];
  try {
    await api(`/api/assignments/${assignment.id}/start`, { method: 'PUT' });
  } catch (e) {
    console.warn('Lesson start failed:', e.message);
  }

  lessonIndex++;
  if (lessonIndex >= lessonQueue.length) {
    showComplete('lesson');
    return;
  }
  renderLessonItem();
}

async function startLessons() {
  const btn = $('start-lessons-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('home-hint').textContent = '';

  try {
    const data = await api('/api/lessons');
    lessonQueue = data.items;

    if (!lessonQueue.length) {
      $('home-hint').textContent = 'No lessons available right now!';
      btn.disabled = false;
      btn.textContent = 'Start Lessons';
      return;
    }

    lessonIndex = 0;
    showScreen('lesson-screen');
    renderLessonItem();
  } catch (e) {
    $('home-hint').textContent = 'Failed to load lessons. Check your connection.';
    btn.disabled = false;
    btn.textContent = 'Start Lessons';
  }
}

// ── Complete screen ───────────────────────────────────────────────────────────
function showComplete(mode) {
  if (mode === 'review') {
    const pct = sessionTotal ? Math.round((sessionCorrect / sessionTotal) * 100) : 0;
    $('complete-emoji').textContent = pct === 100 ? '🎉' : pct >= 70 ? '✓' : '頑';
    $('complete-stats').textContent = `${sessionCorrect} / ${sessionTotal} correct (${pct}%)`;
  } else {
    $('complete-emoji').textContent = '📖';
    $('complete-stats').textContent = `${lessonQueue.length} lessons completed`;
  }
  showScreen('complete-screen');
}

// ── Summary ───────────────────────────────────────────────────────────────────
async function loadSummary() {
  try {
    const data = await api('/api/summary');
    const reviews = data.data?.reviews?.[0]?.subject_ids?.length ?? 0;
    const lessons = data.data?.lessons?.[0]?.subject_ids?.length ?? 0;
    $('reviews-count').textContent = reviews;
    $('lessons-count').textContent = lessons;
  } catch {
    $('reviews-count').textContent = '?';
    $('lessons-count').textContent = '?';
  }
}

function returnHome() {
  loadSummary();
  $('start-reviews-btn').disabled = false;
  $('start-reviews-btn').textContent = 'Start Reviews';
  $('start-lessons-btn').disabled = false;
  $('start-lessons-btn').textContent = 'Start Lessons';
  $('home-hint').textContent = '';
  showScreen('home-screen');
}

// ── Wiring ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  loadSummary();

  // Home
  $('start-reviews-btn').addEventListener('click', startReviews);
  $('start-lessons-btn').addEventListener('click', startLessons);
  $('refresh-btn').addEventListener('click', loadSummary);
  $('done-btn').addEventListener('click', returnHome);

  // Reviews
  $('review-back-btn').addEventListener('click', returnHome);
  $('meaning-submit').addEventListener('click', submitMeaning);
  $('reading-submit').addEventListener('click', submitReading);
  $('meaning-giveup').addEventListener('click', giveUpMeaning);
  $('reading-giveup').addEventListener('click', giveUpReading);
  $('next-btn').addEventListener('click', nextReviewItem);

  $('meaning-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitMeaning(); }
  });
  $('reading-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitReading(); }
  });

  // Lessons
  $('lesson-back-btn').addEventListener('click', returnHome);
  $('lesson-next-btn').addEventListener('click', nextLessonItem);

  // WanaKana: convert romaji → hiragana on reading input
  if (window.wanakana) {
    wanakana.bind($('reading-input'), { IMEMode: true });
  }
});
