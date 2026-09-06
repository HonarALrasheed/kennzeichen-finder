// Bekannte Zulassungsstellen mit dem "WKZ"-Portalsystem.
// Weitere lassen sich in der Oberflaeche als eigene URL eintragen -
// das System laeuft bei hunderten Kreisen unter /wkz/ mit gleichem Aufbau.

export const DISTRICTS = [
  {
    id: 'ms',
    name: 'Stadt Münster',
    shortName: 'Münster',        // fuer die Handy-Meldung
    url: 'https://www.stadt-muenster.de/wkz/?LICENSEIDENTIFIER=ms',
    // Seite zum Reservieren, fuer den Link in der Tagesmeldung
    reserveUrl: 'https://www.stadt-muenster.de/kfz/kennzeichen/wkz-reservieren',
    // Unterscheidungszeichen, die im Kennzeichenart-Baum waehlbar sind.
    // Leerer treeKey = kein eigener Baumknoten (nur ein Kuerzel im Bezirk).
    identifiers: [{ code: 'MS', treeKey: null }],
    reservationDays: 180,
    feeEur: 12.8,
  },
  {
    id: 'coe',
    name: 'Kreis Coesfeld (Lüdinghausen, Dülmen, Coesfeld …)',
    shortName: 'Kreis Coesfeld',
    url: 'https://www.kreis-coesfeld.de/wkz/?LICENSEIDENTIFIER=coe',
    reserveUrl: 'https://www.kreis-coesfeld.de/wkz/?LICENSEIDENTIFIER=coe',
    identifiers: [
      { code: 'COE', treeKey: null },
      { code: 'LH', treeKey: 'LH' },
    ],
    reservationDays: 90,
    feeEur: 12.8,
  },
];

// Motorradkennzeichen sind physisch kleiner (zweizeilig), deshalb laesst das
// Portal dort weniger Zeichen zu: 1 Buchstabe mit 2-3 Ziffern, 2 Buchstaben mit
// 1-2 Ziffern. '1 Buchstabe + 1 Ziffer' wird als ungueltig abgewiesen, und
// alles ab 7 Zeichen gibt es gar nicht. Wer im Pkw-Zweig sucht, bekommt fuer
// ein Motorrad also unbrauchbare Ergebnisse.
export const PATTERNS_KRAD = [
  { letters: 1, digits: 2 },
  { letters: 2, digits: 1 },
  { letters: 1, digits: 3 },
  { letters: 2, digits: 2 },
];

// Alle Muster, die das Portal fuer Pkw kennt: 1-2 Buchstaben, 1-4 Ziffern.
// Sortiert nach Gesamtlaenge des fertigen Kennzeichens.
export const PATTERNS = [
  { letters: 1, digits: 1 },
  { letters: 1, digits: 2 },
  { letters: 2, digits: 1 },
  { letters: 1, digits: 3 },
  { letters: 2, digits: 2 },
  { letters: 1, digits: 4 },
  { letters: 2, digits: 3 },
  { letters: 2, digits: 4 },
];

export function patternLabel(p) {
  const b = p.letters === 1 ? '1 Buchstabe' : '2 Buchstaben';
  const z = p.digits === 1 ? '1 Ziffer' : `${p.digits} Ziffern`;
  return `${b} + ${z}`;
}

export const VEHICLES = {
  pkw: { label: 'PKW/LKW/Wohnmobil', patterns: PATTERNS, treeText: null },
  krad: { label: 'Motorrad', patterns: PATTERNS_KRAD, treeText: 'Motorrad' },
};

export function findDistrict(id) {
  return DISTRICTS.find((d) => d.id === id) || null;
}
