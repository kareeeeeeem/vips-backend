// Run against a fresh local database and a dedicated API process. Never loads
// production credentials or writes test fixtures to the developer's database.
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const database = `vips_qa_${Date.now()}_${randomBytes(4).toString('hex')}`;
const mongoOrigin = process.env.TEST_MONGO_ORIGIN || 'mongodb://127.0.0.1:27017';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+$/.test(mongoOrigin)) {
  throw new Error('TEST_MONGO_ORIGIN must be a loopback MongoDB host and port');
}
const port = Number(process.env.TEST_PORT || 3100);
const env = { ...process.env };
// dotenv.config() in the server/tests must not fill missing test values from
// .env. Also clear integration credentials inherited from the parent shell.
for (const name of ['.env', '.env.example']) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) {
    for (const key of Object.keys(dotenv.parse(fs.readFileSync(file)))) env[key] = '';
  }
}
Object.assign(env, {
  NODE_ENV: 'test', PORT: String(port),
  MONGODB_URI: `${mongoOrigin}/${database}`,
  JWT_SECRET: randomBytes(32).toString('hex'), JWT_EXPIRES_IN: '1h',
  BACKEND_URL: `http://127.0.0.1:${port}`,
  TEST_URL: `http://127.0.0.1:${port}/api`,
  TEST_INSTANCE_ID: randomBytes(16).toString('hex'),
  TEST_ISOLATED: '1',
  // A key without an implemented provider must never unlock simulated debits.
  TELECOM_RECHARGE_API_KEY: 'test-unwired-provider',
  UTILITY_BILLS_API_KEY: 'test-unwired-provider',
});

let server;
let child;
let serverLog = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  server = spawn(process.execPath, ['index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = data => { serverLog = (serverLog + data).slice(-24000); };
  server.stdout.on('data', append);
  server.stderr.on('data', append);
  let ready = false;
  // Initial fixture seeding can exceed 30s while Xcode is building in parallel.
  for (let attempt = 0; attempt < 480; attempt++) {
    if (server.exitCode !== null) throw new Error(`API exited (${server.exitCode})`);
    try {
      const response = await fetch(`${env.TEST_URL}/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (health.db?.readyState === 1 && health.build?.testInstanceId === env.TEST_INSTANCE_ID) {
        ready = true;
        break;
      }
    } catch (_) { /* Server is still starting. */ }
    await delay(250);
  }
  if (!ready) throw new Error('Isolated API did not become ready');
  console.log(`Isolated API: ${env.TEST_URL}; temporary database: ${database}`);
  if (process.argv.includes('--ui')) {
    const seed = require('./seed-ui');
    await seed(env);
    console.log('UI sandbox ready. Stop this process to remove its temporary database.');
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    return;
  }
  child = spawn(process.execPath, ['tests/integration.test.js'], { cwd: root, env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  }
  if (process.exitCode) console.error(serverLog);
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    console.log(`Removed temporary database ${database}`);
  }
});
