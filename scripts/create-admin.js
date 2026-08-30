/**
 * Create (or repair) an admin account for the VIPs admin console.
 *
 * The very first admin deliberately cannot be created over HTTP — an
 * unauthenticated "make me an admin" endpoint is exactly the hole that would
 * make the whole console pointless. So it is minted here, from a shell with
 * database access. Once one admin exists, further admins are created from
 * inside the console via POST /api/admin/settings/admins.
 *
 * Usage:
 *   node scripts/create-admin.js --email=ops@vips.tn --password='...' \
 *        --name='Ops Team' --phone=+21600000000
 *
 * Re-running with an existing email promotes that account to admin and
 * resets its password, which is also the recovery path for a lost login.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');

const parseArgs = () => {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
};

(async () => {
  const args = parseArgs();
  const email    = (args.email || '').toLowerCase().trim();
  const password = args.password || '';
  const fullName = args.name || 'VIPs Administrator';
  const phone    = (args.phone || '').trim();

  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js --email=<email> --password=<password> [--name=<name>] [--phone=<phone>]');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Password must be at least 6 characters.');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — check the backend .env file.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);

  try {
    let user = await User.findOne({ email });

    if (user) {
      // Assigning through the document (not updateOne) so the pre-save hook
      // hashes the password — a raw update would store it in the clear.
      user.role = 'admin';
      user.password = password;
      user.isActive = true;
      user.isVerified = true;
      if (phone) user.phone = phone;
      await user.save();
      console.log(`Promoted existing account to admin: ${user.email} (${user._id})`);
    } else {
      if (!phone) {
        console.error('A new account needs --phone as well (User.phone is required and unique).');
        process.exit(1);
      }
      user = await User.create({
        fullName,
        email,
        phone,
        password,
        role: 'admin',
        isVerified: true,
      });
      console.log(`Created admin: ${user.email} (${user._id})`);
    }

    const total = await User.countDocuments({ role: 'admin' });
    console.log(`Admin accounts on this database: ${total}`);
  } catch (error) {
    console.error('Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
