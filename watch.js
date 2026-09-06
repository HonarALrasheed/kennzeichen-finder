// Beobachtet Zulassungsbezirke und meldet, wenn neue Kennzeichen frei werden.
//
//   node watch.js                 einmal prüfen und vergleichen
//   node watch.js --init          Ausgangszustand setzen, ohne zu melden
//
// Konfiguration: data/watch.config.json (wird beim ersten Start angelegt).
// Zeitgesteuert läuft das über launchd — siehe README.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { findDistrict } from './lib/districts.js';
import { scanDistrict } from './lib/wkz.js';
import { plateLength, rankPlates } from './lib/score.js';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA, 'watch.config.json');
// Lokale Ergänzung mit Geheimnissen. Steht in .gitignore, damit das Repo
// öffentlich sein darf. In der Cloud kommt das Topic stattdessen aus einem
// GitHub-Secret über NTFY_TOPIC.
const LOCAL_FILE = path.join(DATA, 'watch.local.json');
const STATE_FILE = path.join(DATA, 'watch.state.json');
const LOG_FILE = path.join(DATA, 'watch.log.ndjson');
// Wann zuletzt geprueft wurde, gehoert nicht in den eingecheckten Zustand -
// sonst unterscheidet sich die Datei nach jedem Lauf und erzeugt einen Commit.
const LASTRUN_FILE = path.join(DATA, 'watch.lastrun.json');

const INIT = process.argv.includes('--init');
const TEST_PUSH = process.argv.includes('--test-push');

// Ein zufälliges ntfy-Topic. Topics sind öffentlich, wer den Namen kennt, liest
// mit - deshalb lang und geraten unmöglich. Inhalt sind ohnehin nur freie
// Kennzeichen, nichts Persönliches.
function randomTopic() {
  const r = () => Math.random().toString(36).slice(2, 10);
  return `kennzeichen-${r()}${r()}`;
}

