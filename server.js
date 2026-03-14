const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3721;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    const def = { history: [], account: { name: '', email: '', avatar: '' }, settings: { adblock: true, searchEngine: 'google' } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(def, null, 2));
    return def;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { history: [], account: { name: '', email: '', avatar: '' }, settings: { adblock: true, searchEngine: 'google' } }; }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── HISTORY ──────────────────────────────────────────────────
app.get('/history', (req, res) => res.json(readData().history));

app.post('/history', (req, res) => {
  const data = readData();
  const { url, title, favicon } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  // Avoid duplicates in last 5 entries
  const recent = data.history.slice(0, 5).map(h => h.url);
  if (!recent.includes(url)) {
    data.history.unshift({ url, title: title || url, favicon: favicon || '', timestamp: Date.now() });
    if (data.history.length > 2000) data.history = data.history.slice(0, 2000);
    writeData(data);
  }
  res.json({ ok: true });
});

app.delete('/history', (req, res) => {
  const data = readData();
  data.history = [];
  writeData(data);
  res.json({ ok: true });
});

app.delete('/history/:index', (req, res) => {
  const data = readData();
  const i = parseInt(req.params.index);
  if (i >= 0 && i < data.history.length) data.history.splice(i, 1);
  writeData(data);
  res.json({ ok: true });
});

// ── ACCOUNT ───────────────────────────────────────────────────
app.get('/account', (req, res) => res.json(readData().account));

app.post('/account', (req, res) => {
  const data = readData();
  data.account = { ...data.account, ...req.body };
  writeData(data);
  res.json({ ok: true });
});

// ── SETTINGS ──────────────────────────────────────────────────
app.get('/settings', (req, res) => res.json(readData().settings));

app.post('/settings', (req, res) => {
  const data = readData();
  data.settings = { ...data.settings, ...req.body };
  writeData(data);
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[SafariNAO Server] Running on http://127.0.0.1:${PORT}`);
});
