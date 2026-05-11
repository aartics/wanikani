require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const WK_TOKEN = process.env.WK_TOKEN;
const WK_BASE = 'https://api.wanikani.com/v2';

async function wkFetch(endpoint, options = {}) {
  const res = await fetch(`${WK_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WK_TOKEN}`,
      'Wanikani-Revision': '20170710',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WaniKani API ${res.status}: ${text}`);
  }
  return res.json();
}

// Fetch all pages of a paginated WaniKani endpoint
async function wkFetchAll(endpoint) {
  let url = `${WK_BASE}${endpoint}`;
  const items = [];
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${WK_TOKEN}`,
        'Wanikani-Revision': '20170710',
      },
    });
    if (!res.ok) throw new Error(`WaniKani API ${res.status}`);
    const json = await res.json();
    items.push(...json.data);
    url = json.pages?.next_url || null;
  }
  return items;
}

// Summary — review and lesson counts
app.get('/api/summary', async (req, res) => {
  try {
    const data = await wkFetch('/summary');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Review queue — assignments + subjects merged, ready to go
app.get('/api/queue', async (req, res) => {
  try {
    const assignments = await wkFetchAll(
      '/assignments?immediately_available_for_review=true'
    );

    if (!assignments.length) return res.json({ items: [] });

    // Fetch subjects in batches of 500 (API limit)
    const subjectIds = assignments.map((a) => a.data.subject_id);
    const batches = [];
    for (let i = 0; i < subjectIds.length; i += 500) {
      batches.push(subjectIds.slice(i, i + 500).join(','));
    }

    const subjectData = [];
    for (const batch of batches) {
      const s = await wkFetchAll(`/subjects?ids=${batch}`);
      subjectData.push(...s);
    }

    const subjectMap = {};
    subjectData.forEach((s) => {
      subjectMap[s.id] = s;
    });

    const items = assignments
      .map((a) => ({
        assignment: { id: a.id, ...a.data },
        subject: subjectMap[a.data.subject_id],
      }))
      .filter((item) => item.subject);

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Lesson queue — assignments not yet started
app.get('/api/lessons', async (req, res) => {
  try {
    const assignments = await wkFetchAll(
      '/assignments?immediately_available_for_lessons=true'
    );

    if (!assignments.length) return res.json({ items: [] });

    const subjectIds = assignments.map((a) => a.data.subject_id);
    const batches = [];
    for (let i = 0; i < subjectIds.length; i += 500) {
      batches.push(subjectIds.slice(i, i + 500).join(','));
    }

    const subjectData = [];
    for (const batch of batches) {
      const s = await wkFetchAll(`/subjects?ids=${batch}`);
      subjectData.push(...s);
    }

    const subjectMap = {};
    subjectData.forEach((s) => {
      subjectMap[s.id] = s;
    });

    const items = assignments
      .map((a) => ({
        assignment: { id: a.id, ...a.data },
        subject: subjectMap[a.data.subject_id],
      }))
      .filter((item) => item.subject);

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Submit a completed review
app.post('/api/reviews', async (req, res) => {
  try {
    const data = await wkFetch('/reviews', {
      method: 'POST',
      body: JSON.stringify({ review: req.body }),
    });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Start a lesson (mark assignment as started)
app.put('/api/assignments/:id/start', async (req, res) => {
  try {
    const data = await wkFetch(`/assignments/${req.params.id}/start`, {
      method: 'PUT',
    });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WaniKani PWA running → http://localhost:${PORT}`);
});
