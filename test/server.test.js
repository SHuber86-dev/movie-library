const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const writes = [];
  const store = {};
  const ctx = {
    module: { exports: {} },
    CacheService: { getScriptCache: () => ({
      get: k => store[k] || null, put: (k, v) => { store[k] = v; }, getAll: () => ({}), putAll: v => Object.assign(store, v), remove: k => { delete store[k]; }
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  // Stub the sheet: one disc owned by Steffen, currently at Matthias.
  ctx.readInventory_ = () => ({
    cols: { where: 6 },
    sheet: { getRange: () => ({ setValue: v => writes.push(v) }) },
    rows: [{ key: 'd-0001', rowIndex: 2, title: 'Heat', owner: 'Steffen', where: 'Matthias' }]
  });
  ctx.sheet_ = () => ({ appendRow: r => writes.push(r) });
  ctx.setWhereSeen_ = () => {};
  ctx.getLibrary_ = () => 'fresh library';
  return { ctx, writes };
}

const steffen = { email: 's@example.com', name: 'Steffen' };

test('return is refused when the sheet no longer matches what the page showed', () => {
  const { ctx, writes } = load();
  assert.throws(() => ctx.returnDisc('d-0001', 'Steffen', steffen), /now at Matthias/);
  assert.strictEqual(writes.length, 0);
});

test('return writes when the page was up to date', () => {
  const { ctx, writes } = load();
  assert.strictEqual(ctx.returnDisc('d-0001', 'Matthias', steffen), 'fresh library');
  assert.strictEqual(writes[0], 'Steffen');
});

test('someone who neither owns nor holds the disc cannot lend it', () => {
  const { ctx, writes } = load();
  assert.throws(() => ctx.lendDisc('d-0001', 'Anna', 'Matthias', { email: 'a@example.com', name: 'Anna' }), /Only Steffen or Matthias/);
  assert.strictEqual(writes.length, 0);
});

function api(ctx, body, tokenInfo) {
  ctx.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => JSON.parse(t) }) };
  ctx.Utilities = { base64EncodeWebSafe: x => String(x), computeDigest: (a, t) => t, DigestAlgorithm: {} };
  ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => (tokenInfo ? 200 : 400), getContentText: () => JSON.stringify(tokenInfo) }) };
  ctx.accessList_ = () => ['s@example.com'];
  ctx.currentUser_ = email => ({ email, name: 'Steffen' });
  return ctx.doPost({ postData: { contents: JSON.stringify(body) } });
}

const info = email => ({ aud: '1037650089841-ob1jsnl3mdtgiicenup02ckc80tsmfsi.apps.googleusercontent.com', iss: 'accounts.google.com',
  email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) });

test('API asks to sign in without a valid token', () => {
  const { ctx } = load();
  assert.strictEqual(api(ctx, { action: 'library' }).code, 'signin');
  assert.strictEqual(api(ctx, { action: 'library', token: 'x' }, null).code, 'signin');
});

test('API refuses people without access to the sheet', () => {
  const { ctx } = load();
  assert.strictEqual(api(ctx, { action: 'library', token: 'x' }, info('stranger@example.com')).code, 'denied');
});

test('API returns the library and lends for people with access', () => {
  const { ctx, writes } = load();
  assert.deepStrictEqual(api(ctx, { action: 'library', token: 'x' }, info('S@example.com')), { ok: true, data: 'fresh library' });
  assert.strictEqual(api(ctx, { action: 'return', token: 'x', key: 'd-0001', seenWhere: 'Matthias' }, info('s@example.com')).ok, true);
  assert.strictEqual(writes[0], 'Steffen');
});
