const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Deal = require('./models/Deal');
const Outing = require('./models/Outing');
const bcrypt = require('bcryptjs');

dotenv.config();

const hotDeals = [
  { title: 'Eastern El', description: 'Pizza 4 season', image: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 120, originalPrice: 240, discount: 25, rating: 4.5, category: 'entertainment' },
  { title: 'Spa & Wellness', description: 'Relaxing spa treatments', image: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 299, originalPrice: 450, discount: 35, rating: 4.9, category: 'wellness' },
  { title: 'Italian Restaurant', description: 'Authentic cuisine', image: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 180, originalPrice: 250, discount: 28, rating: 4.6, category: 'food' },
  { title: 'Dream Park', description: '29% off @Dream Park', image: 'https://images.unsplash.com/photo-1569973189506-82c9b96b8e30?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', currentPrice: 265, originalPrice: 375, discount: 29, rating: 4.8, category: 'entertainment' }
];

const endingSoonDeals = [
  { title: 'Mega Pizza Deal', description: 'Large Pizza + 2 Sides', image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', discount: 50, currentPrice: 150, originalPrice: 300, endTime: new Date(Date.now() + 12 * 60 * 60 * 1000), category: 'food' },
  { title: 'Sushi Combo', description: '24 Pieces Mixed', image: 'https://images.unsplash.com/photo-1579584425555-c3ce17fd4351?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', discount: 40, currentPrice: 180, originalPrice: 300, endTime: new Date(Date.now() + 8 * 60 * 60 * 1000), category: 'food' }
];

const outings = [
  { title: 'Mall Of Egypt Offers', subtitle: 'Shopping & Entertainment', image: 'https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', category: 'Shopping', location: 'New Cairo', type: 'mall' },
  { title: 'City Center Almaza', subtitle: 'Luxury Shopping', image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', category: 'Luxury', location: 'Heliopolis', type: 'mall' },
  { title: 'Walk of Cairo', subtitle: 'Outdoor Shopping Experience', image: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80', category: 'Outdoor', location: 'New Capital', type: 'outdoor' }
];

const merchants = [
  { fullName: 'Nestlé', email: 'merchant.nestle@test.com', phone: '0000000001', password: 'password123', role: 'merchant', storeName: 'Nestlé', storeCategory: 'Food', logo: 'https://logos-world.net/wp-content/uploads/2020/09/Nestle-Logo.png', brandColor: '0xFF991B1B', isTrending: false, discountPercentage: 15 },
  { fullName: 'Carrefour', email: 'merchant.carrefour@test.com', phone: '0000000002', password: 'password123', role: 'merchant', storeName: 'Carrefour', storeCategory: 'Shopping', logo: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTOdP7dYdtDVHm7eDiHCdZaLxRpvw3HQAcFBg&s', brandColor: '0xFF2563EB', isTrending: true, discountPercentage: 25 },
  { fullName: 'McDonald\'s', email: 'merchant.mcd@test.com', phone: '0000000003', password: 'password123', role: 'merchant', storeName: 'McDonald\'s', storeCategory: 'Food', logo: "https://d1csarkz8obe9u.cloudfront.net/posterpreviews/mcdonald's-logo-design-template-c03c253e9d3c73bacdf4d3499e6a0b72_screen.jpg?ts=1738336858", brandColor: '0xFFDC2626', isTrending: true, discountPercentage: 20 },
];

const seedDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('Clearing old data...');
    await Deal.deleteMany({});
    await Outing.deleteMany({});
    await User.deleteMany({ role: 'merchant' });

    console.log('Inserting Deals...');
    await Deal.insertMany([...hotDeals, ...endingSoonDeals]);

    console.log('Inserting Outings...');
    await Outing.insertMany(outings);

    console.log('Inserting Merchants...');
    for (const m of merchants) {
      await User.create(m);
    }

    console.log('🎉 Seeding Complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding Error:', error);
    process.exit(1);
  }
};

seedDB();
