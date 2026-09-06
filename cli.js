// Scan ohne Oberflaeche:  node cli.js [bezirks-id] [unterscheidungszeichen]
//   node cli.js ms
//   node cli.js coe LH
//   node cli.js --url "https://…/wkz/?LICENSEIDENTIFIER=xx" --id XX

import { DISTRICTS, findDistrict } from './lib/districts.js';
import { scanDistrict } from './lib/wkz.js';
import { buildVerdict, rankPlates } from './lib/score.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const url = flag('--url');
const vehicle = argv.includes('--krad') || argv.includes('--motorrad') ? 'krad' : 'pkw';
const positional = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--url' && argv[argv.indexOf(a) - 1] !== '--id');
const districtId = url ? null : positional[0] || 'ms';
const identifier = (flag('--id') || positional[1] || '').toUpperCase() || null;

const district = districtId ? findDistrict(districtId) : null;
if (!url && !district) {
  console.error(`Unbekannter Bezirk "${districtId}". Verfügbar: ${DISTRICTS.map((d) => d.id).join(', ')}`);
  process.exit(1);
}

const target = url || district.url;
console.log(
  `\nScanne ${district?.name || target}${identifier ? ` · ${identifier}` : ''}` +
    ` · ${vehicle === 'krad' ? 'Motorrad' : 'PKW'}\n`
);

const scan = await scanDistrict({
  url: target,
  identifier,
  vehicle,
  onProgress: (e) => {
    if (e.phase === 'result') {
      const s =
        e.status === 'ok' ? `${e.count}${e.count >= 100 ? '+' : ''} frei`
        : e.status === 'empty' ? 'komplett vergeben'
        : e.status === 'invalid' ? 'vom Portal abgelehnt'
        : e.status === 'timeout' ? 'Zeitüberschreitung'
        : e.status === 'failed' ? 'Portal hat abgebrochen'
        : 'unklar';
      console.log(`  [${e.step}/${e.total}] ${e.label.padEnd(28)} ${s}`);
    } else if (e.message) {
      console.log(`  ${e.message}`);
    }
  },
});

const verdict = buildVerdict(scan);

console.log(`\n${'='.repeat(58)}`);
console.log(verdict.headline.toUpperCase());
console.log('='.repeat(58));
console.log(verdict.body);
if (verdict.rarity) console.log(`\nVerfügbarkeit: ${verdict.rarity.level} — ${verdict.rarity.note}`);

console.log('\nEmpfehlung:');
for (const p of verdict.picks) console.log(`  ${p.plate.padEnd(12)} ${p.reason}`);

console.log('\nAlle Muster:');
for (const r of scan.results) {
  const total = (scan.identifier?.length ?? 0) + r.letters + r.digits;
  const s =
    r.status === 'ok' ? `${r.count}${r.capped ? '+' : ''} frei`
    : r.status === 'empty' ? 'komplett vergeben'
    : r.status === 'timeout' ? 'Zeitüberschreitung'
    : r.status === 'failed' ? 'Portal hat abgebrochen'
    : 'nicht angeboten';
  console.log(`  ${String(total).padStart(2)} Zeichen  ${r.label.padEnd(24)} ${s}`);
}

const shortest = rankPlates(
  scan.results.flatMap((r) => r.plates)
).filter((p) => p.identifier.length + p.letters.length + p.digits.length === verdict.shortestLength);

const shortCapped = scan.results.some(
  (r) => r.capped && (scan.identifier?.length ?? 0) + r.letters + r.digits === verdict.shortestLength
);
console.log(
  `\n${shortCapped ? 'Die ersten' : 'Alle'} ${shortest.length} kürzesten (${verdict.shortestLength} Zeichen)` +
    `${shortCapped ? ' — das Portal zeigt max. 100 pro Muster' : ''}:`
);
console.log('  ' + shortest.map((p) => p.plate).join('   '));
console.log(`\n${scan.requests} Anfragen in ${(scan.durationMs / 1000).toFixed(1)} s\n`);
