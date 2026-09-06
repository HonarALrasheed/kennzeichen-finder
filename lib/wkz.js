// Treiber fuer das "WKZ"-Wunschkennzeichenportal, das viele deutsche
// Zulassungsstellen einsetzen (stadt-muenster.de/wkz, kreis-coesfeld.de/wkz, ...).
//
// Das Portal ist ein server-gerenderter Wizard mit Session-State. Es gibt keine
// API und keine CORS-Header, deshalb wird ein echter Browser ferngesteuert.
//
// Der entscheidende Trick: die Suchmaske akzeptiert '?' als Platzhalter fuer
// genau ein Zeichen. Ein kompletter Scan ueber alle acht Muster braucht damit
// acht Anfragen statt zehntausender Einzelabfragen.

import { chromium } from 'playwright';
import { VEHICLES, patternLabel } from './districts.js';

const SEL = {
  introNext: 'button[name="ACTION_INFOPAGE_NEXT"]',
  typeNext: 'button[name="ACTION_CHOICEAKZTYPE_NEXT"]',
  chars: 'input[name="WKZSEARCH_CHARS"]',
  nums: 'input[name="WKZSEARCH_NUMS"]',
  searchGo: 'button[name="ACTION_SEARCHPAGE_NEXT"]',
  resultList: 'select[name="WKZRESULTLIST_WKZ"]',
  resultBack: 'button[name="ACTION_WKZLISTPAGE_PREVIOUS"]',
};

// Das Portal deckelt jede Trefferliste bei 100 Eintraegen.
export const RESULT_CAP = 100;

async function launchBrowser() {
  // Erst das installierte Chrome versuchen, sonst Playwrights eigenes Chromium.
  // Auf CI-Runnern gibt es kein Chrome, dort greift immer der Rückfall.
  // PLAYWRIGHT_BUNDLED=1 erzwingt ihn zum Testen.
  if (!process.env.PLAYWRIGHT_BUNDLED) {
    try {
      return await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      /* Rückfall unten */
    }
  }
  return await chromium.launch({ headless: true });
}

function readState() {
  if (document.querySelector('select[name="WKZRESULTLIST_WKZ"]')) return 'results';
  if (document.querySelector('input[name="WKZSEARCH_CHARS"]')) return 'search';
  if (document.querySelector('button[name="ACTION_CHOICEAKZTYPE_NEXT"]')) return 'type';
  if (document.querySelector('button[name="ACTION_INFOPAGE_NEXT"]')) return 'intro';
  return 'unknown';
}

const state = (page) => page.evaluate(readState);
const mainText = (page) =>
  page.evaluate(() => (document.querySelector('main') || document.body).innerText.replace(/\s+/g, ' '));

// Jede Aktion loest einen Form-POST aus. Wir markieren das window-Objekt und
// warten, bis entweder die Markierung weg ist (echter Reload) oder sich der
// Seitentext geaendert hat (Teil-Rerender).
async function act(page, fn, timeout = 45000) {
  const before = await mainText(page);
  await page.evaluate(() => {
    window.__wkzMark = Math.random();
  });
  await fn();
  await page.waitForFunction(
    (prev) => {
      if (typeof window.__wkzMark === 'undefined') return true;
      const el = document.querySelector('main') || document.body;
      return el.innerText.replace(/\s+/g, ' ') !== prev;
    },
    before,
    { timeout }
  );
  await page.waitForTimeout(250);
}

// Ein Klick loest einen Form-POST aus; Playwright wartet dabei auf die
// Navigation und laeuft bei langsamen Portalantworten in sein eigenes
// Zeitlimit. Das Warten uebernimmt act(), der Klickfehler wird geschluckt.
async function clickByName(page, selector, timeout) {
  await act(page, () => page.click(selector).catch(() => {}), timeout);
}

// Waehlt im Kennzeichenart-Baum ein Unterscheidungszeichen (z. B. LH statt COE).
async function selectIdentifier(page, code) {
  const result = await page.evaluate((code) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const altOf = (b) => (b.querySelector('img')?.alt || '').replace(/-\s*$/, '').trim();

    const already = buttons.find((b) => b.value === 'Ausgewählt:' && altOf(b) === code);
    if (already) return 'already';

    const target = buttons.find(
      (b) => altOf(b) === code || b.name.split('||EXPAND||')[1] === code
    );
    if (target) {
      target.click();
      return 'clicked';
    }
    return 'notfound';
  }, code);

  if (result === 'clicked') {
    await page.waitForFunction(() => typeof window.__wkzMark === 'undefined', null, { timeout: 45000 })
      .catch(() => {});
    await page.waitForSelector(SEL.typeNext, { timeout: 45000 });
    await page.waitForTimeout(300);
  }
  return result;
}

