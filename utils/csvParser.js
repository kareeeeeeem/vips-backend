/**
 * A CSV reader that follows RFC 4180.
 *
 * Written rather than pulled in, because the whole job is one loop over a
 * string and the alternative is a dependency in a backend that also handles
 * payments. What it has to get right is the quoting: a product called
 * `Café "Special", large` is one field, not three, and splitting on commas
 * would shift every column after it and silently import a price as a category.
 */

/** Rows of raw strings, quotes resolved. Blank trailing lines are dropped. */
function parseCsv(text) {
  // Excel writes a byte-order mark; left in place it becomes part of the
  // first header, so 'name' arrives as '﻿name' and never matches.
  let input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Normalise line endings so a file saved on Windows does not leave a \r
  // glued to the last value of every row.
  input = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        // Newlines inside quotes belong to the value — a description can
        // legitimately span lines.
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Whatever is left after the last newline is a final row unless the file
  // ended cleanly on one.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

/**
 * Rows as objects keyed by the header line.
 *
 * Headers are lower-cased and stripped of spaces and underscores, so
 * 'Cost Price', 'cost_price' and 'costprice' all reach the same field — a
 * merchant editing a template in Excel should not have an import fail over
 * a capital letter.
 */
function parseCsvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const keys = headers.map((h) => h.toLowerCase().replace(/[\s_-]/g, ''));

  const records = rows.slice(1).map((values, index) => {
    const record = {};
    keys.forEach((key, column) => {
      if (!key) return;
      record[key] = (values[column] ?? '').trim();
    });
    // The line number in the file the merchant is looking at: +2 for the
    // header and for counting from one. "Row 7 is wrong" has to mean the
    // seventh line they can see.
    record.__line = index + 2;
    return record;
  });

  return { headers, records };
}

/** Turn rows back into CSV, quoting every field. */
function toCsvRows(rows) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return rows.map((row) => row.map(escape).join(',')).join('\n');
}

module.exports = { parseCsv, parseCsvToObjects, toCsvRows };
