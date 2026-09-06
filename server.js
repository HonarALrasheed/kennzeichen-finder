// Lokaler Server: liefert die Oberflaeche, startet Scans und nimmt Feedback entgegen.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISTRICTS, findDistrict } from './lib/districts.js';
import { scanDistrict } from './lib/wkz.js';
import { buildVerdict, rankPlates, plateLength } from './lib/score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const FEEDBACK_FILE = path.join(DATA, 'feedback.json');
const PORT = Number(process.env.PORT || 4173);

// Nur ein Scan gleichzeitig - das Portal soll nicht parallel belastet werden.
let scanRunning = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Anfrage zu groß');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadFeedback() {
  try {
    return JSON.parse(await fs.readFile(FEEDBACK_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function saveFeedback(list) {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(FEEDBACK_FILE, JSON.stringify(list, null, 2), 'utf8');
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // Kein Ausbruch aus public/
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('Verboten');
    return;
  }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
  }
}

// Baut aus dem Rohscan die Antwort fuer die Oberflaeche.
function shapeScan(scan) {
  const verdict = buildVerdict(scan);
  const results = scan.results.map((r) => ({
    label: r.label,
    letters: r.letters,
    digits: r.digits,
    status: r.status,
    count: r.count,
    capped: r.capped,
    totalLength: (scan.identifier?.length ?? 0) + r.letters + r.digits,
    plates: rankPlates(r.plates).map((p) => ({ plate: p.plate, length: plateLength(p) })),
  }));
  results.sort((a, b) => a.totalLength - b.totalLength || a.letters - b.letters);
  return { ...scan, results, verdict };
}

async function handleScan(req, res, url) {
  if (scanRunning) {
    return json(res, 429, { error: 'Es läuft bereits ein Scan. Bitte kurz warten.' });
  }

  const districtId = url.searchParams.get('district');
  const customUrl = url.searchParams.get('url');
  const identifier = (url.searchParams.get('identifier') || '').toUpperCase() || null;
  const vehicle = url.searchParams.get('vehicle') === 'krad' ? 'krad' : 'pkw';

  const district = districtId ? findDistrict(districtId) : null;
  const target = district?.url || customUrl;

  if (!target) return json(res, 400, { error: 'Keine Portal-URL angegeben.' });
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json(res, 400, { error: 'Portal-URL ist ungültig.' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return json(res, 400, { error: 'Nur http/https erlaubt.' });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  scanRunning = true;
  try {
    const scan = await scanDistrict({
      url: target,
      identifier,
      vehicle,
      onProgress: (e) => send('progress', e),
    });
    send('done', shapeScan({ ...scan, districtName: district?.name || parsed.hostname }));
  } catch (err) {
    send('error', { message: err?.message || String(err) });
  } finally {
    scanRunning = false;
    res.end();
  }
}

async function handleFeedbackPost(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Ungültige Daten.' });
  }

  const message = String(payload.message || '').trim();
  if (!message) return json(res, 400, { error: 'Bitte einen Text eingeben.' });
  if (message.length > 4000) return json(res, 400, { error: 'Text ist zu lang (max. 4000 Zeichen).' });

  const rating = Number(payload.rating);
  const entry = {
    id: `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    rating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : null,
    message,
    context: {
      district: String(payload.district || '').slice(0, 120) || null,
      identifier: String(payload.identifier || '').slice(0, 8) || null,
      shortestLength: Number.isFinite(Number(payload.shortestLength))
        ? Number(payload.shortestLength)
        : null,
    },
  };

  const list = await loadFeedback();
  list.push(entry);
  await saveFeedback(list);
  json(res, 201, { ok: true, entry, total: list.length });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/districts') {
      return json(res, 200, { districts: DISTRICTS });
    }
    if (req.method === 'GET' && url.pathname === '/api/scan') {
      return await handleScan(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      return await handleFeedbackPost(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/feedback') {
      const list = await loadFeedback();
      return json(res, 200, { total: list.length, feedback: list.slice().reverse() });
    }
    if (req.method === 'GET') return await serveStatic(res, url.pathname);

    json(res, 405, { error: 'Methode nicht erlaubt' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err?.message || 'Interner Fehler' });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Kennzeichen-Finder läuft auf http://localhost:${PORT}\n`);
});
