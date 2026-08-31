/**
 * Migrate stored permission extras to the expanded per-module model.
 *
 * The old model had three actions per module (read/write/delete). `write` was
 * split into the specific verbs, so any extra still saying `<module>.write`
 * now names a permission that does not exist — the API would reject it on the
 * next edit, and it grants nothing in the meantime.
 *
 * Only the per-admin extras need this. Role bundles live in code and were
 * rewritten with the model.
 *
 * Usage: node scripts/migrate-permissions.js [--dry]
 */

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Role = require('../models/Role');
const { ALL_PERMISSIONS, MODULE_ACTIONS } = require('../middleware/permissions');

/** What `<module>.write` used to cover, per module. */
function expandWrite(module) {
  const actions = MODULE_ACTIONS[module];
  if (!actions) return [];
  // Everything that is not a read and not a destructive delete: that is the
  // reach the old single `write` grant actually had.
  return Object.keys(actions)
    .filter((a) => a !== 'read' && a !== 'delete')
    .map((a) => `${module}.${a}`);
}

function migrate(permissions) {
  const out = new Set();
  const dropped = [];
  for (const permission of permissions || []) {
    if (permission === '*' || permission.endsWith('.*')) {
      out.add(permission);
      continue;
    }
    if (ALL_PERMISSIONS.includes(permission)) {
      out.add(permission);
      continue;
    }
    const [module, action] = permission.split('.');
    if (action === 'write') {
      for (const expanded of expandWrite(module)) out.add(expanded);
      continue;
    }
    // Anything else no longer maps to a real permission; recorded rather than
    // silently kept, so the run says what it could not translate.
    dropped.push(permission);
  }
  return { permissions: [...out], dropped };
}

(async () => {
  const dry = process.argv.includes('--dry');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}${dry ? ' (dry run)' : ''}`);

  let changed = 0;
  const admins = await User.find({ role: 'admin' }).select('fullName email permissions');
  for (const admin of admins) {
    const before = admin.permissions || [];
    if (before.length === 0) continue;
    const { permissions, dropped } = migrate(before);
    const same =
      permissions.length === before.length && permissions.every((p) => before.includes(p));
    if (same) continue;

    console.log(`  ${admin.email}`);
    console.log(`    ${JSON.stringify(before)} -> ${JSON.stringify(permissions)}`);
    if (dropped.length) console.log(`    dropped (no longer exist): ${dropped.join(', ')}`);
    if (!dry) {
      admin.permissions = permissions;
      await admin.save({ validateBeforeSave: false });
    }
    changed++;
  }

  let rolesChanged = 0;
  for (const role of await Role.find({})) {
    const before = role.permissions || [];
    const { permissions, dropped } = migrate(before);
    const same =
      permissions.length === before.length && permissions.every((p) => before.includes(p));
    if (same) continue;
    console.log(`  role "${role.name}": ${JSON.stringify(before)} -> ${JSON.stringify(permissions)}`);
    if (dropped.length) console.log(`    dropped: ${dropped.join(', ')}`);
    if (!dry) {
      role.permissions = permissions;
      await role.save();
    }
    rolesChanged++;
  }

  console.log(`${dry ? 'Would update' : 'Updated'} ${changed} admin(s) and ${rolesChanged} role(s).`);
  await mongoose.disconnect();
})();
