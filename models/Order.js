const mongoose = require('mongoose');

const deliveryAddressSchema = new mongoose.Schema({
  contact_person_name:   { type: String, default: '' },
  contact_person_number: { type: String, default: '' },
  address_type:          { type: String, default: 'home' },
  address:               { type: String, default: '' },
  longitude:             { type: String, default: '' },
  latitude:              { type: String, default: '' },
  road:                  { type: String, default: '' },
  house:                 { type: String, default: '' },
  floor:                 { type: String, default: '' },
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
  productId:         { type: mongoose.Schema.Types.Mixed },
  item_name:         { type: String, default: '' },
  item_description:  { type: String, default: '' },
  item_image_full_url: { type: String, default: '' },
  price:             { type: Number, default: 0 },
  quantity:          { type: Number, default: 1 },
  tax_amount:        { type: Number, default: 0 },
  discount_on_item:  { type: Number, default: 0 },
  discount_type:     { type: String, default: 'amount' },
  variant:           { type: String, default: '' },
  variation:         { type: Array, default: [] },
  add_ons:           { type: Array, default: [] },
  total_add_on_price:{ type: Number, default: 0 },
  item_campaign_id:  { type: Number, default: null },
});

const orderSchema = new mongoose.Schema(
  {
    // Sequential numeric ID for Flutter compatibility
    orderNumber: { type: Number, unique: true, sparse: true },

    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    items: [orderItemSchema],

    totalAmount:           { type: Number, required: true },
    couponDiscountAmount:  { type: Number, default: 0 },
    couponDiscountTitle:   { type: String, default: '' },
    storeDiscountAmount:   { type: Number, default: 0 },
    totalTaxAmount:        { type: Number, default: 0 },
    deliveryCharge:        { type: Number, default: 0 },
    additionalCharge:      { type: Number, default: 0 },

    deliveryAddress: { type: deliveryAddressSchema, default: () => ({}) },
    deliveryInstruction: { type: String, default: '' },

    status: {
      type: String,
      enum: [
        'pending', 'confirmed', 'processing', 'ready',
        'handover', 'picked_up', 'delivered',
        'canceled', 'cancelled', 'refund_requested', 'refunded',
      ],
      default: 'pending',
    },
    orderType:     { type: String, enum: ['delivery', 'takeaway', 'dine_in'], default: 'delivery' },
    orderNote:     { type: String, default: '' },
    paymentMethod: { type: String, enum: ['wallet', 'cash', 'card', 'online'], default: 'cash' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },

    otp:            { type: String, default: '' },
    processingTime: { type: Number, default: 30 },
    scheduleAt:     { type: Date, default: null },

    cancellationReason: { type: String, default: '' },
    rating:  { type: Number, default: 0 },
    review:  { type: String, default: '' },

    // Status timestamp tracking
    pendingAt:          { type: Date, default: null },
    confirmedAt:        { type: Date, default: null },
    processingAt:       { type: Date, default: null },
    handoverAt:         { type: Date, default: null },
    pickedUpAt:         { type: Date, default: null },
    deliveredAt:        { type: Date, default: null },
    canceledAt:         { type: Date, default: null },
    refundRequestedAt:  { type: Date, default: null },
    refundedAt:         { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ merchantId: 1, status: 1 });
orderSchema.index({ merchantId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

// Auto-assign a sequential orderNumber on first save
orderSchema.pre('save', async function (next) {
  if (this.isNew && !this.orderNumber) {
    const last = await mongoose.model('Order').findOne().sort({ orderNumber: -1 }).select('orderNumber');
    this.orderNumber = last?.orderNumber ? last.orderNumber + 1 : 1001;

    // Record pending timestamp
    if (!this.pendingAt) this.pendingAt = new Date();
  }
  next();
});

// Helper: serialize one Order doc to the snake_case shape Flutter expects
orderSchema.methods.toMerchantJSON = function (merchantUser) {
  const o = this;
  const customer = o.userId && typeof o.userId === 'object' ? o.userId : null;

  const nameParts = customer?.fullName ? customer.fullName.split(' ') : ['', ''];
  const fName = nameParts[0] || '';
  const lName = nameParts.slice(1).join(' ') || '';

  return {
    id:                   o.orderNumber,
    order_amount:         o.totalAmount,
    coupon_discount_amount: o.couponDiscountAmount || 0,
    coupon_discount_title:  o.couponDiscountTitle  || null,
    payment_status:       o.paymentStatus,
    order_status:         o.status,
    total_tax_amount:     o.totalTaxAmount || 0,
    payment_method:       o.paymentMethod,
    order_note:           o.orderNote     || '',
    order_type:           o.orderType     || 'delivery',
    created_at:           o.createdAt?.toISOString()  || null,
    updated_at:           o.updatedAt?.toISOString()  || null,
    delivery_charge:      o.deliveryCharge || 0,
    schedule_at:          o.scheduleAt?.toISOString() || null,
    otp:                  o.otp           || '',
    pending:              o.pendingAt?.toISOString()         || null,
    accepted:             o.confirmedAt?.toISOString()       || null,
    confirmed:            o.confirmedAt?.toISOString()       || null,
    processing:           o.processingAt?.toISOString()      || null,
    handover:             o.handoverAt?.toISOString()        || null,
    picked_up:            o.pickedUpAt?.toISOString()        || null,
    delivered:            o.deliveredAt?.toISOString()       || null,
    canceled:             o.canceledAt?.toISOString()        || null,
    refund_requested:     o.refundRequestedAt?.toISOString() || null,
    refunded:             o.refundedAt?.toISOString()        || null,
    delivery_address:     o.deliveryAddress || null,
    scheduled:            o.scheduleAt ? 1 : 0,
    store_discount_amount: o.storeDiscountAmount || 0,
    store_name:           merchantUser?.storeName    || '',
    store_address:        merchantUser?.address      || '',
    store_phone:          merchantUser?.phone        || '',
    store_lat:            null,
    store_lng:            null,
    store_logo_full_url:  merchantUser?.logo         || '',
    item_campaign:        null,
    details_count:        o.items?.length || 0,
    order_attachment_full_url: [],
    module_type:          'restaurant',
    prescription_order:   false,
    customer: customer ? {
      id:             customer._id?.toString(),
      f_name:         fName,
      l_name:         lName,
      phone:          customer.phone || '',
      email:          customer.email || '',
      image_full_url: customer.profileImage || '',
      created_at:     customer.createdAt?.toISOString() || null,
      updated_at:     customer.updatedAt?.toISOString() || null,
    } : null,
    dm_tips:              0,
    processing_time:      o.processingTime || 30,
    delivery_man:         null,
    tax_status:           'excluded',
    cutlery:              false,
    unavailable_item_note: '',
    delivery_instruction: o.deliveryInstruction || '',
    order_proof_full_url: [],
    payments: [],
    additional_charge:    o.additionalCharge || 0,
    is_guest:             false,
    flash_admin_discount_amount: 0,
    flash_store_discount_amount: 0,
    extra_packaging_amount: 0,
    ref_bonus_amount:     0,
    bring_change_amount:  0,
  };
};

module.exports = mongoose.model('Order', orderSchema);
