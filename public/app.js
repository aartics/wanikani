'use strict';

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

function typeLabel(object) {
  if (object === 'kana_vocabulary') return 'Vocab';
  return object.charAt(0).toUpperCase() + object.slice(1);
}

function needsReading(subject) {
  return subject.object !== 'radical' && subject.object !== 'kana_vocabulary';
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

// ── WanaKana (romaji → hiragana on reading cards) ─────────────────────────────
function bindWanakana() {
  if (!window.wanakana) return;
  const el = $('answer-input');
  if (!wanakana.isBound(el)) wanakana.bind(el, { IMEMode: true });
}

function unbindWanakana() {
  if (!window.wanakana) return;
  const el = $('answer-input');
  if (wanakana.isBound(el)) wanakana.unbind(el);
}

// ── Review session state ──────────────────────────────────────────────────────
let reviewQueue  = [];   // [{assignment, subject, promptType: 'meaning'|'reading'}]
let reviewIndex  = 0;
let sessionCards = 0;    // total cards answered this session
let sessionCorrect = 0;

// Per-assignment tracking: assignmentId → {wrongMeaning, wrongReading, meaningDone, readingDone}
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

// ── Build queue ───────────────────────────────────────────────────────────────
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

  // Progress bar
  const done = reviewIndex;
  const total = reviewQueue.length;
  $('progress-text').textContent = `${done} / ${total}`;
  $('progress-fill').style.width = `${(done / total) * 100}%`;

  // Type badge + character
  const badge = $('type-badge');
  badge.textContent = typeLabel(type);
  badge.className = `type-badge ${type}`;

  const charEl = $('char-display');
  charEl.textContent = subject.data.characters || subject.data.slug;
  charEl.className = `char-display ${type}`;

  // Prompt label + placeholder
  const isReading = promptType === 'reading';
  $('section-label').textContent = isReading ? 'Reading' : 'Meaning';
  $('answer-input').placeholder = isReading ? 'Type reading…' : 'Type meaning…';

  // WanaKana: only active on reading cards
  if (isReading) {
    bindWanakana();
  } else {
    unbindWanakana();
  }

  // Reset card state
  wrongThisCard = 0;
  answeredCorrectly = false;

  const section = $('quiz-section');
  section.className = 'quiz-section';
  $('answer-input').value = '';
  $('answer-input').disabled = false;
  $('answer-submit').disabled = false;
  $('answer-result').textContent = '';
  $('answer-result').className = 'result-row';
  $('answer-giveup').classList.add('hidden');
  $('item-info').classList.add('hidden');
  $('next-btn').classList.add('hidden');

  setTimeout(() => $('answer-input').focus(), 60);
}

