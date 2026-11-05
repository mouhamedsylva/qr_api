/** Cellule CSV ; neutralise les formules (injection CSV dans Excel). */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV au format attendu par Excel en français : séparateur « ; », fins de
 * ligne CRLF, BOM UTF-8 pour que les accents s'affichent correctement.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}
