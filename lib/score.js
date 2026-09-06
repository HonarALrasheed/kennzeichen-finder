// Bewertet gefundene Kennzeichen und formuliert daraus eine Auswertung.
//
// Leitgedanke: Kuerze schlaegt alles andere. Erst bei gleicher Laenge
// entscheidet, wie ruhig sich die Kombination liest.

import { RESULT_CAP } from './wkz.js';

// Buchstaben, die auf einem Schild unruhig wirken oder mit Ziffern
// verwechselt werden koennen.
const LETTER_PENALTY = {
  I: 9, O: 9, Q: 8,
  X: 6, Y: 6,
  J: 3, V: 3, W: 3, Z: 3,
};

function isRun(digits, step) {
  for (let i = 1; i < digits.length; i++) {
    if (Number(digits[i]) - Number(digits[i - 1]) !== step) return false;
  }
  return digits.length > 1;
}

function digitBonus(d) {
  let bonus = 0;
  const uniq = new Set(d).size;

  if (d.length === 1) bonus -= 5;
  if (uniq === 1 && d.length > 1) bonus -= 14;           // 11, 222, 7777
  else if (isRun(d, 1)) bonus -= 12;                      // 12, 345, 1234
  else if (isRun(d, -1)) bonus -= 10;                     // 21, 543
  else if (d.length >= 3 && d === [...d].reverse().join('')) bonus -= 8; // 303, 1221
  else if (d.length >= 2 && d.endsWith('00')) bonus -= 7; // 100, 500
  else if (d.length >= 2 && d.endsWith('0')) bonus -= 4;  // 50, 340

  if (d.length > 1 && d.startsWith('0')) bonus += 10;     // 07 liest sich falsch
  return bonus;
}

function letterPenalty(letters) {
  let pen = 0;
  for (const ch of letters) pen += LETTER_PENALTY[ch] ?? 0;
  // Ein einzelner Buchstabe ist bei gleicher Gesamtlaenge die deutlich
  // seltenere und ruhigere Variante - das muss die Rangfolge abbilden.
  if (letters.length === 1) pen -= 15;
  if (letters.length === 2 && letters[0] === letters[1]) pen -= 8; // AA, BB
  return pen;
}

export function plateLength(p) {
  return p.identifier.length + p.letters.length + p.digits.length;
}

export function scorePlate(p) {
  return plateLength(p) * 1000 + letterPenalty(p.letters) + digitBonus(p.digits);
}

export function rankPlates(plates) {
  return [...plates].sort((a, b) => scorePlate(a) - scorePlate(b) || a.plate.localeCompare(b.plate));
}

function rarity(count, capped) {
  if (capped) return { level: 'reichlich', note: `über ${RESULT_CAP} frei — in Ruhe aussuchen` };
  if (count === 0) return { level: 'vergeben', note: 'nichts mehr frei' };
  if (count <= 3) return { level: 'extrem knapp', note: `nur ${count} Stück im ganzen Bezirk` };
  if (count <= 15) return { level: 'knapp', note: `${count} freie Kombinationen` };
  if (count <= 50) return { level: 'überschaubar', note: `${count} freie Kombinationen` };
  return { level: 'solide', note: `${count} freie Kombinationen` };
}

/**
 * Baut aus dem Scan-Ergebnis die Auswertung: kuerzeste erreichbare Laenge,
 * Seltenheit und konkrete Empfehlungen mit Begruendung.
 */