const DEFAULT_CONFIG = {
  targets: [
    {
      label: 'Auto Münster',
      district: 'ms',
      identifier: 'MS',
      vehicle: 'pkw',
      // Gesamtlänge inkl. Kürzel. 5 = MS-AB 1, 4 = MS-A 1 (der Jackpot).
      maxLength: 5,
      onlyPatterns: [],
    },
    { label: 'Motorrad Münster', district: 'ms', identifier: 'MS', vehicle: 'krad', maxLength: 5, onlyPatterns: [] },
    // Lüdinghausen liegt im Kreis Coesfeld. Dort ist LH als Altkennzeichen
    // wählbar - mit zwei Buchstaben immer kürzer als COE, das deshalb fehlt.
    { label: 'Auto Lüdinghausen', district: 'coe', identifier: 'LH', vehicle: 'pkw', maxLength: 5, onlyPatterns: [] },
    { label: 'Motorrad Lüdinghausen', district: 'coe', identifier: 'LH', vehicle: 'krad', maxLength: 5, onlyPatterns: [] },
  ],
  notify: {
    macos: true,
    ntfy: {
      enabled: true,
      server: 'https://ntfy.sh',
      topic: randomTopic(),
    },
  },
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function notifyMac(title, message) {
  // Auf einem CI-Runner gibt es kein osascript.
  if (process.platform !== 'darwin') return;
  // osascript kann keine Anführungszeichen im Text vertragen.
  const clean = (s) => s.replace(/["\\]/g, '').slice(0, 240);
  try {
    await run('osascript', [
      '-e',
      `display notification "${clean(message)}" with title "${clean(title)}" sound name "Glass"`,
    ]);
  } catch {
    /* ohne Benachrichtigung weitermachen */
  }
}

// Push aufs Handy über ntfy.sh. Fehler hier dürfen den Lauf nicht abbrechen -
// die Erkennung ist wichtiger als die Zustellung.
async function notifyPhone(cfg, title, message, priority = 'default') {
  const n = cfg.notify?.ntfy ?? {};
  // In der Cloud kommt das Topic aus einem Secret, nicht aus der Datei.
  const topic = process.env.NTFY_TOPIC || n.topic;
  const server = process.env.NTFY_SERVER || n.server || 'https://ntfy.sh';
  if (!topic || (n.enabled === false && !process.env.NTFY_TOPIC)) return { skipped: true };
  const url = `${server.replace(/\/+$/, '')}/${topic}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: priority,
        Tags: 'car,bell',
      },
      body: message,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function relevantPlates(scan, target) {
  const out = [];
  for (const r of scan.results) {
    if (r.status !== 'ok') continue;
    // Bei "100+" zeigt das Portal nur die ersten 100 alphabetisch. Verschiebt
    // sich der Bestand dahinter, wandern Schilder durch dieses Fenster, ohne
    // dass sich real etwas ändert - das gäbe Fehlalarme. Und wo über 100 frei
    // sind, ist eine Meldung ohnehin sinnlos.
    if (r.capped) continue;
    if (target.onlyPatterns?.length && !target.onlyPatterns.includes(r.label)) continue;
    for (const p of r.plates) {
      if (target.maxLength && plateLength(p) > target.maxLength) continue;
      out.push({ plate: p.plate, pattern: r.label, length: plateLength(p), raw: p });
    }
  }
  return out;
}

async function checkTarget(target, state) {
  const district = target.district ? findDistrict(target.district) : null;
  const url = district?.url || target.url;
  if (!url) throw new Error(`Ziel "${target.label}": weder district noch url gesetzt.`);

  const scan = await scanDistrict({
    url,
    identifier: target.identifier || null,
    vehicle: target.vehicle || 'pkw',
    maxTotalLength: target.maxLength || null,
  });

  const current = relevantPlates(scan, target);
  const currentSet = new Set(current.map((p) => p.plate));

  const key = target.label;
  const previous = state[key]?.plates ?? null;
  const previousSet = new Set(previous ?? []);

  const isFirstRun = previous === null;
  const appeared = isFirstRun ? [] : current.filter((p) => !previousSet.has(p.plate));
  const gone = isFirstRun ? [] : [...previousSet].filter((p) => !currentSet.has(p));

  state[key] = {
    plates: [...currentSet].sort(),
    total: current.length,
  };

  return { target, scan, current, appeared, gone, isFirstRun };
}

const config = await readJson(CONFIG_FILE, null);
if (!config) {
  await writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  console.log(`Konfiguration angelegt: ${CONFIG_FILE}`);
  console.log('Ziele dort anpassen, dann erneut starten.\n');
}
const local = await readJson(LOCAL_FILE, {});
const base = config || DEFAULT_CONFIG;
const cfg = {
  ...base,
  notify: {
    ...base.notify,
    ...local.notify,
    ntfy: { ...base.notify?.ntfy, ...local.notify?.ntfy },
  },
};
const state = await readJson(STATE_FILE, {});

if (TEST_PUSH) {
  const t = cfg.notify?.ntfy?.topic;
  console.log(`\nTest-Push an Topic "${t}" …`);
  const r = await notifyPhone(
    cfg,
    'Kennzeichen-Wächter eingerichtet',
    'Wenn du das liest, kommen die Meldungen an.\nAb jetzt hörst du nur noch etwas, wenn wirklich ein kurzes Kennzeichen frei wird.',
    'high'
  );
  console.log(r.ok ? 'Gesendet.' : `Fehlgeschlagen: ${r.error || r.status}`);
  process.exit(r.ok ? 0 : 1);
}

const stamp = new Date().toLocaleString('de-DE');
console.log(`\n[${stamp}] Beobachtung läuft — ${cfg.targets.length} Ziel(e)\n`);

const findings = [];

for (const target of cfg.targets) {
  try {
    const res = await checkTarget(target, state);

    if (res.isFirstRun || INIT) {
      console.log(`  ${target.label}: Ausgangszustand gesetzt — ${res.current.length} Kennzeichen ≤ ${target.maxLength} Zeichen`);
      if (res.current.length) {
        console.log(`     ${rankPlates(res.current.map((p) => p.raw)).slice(0, 8).map((p) => p.plate).join('  ')}`);
      }
      continue;
    }

    if (res.appeared.length === 0 && res.gone.length === 0) {
      console.log(`  ${target.label}: unverändert (${res.current.length} frei)`);
      continue;
    }

    if (res.appeared.length) {
      const ranked = rankPlates(res.appeared.map((p) => p.raw));
      console.log(`  ${target.label}: ${res.appeared.length} NEU frei`);
      for (const p of ranked) console.log(`     + ${p.plate}`);
      findings.push({ target: target.label, appeared: ranked.map((p) => p.plate) });
    }
    if (res.gone.length) {
      console.log(`  ${target.label}: ${res.gone.length} weg (${res.gone.slice(0, 5).join(', ')})`);
    }

    await fs.mkdir(DATA, { recursive: true });
    await fs.appendFile(
      LOG_FILE,
      JSON.stringify({
        at: new Date().toISOString(),
        target: target.label,
        appeared: res.appeared.map((p) => p.plate),
        gone: res.gone,
        total: res.current.length,
      }) + '\n',
      'utf8'
    );
  } catch (err) {
    console.log(`  ${target.label}: FEHLER — ${err.message}`);
  }
}

await writeJson(STATE_FILE, state);
await writeJson(LASTRUN_FILE, {
  at: new Date().toISOString(),
  ziele: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.total])),
});

// GitHub Actions zeigt diese Datei als Zusammenfassung des Laufs an.
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ['## Kennzeichen-Wächter', ''];
  if (findings.length) {
    lines.push('**Neu frei geworden:**', '');
    for (const f of findings) lines.push(`- ${f.target}: ${f.appeared.join(', ')}`);
  } else {
    lines.push('Keine Veränderung.');
  }
  lines.push('', '| Ziel | frei |', '| --- | ---: |');
  for (const [label, v] of Object.entries(state)) lines.push(`| ${label} | ${v.total} |`);
  lines.push('', `_${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} (Europe/Berlin)_`);
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', 'utf8');
}

if (findings.length) {
  // Auto und Motorrad teilen sich denselben Kennzeichen-Pool, deshalb kann
  // dasselbe Schild bei beiden Zielen auftauchen. Einmal melden reicht.
  const seen = new Set();
  const unique = [];
  for (const f of findings) {
    for (const plate of f.appeared) {
      if (seen.has(plate)) continue;
      seen.add(plate);
      unique.push({ plate, target: f.target });
    }
  }

  const kuerzeste = Math.min(...unique.map((u) => u.plate.replace(/[^A-Z0-9]/g, '').length));
  const title =
    unique.length === 1
      ? `${unique[0].plate} ist frei`
      : `${unique.length} neue Kennzeichen frei`;

  const lines = unique.slice(0, 12).map((u) => `${u.plate}  (${u.target})`);
  if (unique.length > 12) lines.push(`… und ${unique.length - 12} weitere`);
  lines.push('', 'Reservieren: stadt-muenster.de/kfz/kennzeichen/wkz-reservieren');

  const body = lines.join('\n');
  // Vier Zeichen sind in Münster der absolute Sonderfall - lauter melden.
  const prio = kuerzeste <= 4 ? 'urgent' : 'high';

  if (cfg.notify?.macos) await notifyMac(title, unique.map((u) => u.plate).join(', '));
  const push = await notifyPhone(cfg, title, body, prio);
  if (push.skipped) console.log('  (kein Handy-Push konfiguriert)');
  else if (push.ok) console.log(`  Push ans Handy gesendet (${unique.length} Kennzeichen)`);
  else console.log(`  Push fehlgeschlagen: ${push.error || push.status}`);
}

console.log();
