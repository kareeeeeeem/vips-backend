const express = require('express');
const multer = require('multer');

const Product = require('../models/Product');
const ProductImport = require('../models/ProductImport');
const { parseCsvToObjects, toCsvRows } = require('../utils/csvParser');

const router = express.Router();

// Held in memory, not written to disk. The file is parsed immediately and
// never needed again, so there is nothing to clean up afterwards and no
// window where a half-processed upload is sitting in a public directory.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

// One import is not a migration. A file larger than this is almost always a
// mistake, and processing it would hold a request open long enough to look
// like the server had hung.
const MAX_ROWS = 2000;
const MAX_REPORTED_ISSUES = 100;

const COLUMNS = [
  { key: 'name',          label: 'name',          required: true },
  { key: 'category',      label: 'category',      required: true },
  { key: 'price',         label: 'price',         required: true, numeric: true },
  { key: 'costprice',     label: 'costPrice',     numeric: true, field: 'costPrice' },
  { key: 'discountprice', label: 'discountPrice', numeric: true, field: 'discountPrice' },
  { key: 'stock',         label: 'stock',         numeric: true, integer: true },
  { key: 'alertqty',      label: 'alertQty',      numeric: true, integer: true },
  { key: 'vat',           label: 'vat',           numeric: true },
  { key: 'code',          label: 'code' },
  { key: 'description',   label: 'description' },
  { key: 'image',         label: 'image' },
];

/**
 * Turn one row into a product, or into the reasons it cannot be one.
 *
 * Every problem with a row is collected rather than returning at the first —
 * a merchant fixing a spreadsheet wants the whole list, not one error per
 * upload attempt.
 */
function readRow(record) {
  const issues = [];
  const line = record.__line;
  const product = {};

  for (const column of COLUMNS) {
    const raw = (record[column.key] ?? '').trim();

    if (!raw) {
      if (column.required) {
        issues.push({ line, field: column.label, message: `${column.label} is required.` });
      }
      continue;
    }

    if (column.numeric) {
      // Accept a comma as the decimal separator: a spreadsheet in a French
      // or Arabic locale writes 12,50 and the merchant did nothing wrong.
      const value = Number(raw.replace(',', '.'));
      if (!Number.isFinite(value)) {
        issues.push({ line, field: column.label, message: `${column.label} is not a number ("${raw}").` });
        continue;
      }
      if (value < 0) {
        issues.push({ line, field: column.label, message: `${column.label} cannot be negative.` });
        continue;
      }
      product[column.field || column.key] = column.integer ? Math.trunc(value) : value;
    } else {
      product[column.field || column.key] = raw;
    }
  }

  // A "discount" above the list price is not a discount, and the till would
  // charge it as the selling price.
  if (
    product.discountPrice !== undefined &&
    product.price !== undefined &&
    product.discountPrice > product.price
  ) {
    issues.push({
      line,
      field: 'discountPrice',
      message: 'The discount price cannot exceed the price.',
    });
  }

  return { line, product, issues };
}

/**
 * POST /api/merchant/products/import/csv
 * ?dryRun=true to check a file without writing anything.
 *
 * Multipart field name: `file`.
 */