export function buildVerdict(scan) {
  const withHits = scan.results.filter((r) => r.status === 'ok' && r.plates.length > 0);
  const allPlates = withHits.flatMap((r) => r.plates);

  if (allPlates.length === 0) {
    return {
      headline: 'Nichts gefunden',
      body: 'In keinem der acht Muster ist derzeit eine Kombination frei. Das ist ungewöhnlich — bitte den Scan später wiederholen.',
      shortestLength: null,
      picks: [],
      blocked: scan.results.filter((r) => r.status !== 'ok').map((r) => r.label),
    };
  }

  const shortestLength = Math.min(...allPlates.map(plateLength));
  const shortestPlates = allPlates.filter((p) => plateLength(p) === shortestLength);

  // Alle Muster, die diese kuerzeste Laenge liefern
  const shortestFormats = withHits.filter((r) =>
    r.plates.some((p) => plateLength(p) === shortestLength)
  );

  const totalShortest = shortestFormats.reduce((n, r) => n + r.count, 0);
  const anyCapped = shortestFormats.some((r) => r.capped);
  const rar = rarity(totalShortest, anyCapped);

  const ranked = rankPlates(shortestPlates);
  const picks = ranked.slice(0, 5).map((p) => ({
    plate: p.plate,
    length: plateLength(p),
    reason: pickReason(p),
  }));

  // Welche Muster hat das Amt gar nicht angeboten?
  const impossible = scan.results
    .filter((r) => r.status === 'empty' || r.status === 'invalid')
    .map((r) => ({
      label: r.label,
      why: r.status === 'invalid' ? 'vom Portal abgelehnt' : 'komplett vergeben',
    }));

  const timedOut = scan.results
    .filter((r) => r.status === 'timeout' || r.status === 'failed')
    .map((r) => r.label);

  const shorterThanFound = impossible.filter((r) => {
    const fmt = scan.results.find((x) => x.label === r.label);
    return scan.identifier && scan.identifier.length + fmt.letters + fmt.digits < shortestLength;
  });

  const headline = `Kürzestes erreichbares Kennzeichen: ${shortestLength} Zeichen`;

  const parts = [];
  parts.push(
    `Die kürzeste Form, die du hier noch bekommst, hat ${shortestLength} Zeichen — über ${shortestFormats
      .map((r) => r.label)
      .join(' bzw. ')}.`
  );
  parts.push(`Verfügbarkeit: ${rar.level} (${rar.note}).`);
  if (shorterThanFound.length) {
    parts.push(
      `Noch kürzer geht nicht: ${shorterThanFound
        .map((r) => `${r.label} ist ${r.why}`)
        .join(', ')}.`
    );
  }
  if (totalShortest <= 5 && !anyCapped) {
    parts.push('Bei so wenigen Treffern lohnt sich schnelles Handeln — die Liste kann morgen leer sein.');
  }
  if (timedOut.length) {
    parts.push(
      `Ohne Ergebnis blieb: ${timedOut.join(', ')} — das Portal selbst hat die Suche abgebrochen. Für die kürzeste Länge ist das ohne Belang.`
    );
  }

  return {
    headline,
    body: parts.join(' '),
    shortestLength,
    shortestFormats: shortestFormats.map((r) => r.label),
    rarity: rar,
    totalShortest,
    capped: anyCapped,
    picks,
    impossible,
    timedOut,
  };
}

function pickReason(p) {
  const reasons = [];
  const d = p.digits;
  const uniq = new Set(d).size;

  if (p.letters.length === 1) reasons.push('nur ein Buchstabe — die seltenste Variante');
  if (p.letters.length === 2 && p.letters[0] === p.letters[1]) reasons.push('Doppelbuchstabe');
  if (uniq === 1 && d.length > 1) reasons.push('gleiche Ziffern');
  else if (isRun(d, 1)) reasons.push('aufsteigende Ziffern');
  else if (isRun(d, -1)) reasons.push('absteigende Ziffern');
  else if (d.length >= 3 && d === [...d].reverse().join('')) reasons.push('symmetrisch');
  else if (d.endsWith('00')) reasons.push('glatte Zahl');

  const awkward = [...p.letters].filter((c) => (LETTER_PENALTY[c] ?? 0) >= 6);
  if (awkward.length === 0) reasons.push('unauffällige Buchstaben');
  else reasons.push(`Buchstabe ${awkward.join('/')} fällt etwas aus dem Rahmen`);

  return reasons.join(', ');
}
