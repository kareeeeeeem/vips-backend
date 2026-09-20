const mongoose = require('mongoose');
const Product = require('../models/Product');
const Deal = require('../models/Deal');
const User = require('../models/User');
const coupons = require('./coupons');
const { roundTnd, pointsToTnd, POINTS_PER_TND } = require('../config/economics');

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function quoteCheckout(body, userId) {
  const { items } = body;
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    invalid('An order must contain between 1 and 100 items');
  }
  const orderType = body.orderType || 'delivery';
  if (!['delivery', 'takeaway', 'dine_in'].includes(orderType)) invalid('Invalid order type');
  const paymentMethod = body.paymentMethod || 'cash';
  if (!['cash', 'wallet', 'paymee', 'paypal', 'bank_transfer', 'partner_cash'].includes(paymentMethod)) invalid('Select a supported payment method');
  if (['paymee', 'paypal'].includes(paymentMethod) && !require(`./${paymentMethod}`).getInitStatus().configured) {
    invalid('This payment provider is currently unavailable', 503);
  }
  const tipAmount = Number(body.tipAmount ?? 0);
  const requestedPoints = Number(body.walletPointsRedeemed ?? 0);
  if (!Number.isFinite(tipAmount) || tipAmount < 0 || tipAmount > 1000) invalid('Invalid tip amount');
  if (!Number.isSafeInteger(requestedPoints) || requestedPoints < 0) invalid('Points must be a non-negative whole number');
  const normalizedItems = [];
  const owners = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') invalid('Invalid order item');
    const id = item.productId || item.id;
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) invalid('Quantity must be a whole number between 1 and 999');
    if (!mongoose.isValidObjectId(id)) invalid('Item is no longer available');
    const product = await Product.findById(id).lean();
    const itemDoc = product || await Deal.findById(id).lean();
    if (!itemDoc || !itemDoc.isActive || (product && !product.inStock) ||
        (!product && itemDoc.endTime && new Date(itemDoc.endTime) <= new Date())) {
      invalid('Item is no longer available');
    }
    owners.add(itemDoc.merchantId?.toString() || '');
    const price = product
      ? (product.discountPrice > 0 ? product.discountPrice : product.price)
      : itemDoc.currentPrice;
    if (!Number.isFinite(price) || price < 0) invalid('Item price is unavailable');
    normalizedItems.push({
      productId: id, item_name: product ? product.name : itemDoc.title,
      item_description: itemDoc.description || '',
      item_image_full_url: itemDoc.image || '',
      price: roundTnd(price), quantity,
      tax_amount: product?.taxMethod === 'Exclusive'
        ? roundTnd(price * Math.max(0, product.vat || 0) / 100) : 0,
      discount_on_item: 0,
    });
  }
  if (owners.size > 1) invalid('Please place a separate order for each store');
  const merchantId = [...owners][0] || null;
  if (body.merchantId && String(body.merchantId) !== merchantId) invalid('The selected store does not own these items');
  if (merchantId && !await User.exists({ _id: merchantId, role: 'merchant', isActive: { $ne: false } })) {
    invalid('This store is currently unavailable');
  }
  const subtotal = roundTnd(normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0));
  const deliveryCharge = orderType === 'delivery' ? 6 : 0;
  let discount = 0;
  let appliedCoupon = null;
  if (body.couponCode) {
    const resolved = await coupons.resolve({ code: body.couponCode, userId, merchantId, subtotal });
    discount = resolved.discountTnd;
    appliedCoupon = resolved.coupon;
  }
  const undiscountedTax = normalizedItems.reduce((sum, item) => sum + item.tax_amount * item.quantity, 0);
  const taxAmount = roundTnd(undiscountedTax * (subtotal > 0 ? Math.max(0, subtotal - discount) / subtotal : 0));
  const beforePoints = roundTnd(Math.max(0, subtotal - discount) + taxAmount + deliveryCharge + tipAmount);
  const user = await User.findById(userId).select('walletPoints walletBalance').lean();
  const pointsUsed = Math.min(requestedPoints, Math.max(0, Math.floor(user.walletPoints || 0)),
    Math.floor(roundTnd(beforePoints) * POINTS_PER_TND + 1e-7));
  const walletDiscountAmount = pointsToTnd(pointsUsed);
  const totalAmount = roundTnd(Math.max(0, beforePoints - walletDiscountAmount));
  return {
    normalizedItems, merchantId, orderType, paymentMethod, subtotal,
    deliveryCharge, tipAmount: roundTnd(tipAmount), taxAmount, discount, appliedCoupon,
    pointsUsed, walletDiscountAmount, totalAmount,
  };
}

function publicQuote(quote) {
  const { subtotal, deliveryCharge, tipAmount, taxAmount, discount, pointsUsed, walletDiscountAmount, totalAmount, merchantId } = quote;
  return { subtotal, deliveryCharge, tipAmount, taxAmount, discount, pointsUsed, walletDiscountAmount, totalAmount, merchantId, currency: 'TND' };
}

module.exports = { quoteCheckout, publicQuote };