router.post('/csv', upload.single('file'), async (req, res) => {
  try {
    const merchantId = req.user.id;
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file was uploaded. Send it as the "file" field.',
      });
    }

    const name = String(req.file.originalname || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      // Said plainly rather than failing on binary content. Reading .xlsx
      // needs a spreadsheet library this backend deliberately does not carry.
      return res.status(400).json({
        success: false,
        message: 'Excel files are not read directly. In Excel choose '
          + 'File → Save As → CSV UTF-8, then upload that.',
      });
    }

    const text = req.file.buffer.toString('utf8');
    const { headers, records } = parseCsvToObjects(text);

    if (!records.length) {
      return res.status(400).json({
        success: false,
        message: headers.length
          ? 'The file has a header row but no products under it.'
          : 'The file is empty.',
      });
    }
    if (records.length > MAX_ROWS) {
      return res.status(400).json({
        success: false,
        message: `That file has ${records.length} rows. Import at most ${MAX_ROWS} at a time.`,
      });
    }

    const dryRun = String(req.query.dryRun) === 'true';

    const issues = [];
    const candidates = [];
    for (const record of records) {
      const { line, product, issues: rowIssues } = readRow(record);
      if (rowIssues.length) {
        issues.push(...rowIssues);
      } else {
        candidates.push({ line, product });
      }
    }

    // Existing products are read once, not once per row. A 2000-row file
    // would otherwise be 2000 round trips before a single write.
    const names = candidates.map((c) => c.product.name);
    const codes = candidates.map((c) => c.product.code).filter(Boolean);
    const existing = await Product.find({
      merchantId,
      $or: [{ name: { $in: names } }, ...(codes.length ? [{ code: { $in: codes } }] : [])],
    })
      .select('name code')
      .lean();

    const byName = new Set(existing.map((p) => p.name));
    const byCode = new Set(existing.map((p) => p.code).filter(Boolean));

    // A file that repeats a row would otherwise create the product twice, and
    // the duplicate check above cannot see rows from the same upload.
    const seenNames = new Set();
    const seenCodes = new Set();

    const toCreate = [];
    let skipped = 0;

    for (const { line, product } of candidates) {
      const duplicateCode = product.code && (byCode.has(product.code) || seenCodes.has(product.code));
      const duplicateName = byName.has(product.name) || seenNames.has(product.name);

      if (duplicateCode || duplicateName) {
        skipped++;
        issues.push({
          line,
          field: duplicateCode ? 'code' : 'name',
          // Which rule matched, so a merchant can tell a real duplicate from
          // two different products that happen to share a name.
          message: duplicateCode
            ? `Skipped — code "${product.code}" already exists.`
            : `Skipped — a product named "${product.name}" already exists.`,
        });
        continue;
      }

      seenNames.add(product.name);
      if (product.code) seenCodes.add(product.code);
      toCreate.push({ merchantId, isActive: true, ...product });
    }

    let created = [];
    if (!dryRun && toCreate.length) {
      // ordered:false so one bad document does not abandon the rest.
      created = await Product.insertMany(toCreate, { ordered: false });
    }

    const record = await ProductImport.create({
      merchantId,
      fileName: req.file.originalname || '',
      fileSize: req.file.size || 0,
      rowsRead: records.length,
      created: dryRun ? 0 : created.length,
      updated: 0,
      skipped,
      failed: records.length - candidates.length,
      dryRun,
      issues: issues.slice(0, MAX_REPORTED_ISSUES),
      issuesTruncated: issues.length > MAX_REPORTED_ISSUES,
      createdProductIds: created.map((p) => p._id),
    });

    res.json({
      success: true,
      message: dryRun
        ? `Checked ${records.length} row(s). Nothing was saved.`
        : `Imported ${created.length} product(s).`,
      data: {
        importId: record._id,
        dryRun,
        rowsRead: records.length,
        // What would happen, when this was a check rather than a write.
        wouldCreate: toCreate.length,
        created: dryRun ? 0 : created.length,
        skipped,
        failed: records.length - candidates.length,
        issues: issues.slice(0, MAX_REPORTED_ISSUES),
        issuesTruncated: issues.length > MAX_REPORTED_ISSUES,
        totalIssues: issues.length,
        headers,
      },
    });
  } catch (error) {
    if (error && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `That file is too large. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/merchant/products/import/template
 *
 * A CSV rather than a spreadsheet: Excel opens it directly, and it is the
 * format that comes back.
 */
router.get('/template', (req, res) => {
  const rows = [
    COLUMNS.map((c) => c.label),
    ['Espresso', 'Drinks', '4.500', '1.800', '', '50', '10', '0', 'ESP-01',
      'Double shot', ''],
    ['Croissant', 'Bakery', '3.000', '1.200', '2.500', '30', '5', '0', 'CRS-01',
      'Butter croissant', ''],
  ];

  // A byte-order mark, so Excel opens Arabic product names as UTF-8 instead
  // of mojibake — which is the first thing a merchant would see.
  const csv = '﻿' + toCsvRows(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    'attachment; filename="vips-product-import-template.csv"');
  res.send(csv);
});

/** GET /api/merchant/products/import/history */
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const items = await ProductImport.find({ merchantId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      message: 'Import history',
      data: {
        items: items.map((i) => ({
          ...i,
          // The count is what a list row shows; the rows themselves are only
          // needed when one is opened.
          issueCount: (i.issues || []).length,
        })),
        total: items.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/merchant/products/import/history/:id */
router.get('/history/:id', async (req, res) => {
  try {
    const record = await ProductImport.findOne({
      _id: req.params.id,
      // Scoped to the caller: an import id from another merchant must not
      // read back their product names and file name.
      merchantId: req.user.id,
    }).lean();
    if (!record) {
      return res.status(404).json({ success: false, message: 'Import not found.' });
    }
    res.json({ success: true, message: 'Import', data: { import: record } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
