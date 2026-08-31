const mongoose = require('mongoose');

/**
 * One bulk product import.
 *
 * Stored rather than derived: an import is a thing that happened once, and a
 * merchant who uploaded 300 products needs to be able to answer "what did
 * that file actually do" afterwards. A history endpoint returning an empty
 * array would be a screen that always looks broken.
 */
const productImportSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    fileName: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },

    /// Rows the file contained, after the header.
    rowsRead: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },

    /// A preview run writes nothing. Kept in the history anyway, so a
    /// merchant can see they checked the file before committing it.
    dryRun: { type: Boolean, default: false },

    /// Per-row problems, capped. A file with 10,000 bad rows should not put
    /// 10,000 messages in one document.
    ///
    /// Named `issues`, not `errors` — Mongoose reserves that path and warns
    /// that using it may break document validation.
    issues: {
      type: [
        {
          line: { type: Number },
          field: { type: String, default: '' },
          message: { type: String, default: '' },
          _id: false,
        },
      ],
      default: [],
    },
    issuesTruncated: { type: Boolean, default: false },

    /// The ids created, so an import can be traced to its products.
    createdProductIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      default: [],
    },
  },
  { timestamps: true }
);

productImportSchema.index({ merchantId: 1, createdAt: -1 });

module.exports = mongoose.model('ProductImport', productImportSchema);
