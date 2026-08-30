const StockMovement = require('../models/StockMovement');

/**
 * Append one row to the stock ledger.
 *
 * Deliberately never throws: a failure to write the audit trail must not fail
 * the stock change the operator actually asked for. A dropped ledger row is
 * logged loudly instead, so it shows up in the server output rather than
 * silently rolling back a legitimate update.
 */
async function recordMovement({
  stock,
  type,
  quantity,
  balanceBefore,
  balanceAfter,
  reason = '',
  reference = '',
  performedBy = null,
  performedByRole = '',
}) {
  try {
    await StockMovement.create({
      stockId: stock._id,
      merchantId: stock.merchantId,
      itemName: stock.name || '',
      category: stock.category || '',
      location: stock.location || 'Main',
      type,
      quantity: Math.abs(Number(quantity) || 0),
      balanceBefore: Number(balanceBefore) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      unitPrice: Number(stock.unitPrice) || 0,
      reason,
      reference,
      performedBy,
      performedByRole,
    });
  } catch (error) {
    console.error('[stockLedger] failed to record movement:', error.message);
  }
}

/**
 * Work out what a change from `before` to `after` should be called.
 * 'in'/'out' describe a delta; 'adjustment' is reserved for a correction that
 * was stated as an absolute figure rather than a movement.
 */
function movementTypeForDelta(before, after) {
  if (after > before) return 'in';
  if (after < before) return 'out';
  return 'adjustment';
}

module.exports = { recordMovement, movementTypeForDelta };