// ── Reveal full item info after answering ─────────────────────────────────────
function revealInfo() {
  const { subject } = reviewQueue[reviewIndex];

  const meanings = subject.data.meanings
    .filter((m) => m.accepted_answer)
    .map((m) => m.meaning)
    .join(', ');
  $('info-meanings').innerHTML = `<strong>Meanings:</strong> ${meanings}`;

  if (needsReading(subject) && subject.data.readings?.length) {
    const readings = subject.data.readings
      .filter((r) => r.accepted_answer)
      .map((r) => r.reading)
      .join('、 ');
    $('info-readings').innerHTML = `<strong>Readings:</strong> ${readings}`;
    $('info-readings').classList.remove('hidden');

    if (subject.object === 'kanji') {
      const primary = subject.data.readings.find((r) => r.primary);
      if (primary) {
        $('info-pos').innerHTML = `<strong>Type:</strong> ${primary.type}`;
        $('info-pos').classList.remove('hidden');
      } else {
        $('info-pos').classList.add('hidden');
      }
    } else {
      $('info-pos').classList.add('hidden');
    }
  } else {
    $('info-readings').classList.add('hidden');
    $('info-pos').classList.add('hidden');
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

// ── Try to submit the review for an assignment (when both parts done) ──────────
async function maybeSubmitReview(assignmentId) {
  const p = getProgress(assignmentId);
  const { subject } = reviewQueue[reviewIndex];

  const bothDone = needsReading(subject)
    ? p.meaningDone && p.readingDone
    : p.meaningDone;

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

// ── Submit answer ─────────────────────────────────────────────────────────────
function submitAnswer() {
  if (answeredCorrectly) return;
  const val = $('answer-input').value.trim();
  if (!val) return;

  const { assignment, subject, promptType } = reviewQueue[reviewIndex];
  const p = getProgress(assignment.id);
  const isReading = promptType === 'reading';

  const correct = isReading
    ? checkReading(val, subject)
    : checkMeaning(val, subject);

  if (correct) {
    answeredCorrectly = true;
    sessionCards++;
    sessionCorrect++;

    // Record in progress
    if (isReading) {
      p.wrongReading += wrongThisCard;
      p.readingDone = true;
    } else {
      p.wrongMeaning += wrongThisCard;
      p.meaningDone = true;
    }
    maybeSubmitReview(assignment.id);

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
  const p = getProgress(assignment.id);
  const isReading = promptType === 'reading';

  wrongThisCard++;
  answeredCorrectly = true;
  sessionCards++;

  // Show the correct answer
  let answer;
  if (isReading) {
    answer = subject.data.readings.find((r) => r.primary)?.reading || '—';
    p.wrongReading += wrongThisCard;
    p.readingDone = true;
  } else {
    answer = subject.data.meanings.find((m) => m.primary)?.meaning || '—';
    p.wrongMeaning += wrongThisCard;
    p.meaningDone = true;
  }
  maybeSubmitReview(assignment.id);

  $('quiz-section').classList.add('incorrect');
  $('answer-result').textContent = `Answer: ${answer}`;
  $('answer-result').className = 'result-row incorrect';
  $('answer-input').disabled = true;
  $('answer-submit').disabled = true;
  $('answer-giveup').classList.add('hidden');
  revealInfo();
}

// ── Advance to next card ──────────────────────────────────────────────────────
function nextReviewCard() {
  reviewIndex++;
  $('progress-fill').style.width = `${(reviewIndex / reviewQueue.length) * 100}%`;

  if (reviewIndex >= reviewQueue.length) {
    showComplete('review');
    return;
  }
  renderReviewCard();
}

// ── Load and start reviews ────────────────────────────────────────────────────
async function startReviews() {
  const btn = $('start-reviews-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('home-hint').textContent = '';

  try {
    const data = await api('/api/queue');

    if (!data.items.length) {
      $('home-hint').textContent = 'No reviews available right now!';
      btn.disabled = false;
      btn.textContent = 'Start Reviews';
      return;
    }

    reviewQueue = buildQueue(data.items);
    reviewIndex = 0;
    sessionCards = 0;
    sessionCorrect = 0;
    progress.clear();

    showScreen('review-screen');
    renderReviewCard();
  } catch (e) {
    $('home-hint').textContent = 'Failed to load reviews. Check your connection.';
    btn.disabled = false;
    btn.textContent = 'Start Reviews';
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

  const mm = subject.data.meaning_mnemonic;
  if (mm) {
    $('lesson-mnemonic').textContent = stripTags(mm);
    $('lesson-mnemonic-row').classList.remove('hidden');
  } else {
    $('lesson-mnemonic-row').classList.add('hidden');
  }

  const rm = subject.data.reading_mnemonic;
  if (rm && needsReading(subject)) {
    $('lesson-reading-mnemonic').textContent = stripTags(rm);
    $('lesson-reading-mnemonic-row').classList.remove('hidden');
  } else {
    $('lesson-reading-mnemonic-row').classList.add('hidden');
  }
}

async function nextLessonCard() {
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
  renderLessonCard();
}

async function startLessons() {
  const btn = $('start-lessons-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('home-hint').textContent = '';

  try {
    const data = await api('/api/lessons');

    if (!data.items.length) {
      $('home-hint').textContent = 'No lessons available right now!';
      btn.disabled = false;
      btn.textContent = 'Start Lessons';
      return;
    }

    lessonQueue = data.items;
    lessonIndex = 0;
    showScreen('lesson-screen');
    renderLessonCard();
  } catch (e) {
    $('home-hint').textContent = 'Failed to load lessons.';
    btn.disabled = false;
    btn.textContent = 'Start Lessons';
  }
}

// ── Complete screen ───────────────────────────────────────────────────────────
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

// ── Home ──────────────────────────────────────────────────────────────────────
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
  unbindWanakana();
  loadSummary();
  $('start-reviews-btn').disabled = false;
  $('start-reviews-btn').textContent = 'Start Reviews';
  $('start-lessons-btn').disabled = false;
  $('start-lessons-btn').textContent = 'Start Lessons';
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
  $('answer-submit').addEventListener('click', submitAnswer);
  $('answer-giveup').addEventListener('click', giveUp);
  $('next-btn').addEventListener('click', nextReviewCard);

  $('answer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAnswer(); }
  });

  $('lesson-back-btn').addEventListener('click', returnHome);
  $('lesson-next-btn').addEventListener('click', nextLessonCard);
});
