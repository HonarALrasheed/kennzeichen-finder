const $ = (id) => document.getElementById(id);

const el = {
  district: $('district'),
  identifier: $('identifier'),
  vehicle: $('vehicle'),
  customUrl: $('customUrl'),
  scanNote: $('scanNote'),
  start: $('start'),
  topMeta: $('topMeta'),
  progressCard: $('progressCard'),
  barFill: $('barFill'),
  log: $('log'),
  output: $('output'),
  verdictLen: $('verdictLen'),
  verdictHead: $('verdictHead'),
  verdictText: $('verdictText'),
  rarity: $('rarity'),
  heroPick: $('heroPick'),
  picks: $('picks'),
  formats: $('formats'),
  stars: $('stars'),
  feedbackForm: $('feedbackForm'),
  fbMessage: $('fbMessage'),
  fbNote: $('fbNote'),
  fbList: $('fbList'),
};

let districts = [];
let lastScan = null;
let rating = 0;

/* ── Das Schild ───────────────────────────────────────────
   Ein echtes deutsches Kennzeichen: EU-Streifen mit Sternen-
   kranz und "D", Bezirkskürzel, Zulassungssiegel, Erkennungs-
   nummer. Die Größe steuert allein die font-size der Klasse. */

const STAR_RING = (() => {
  const pts = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    return `<circle cx="${(12 + Math.cos(a) * 7.6).toFixed(2)}" cy="${(12 + Math.sin(a) * 7.6).toFixed(2)}" r="1.5"/>`;
  }).join('');
  return `<svg class="plate__stars" viewBox="0 0 24 24" fill="#ffcc00" aria-hidden="true">${pts}</svg>`;
})();

function plateNode(text, size = '') {
  const m = String(text).match(/^([A-ZÄÖÜ]{1,3})[-\s]+(.+)$/);
  const district = m ? m[1] : text;
  const rest = m ? m[2] : '';

  const wrap = document.createElement('span');
  wrap.className = 'plate' + (size ? ` plate--${size}` : '');
  wrap.setAttribute('aria-label', `Kennzeichen ${text}`);
  wrap.innerHTML =
    `<span class="plate__eu">${STAR_RING}<span class="plate__d">D</span></span>` +
    `<span class="plate__body">` +
      `<span class="plate__district"></span>` +
      `<span class="plate__seal"></span>` +
      `<span class="plate__id"></span>` +
    `</span>`;
  wrap.querySelector('.plate__district').textContent = district;
  wrap.querySelector('.plate__id').textContent = rest;
  return wrap;
}

/* ── Bezirksauswahl ─────────────────────────────────────── */

async function loadDistricts() {
  const res = await fetch('/api/districts');
  districts = (await res.json()).districts;

  el.district.innerHTML = '';
  for (const d of districts) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    el.district.appendChild(o);
  }
  syncIdentifiers();
}

function syncIdentifiers() {
  const d = districts.find((x) => x.id === el.district.value);
  el.identifier.innerHTML = '';
  if (!d) return;
  for (const ident of d.identifiers) {
    const o = document.createElement('option');
    o.value = ident.code;
    o.textContent = ident.code;
    el.identifier.appendChild(o);
  }
  el.identifier.disabled = d.identifiers.length < 2;
}

el.district.addEventListener('change', syncIdentifiers);

// Motorradkennzeichen sind kürzer gedeckelt, deshalb nur vier Muster.
function syncVehicleNote() {
  const krad = el.vehicle.value === 'krad';
  el.scanNote.textContent = krad
    ? '4 Anfragen · ca. 15–30 Sekunden · max. 6 Zeichen möglich'
    : '8 Anfragen · ca. 30–60 Sekunden';
}
el.vehicle.addEventListener('change', syncVehicleNote);
syncVehicleNote();

/* ── Scan ───────────────────────────────────────────────── */

function logLine(html, cls = '') {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.innerHTML = html;
  el.log.appendChild(li);
}

const STATUS_TEXT = {
  ok: null,
  empty: 'komplett vergeben',
  invalid: 'vom Portal abgelehnt',
  timeout: 'Zeitüberschreitung',
  failed: 'Portal hat abgebrochen',
};

function startScan() {
  const custom = el.customUrl.value.trim();
  const params = new URLSearchParams();
  if (custom) params.set('url', custom);
  else params.set('district', el.district.value);
  if (el.identifier.value) params.set('identifier', el.identifier.value);
  params.set('vehicle', el.vehicle.value);

  el.start.disabled = true;
  el.start.querySelector('.btn__label').textContent = 'Scan läuft';
  el.output.hidden = true;
  el.progressCard.hidden = false;
  el.log.innerHTML = '';
  el.barFill.style.width = '0%';
  el.topMeta.textContent = 'Scan läuft …';

  const es = new EventSource('/api/scan?' + params.toString());

  es.addEventListener('progress', (d0) => {
    const d = JSON.parse(d0.data);
    if (d.phase === 'result') {
      const verdict =
        d.status === 'ok'
          ? `<b>${d.count}${d.count >= 100 ? '+' : ''} frei</b>`
          : STATUS_TEXT[d.status] || 'unklar';
      logLine(`<span>${d.label}</span><span>—</span>${verdict}`);
      el.barFill.style.width = `${Math.round((d.step / d.total) * 100)}%`;
    } else if (d.message) {
      logLine(`<span>${d.message}</span>`);
    }
  });

  es.addEventListener('done', (d0) => {
    lastScan = JSON.parse(d0.data);
    render(lastScan);
    el.barFill.style.width = '100%';
    logLine(`<b>Fertig</b><span>—</span><span>${lastScan.requests} Anfragen in ${(lastScan.durationMs / 1000).toFixed(1)} s</span>`);
    el.topMeta.textContent = `${lastScan.districtName} · ${lastScan.vehicleLabel || ''}`;
    finish(es);
  });

  es.addEventListener('error', (d0) => {
    let msg = 'Verbindung zum Scan abgebrochen.';
    try {
      msg = JSON.parse(d0.data).message;
    } catch {}
    logLine(`<span>${msg}</span>`, 'error');
    el.topMeta.textContent = 'Scan fehlgeschlagen';
    finish(es);
  });

  es.onerror = () => finish(es);
}