// Waehlt die Fahrzeugart. Der Motorrad-Zweig hat eigene Formatregeln, deshalb
// darf er nicht mit dem Pkw-Zweig verwechselt werden.
async function selectVehicle(page, treeText) {
  if (!treeText) return 'default';
  const result = await page.evaluate((label) => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === label
    );
    if (!b) return 'notfound';
    if (b.value === 'Ausgewählt:') return 'already';
    b.click();
    return 'clicked';
  }, treeText);

  if (result === 'clicked') {
    await page
      .waitForFunction(() => typeof window.__wkzMark === 'undefined', null, { timeout: 45000 })
      .catch(() => {});
    await page.waitForSelector(SEL.typeNext, { timeout: 45000 });
    await page.waitForTimeout(300);
  }
  return result;
}

// Stellt sicher, dass "normales Kennzeichen" (nicht Serienkennzeichen) aktiv ist.
async function selectNormalPlate(page) {
  const result = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => (x.textContent || '').trim() === 'normales Kennzeichen'
    );
    if (!b) return 'notfound';
    if (b.value === 'Ausgewählt:') return 'already';
    b.click();
    return 'clicked';
  });

  if (result === 'clicked') {
    await page.waitForFunction(() => typeof window.__wkzMark === 'undefined', null, { timeout: 45000 })
      .catch(() => {});
    await page.waitForSelector(SEL.typeNext, { timeout: 45000 });
    await page.waitForTimeout(300);
  }
  return result;
}