function finish(es) {
  es.close();
  el.start.disabled = false;
  el.start.querySelector('.btn__label').textContent = 'Erneut scannen';
}

el.start.addEventListener('click', startScan);

/* ── Darstellung ────────────────────────────────────────── */

function render(scan) {
  const v = scan.verdict;

  el.verdictLen.textContent = v.shortestLength ?? '–';
  el.verdictHead.textContent = v.headline;
  el.verdictText.textContent = v.body;

  if (v.rarity) {
    el.rarity.dataset.level = v.rarity.level;
    el.rarity.textContent = `${v.rarity.level} — ${v.rarity.note}`;
    el.rarity.hidden = false;
  } else {
    el.rarity.hidden = true;
  }

  // Der beste Treffer bekommt die große Bühne.
  el.heroPick.innerHTML = '';
  const [best, ...rest] = v.picks;
  if (best) {
    const tag = document.createElement('span');
    tag.className = 'hero-pick__tag';
    tag.textContent = 'Beste Wahl';
    const why = document.createElement('p');
    why.className = 'hero-pick__why';
    why.textContent = best.reason;
    el.heroPick.append(tag, plateNode(best.plate, 'lg'), why);
    el.heroPick.hidden = false;
  } else {
    el.heroPick.hidden = true;
  }

  el.picks.innerHTML = '';
  rest.forEach((p, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${0.06 * (i + 1)}s`;

    const rank = document.createElement('span');
    rank.className = 'picks__rank';
    rank.textContent = String(i + 2).padStart(2, '0');

    const why = document.createElement('span');
    why.className = 'picks__why';
    why.textContent = p.reason;

    li.append(rank, plateNode(p.plate), why);
    el.picks.appendChild(li);
  });

  el.formats.innerHTML = '';
  for (const r of scan.results) {
    const d = document.createElement('details');
    d.className = 'fmt';
    d.dataset.status = r.status;

    const s = document.createElement('summary');
    const cnt =
      r.status === 'ok'
        ? `<span class="cnt">${r.count}${r.capped ? '+' : ''} frei</span>`
        : `<span class="cnt" data-empty="1">${STATUS_TEXT[r.status] || 'nicht angeboten'}</span>`;
    s.innerHTML =
      `<span class="len">${r.totalLength} Zeichen</span>` +
      `<span class="name">${r.label}</span>${cnt}`;
    d.appendChild(s);

    if (r.plates.length) {
      const box = document.createElement('div');
      box.className = 'fmt__plates';
      for (const p of r.plates) box.appendChild(plateNode(p.plate, 'sm'));
      if (r.capped) {
        const more = document.createElement('span');
        more.className = 'fmt__more';
        more.textContent = 'Portal zeigt max. 100';
        box.appendChild(more);
      }
      d.appendChild(box);
    }
    el.formats.appendChild(d);
  }

  el.output.hidden = false;
  loadFeedback();
}

/* ── Feedback ───────────────────────────────────────────── */

function buildStars() {
  el.stars.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'star';
    b.textContent = '★';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', `${i} von 5`);
    b.addEventListener('click', () => {
      rating = i;
      [...el.stars.children].forEach((s, idx) => {
        s.classList.toggle('on', idx < i);
        s.setAttribute('aria-checked', String(idx === i - 1));
      });
    });
    el.stars.appendChild(b);
  }
}

el.feedbackForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = el.fbMessage.value.trim();
  if (!message) {
    el.fbNote.textContent = 'Bitte einen Text eingeben.';
    return;
  }
  el.fbNote.textContent = 'Wird gespeichert …';

  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      rating,
      district: lastScan?.districtName,
      vehicle: lastScan?.vehicle,
      identifier: lastScan?.identifier,
      shortestLength: lastScan?.verdict?.shortestLength,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    el.fbNote.textContent = data.error || 'Fehler beim Speichern.';
    return;
  }
  el.fbNote.textContent = `Gespeichert · ${data.total} Eintrag${data.total === 1 ? '' : 'e'}`;
  el.fbMessage.value = '';
  rating = 0;
  buildStars();
  loadFeedback();
});

async function loadFeedback() {
  const res = await fetch('/api/feedback');
  const { feedback } = await res.json();
  el.fbList.innerHTML = '';
  for (const f of feedback.slice(0, 5)) {
    const div = document.createElement('div');
    div.className = 'fb-item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      new Date(f.createdAt).toLocaleString('de-DE') +
      (f.rating ? ' · ' + '★'.repeat(f.rating) : '') +
      (f.context?.district ? ' · ' + f.context.district : '');

    const p = document.createElement('p');
    p.textContent = f.message;

    div.append(meta, p);
    el.fbList.appendChild(div);
  }
}

buildStars();
loadDistricts();