// Fuehrt eine einzelne Platzhaltersuche aus und liefert den Rohbefund.
async function runSearch(page, letters, digits, timeout) {
  if ((await state(page)) === 'results') {
    await clickByName(page, SEL.resultBack, timeout);
  }
  await page.waitForSelector(SEL.chars, { timeout: 45000 });

  const charPattern = '?'.repeat(letters);
  const numPattern = '?'.repeat(digits);

  await page.evaluate(
    ({ c, n }) => {
      const setField = (name, value) => {
        const el = document.getElementsByName(name)[0];
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setField('WKZSEARCH_CHARS', c);
      setField('WKZSEARCH_NUMS', n);
      // "Besondere Einstellungen" neutral halten
      const reset = (name) => {
        const el = document.getElementsByName(name)[0];
        if (el) {
          el.value = '1';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      reset('WKZSEARCH_SPECIALCHARS');
      reset('WKZSEARCH_SPECIALNUMS');
    },
    { c: charPattern, n: numPattern }
  );

  await clickByName(page, SEL.searchGo, timeout);

  return page.evaluate(() => {
    const txt = (document.querySelector('main') || document.body).innerText.replace(/\s+/g, ' ');
    const sel = document.querySelector('select[name="WKZRESULTLIST_WKZ"]');
    const hit = txt.match(/(\d+)\s+gefundene freie Kennzeichen/);

    if (sel) {
      return {
        status: 'ok',
        count: hit ? Number(hit[1]) : sel.options.length,
        values: Array.from(sel.options).map((o) => o.value),
      };
    }
    if (/Suche fehlgeschlagen|Fachverfahren/i.test(txt))
      return { status: 'failed', count: 0, values: [] };
    if (/ung.ltig/i.test(txt)) return { status: 'invalid', count: 0, values: [] };
    if (/keine freien Kennzeichen/i.test(txt)) return { status: 'empty', count: 0, values: [] };
    return { status: 'unknown', count: 0, values: [], text: txt.slice(0, 200) };
  });
}

function parsePlate(raw) {
  const m = String(raw).match(/^([A-ZÄÖÜ]{1,3})-([A-Z]{1,2})(\d{1,4})$/);
  if (!m) return null;
  return { identifier: m[1], letters: m[2], digits: m[3], plate: `${m[1]}-${m[2]} ${m[3]}` };
}

/**
 * Scannt eine Zulassungsstelle ueber alle acht Muster.
 *
 * @param {object} opts
 * @param {string} opts.url            Portal-URL
 * @param {string} [opts.identifier]   Unterscheidungszeichen (z. B. 'LH')
 * @param {number} [opts.politenessMs] Pause zwischen zwei Anfragen
 * @param {(e:object)=>void} [opts.onProgress]
 */
export async function scanDistrict({
  url,
  identifier = null,
  vehicle = 'pkw',
  maxTotalLength = null,
  politenessMs = 900,
  searchTimeoutMs = 120000,
  onProgress = () => {},
}) {
  const vehicleSpec = VEHICLES[vehicle] || VEHICLES.pkw;

  // Wer nur kurze Kennzeichen sucht, braucht die langen Muster gar nicht
  // abzufragen. Das spart Zeit, schont das Portal und umgeht nebenbei das
  // Muster, an dem dessen Fachverfahren regelmäßig abbricht.
  const identLen = identifier ? identifier.length : 0;
  const patterns =
    maxTotalLength && identLen
      ? vehicleSpec.patterns.filter((p) => identLen + p.letters + p.digits <= maxTotalLength)
      : vehicleSpec.patterns;

  if (patterns.length === 0) {
    throw new Error(
      `Für ${identifier} gibt es bei ${vehicleSpec.label} kein Muster mit höchstens ${maxTotalLength} Zeichen.`
    );
  }

  const browser = await launchBrowser();
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();
  const started = Date.now();

  // Fuehrt den Wizard von der Startseite bis zur Suchmaske.
  // Wird auch zur Wiederherstellung nach einem Fehler benutzt.
  async function setupWizard() {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(700);

    if ((await state(page)) === 'intro') {
      await clickByName(page, SEL.introNext);
    }

    if ((await state(page)) === 'type') {
      if (identifier) {
        // 'notfound' ist kein Fehler: Bezirke mit nur einem Kuerzel zeigen
        // dafuer keinen eigenen Knoten an. Ob wirklich das gewuenschte
        // Kuerzel gescannt wurde, prueft die Ergebniskontrolle weiter unten.
        await selectIdentifier(page, identifier);
      }
      await selectVehicle(page, vehicleSpec.treeText);
      await selectNormalPlate(page);
      await clickByName(page, SEL.typeNext);
    }

    await page.waitForSelector(SEL.chars, { timeout: 45000 });
  }

  try {
    onProgress({ phase: 'open', message: 'Portal wird geöffnet …' });
    if (identifier) {
      onProgress({ phase: 'select', message: `Unterscheidungszeichen ${identifier} wird gewählt …` });
    }
    await setupWizard();

    const results = [];
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      onProgress({
        phase: 'search',
        step: i + 1,
        total: patterns.length,
        message: `Suche ${patternLabel(p)} …`,
      });

      let raw;
      try {
        raw = await runSearch(page, p.letters, p.digits, searchTimeoutMs);
      } catch (err) {
        // Ein einzelnes Muster darf den ganzen Scan nicht kippen. Grosse
        // Suchraeume (2 Buchstaben + 4 Ziffern) laufen gelegentlich in die
        // Zeitgrenze des Portals.
        raw = { status: 'timeout', count: 0, values: [], error: err?.message };
        try {
          await setupWizard();
        } catch {
          onProgress({ phase: 'result', step: i + 1, total: patterns.length,
            label: patternLabel(p), status: 'timeout', count: 0 });
          results.push({ ...p, label: patternLabel(p), status: 'timeout',
            count: 0, capped: false, plates: [] });
          break;
        }
      }

      const plates = raw.values.map(parsePlate).filter(Boolean);

      // Erste echte Trefferliste gegen das gewuenschte Kuerzel pruefen.
      if (identifier && plates.length && plates[0].identifier !== identifier) {
        throw new Error(
          `Das Portal liefert Kennzeichen mit "${plates[0].identifier}" statt "${identifier}". ` +
            `Dieses Unterscheidungszeichen ist hier offenbar nicht wählbar.`
        );
      }

      results.push({
        ...p,
        label: patternLabel(p),
        status: raw.status,
        count: raw.count,
        capped: raw.status === 'ok' && raw.count >= RESULT_CAP,
        plates,
      });

      onProgress({
        phase: 'result',
        step: i + 1,
        total: patterns.length,
        label: patternLabel(p),
        status: raw.status,
        count: raw.count,
      });

      if (i < patterns.length - 1) await page.waitForTimeout(politenessMs);
    }

    return {
      url,
      vehicle,
      vehicleLabel: vehicleSpec.label,
      identifier: identifier || (results.flatMap((r) => r.plates)[0]?.identifier ?? null),
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      requests: results.length,
      results,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
