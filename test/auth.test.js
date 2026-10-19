const test = require('node:test');
const assert = require('node:assert');
const { checkTokenInfo } = require('../src/Code.gs');

const CLIENT = 'client.apps.googleusercontent.com';
const NOW = 1_800_000_000_000;
const good = { aud: CLIENT, iss: 'https://accounts.google.com', email: 'Steffen@Example.com', email_verified: 'true', exp: String(NOW / 1000 + 600) };

test('a valid token gives the lowercased email', () => {
  assert.strictEqual(checkTokenInfo(good, CLIENT, NOW), 'steffen@example.com');
  assert.strictEqual(checkTokenInfo({ ...good, iss: 'accounts.google.com', email_verified: true }, CLIENT, NOW), 'steffen@example.com');
});

test('tokens for another app, from another issuer, unverified or expired are refused', () => {
  for (const bad of [
    { ...good, aud: 'other.apps.googleusercontent.com' },
    { ...good, iss: 'https://evil.example.com' },
    { ...good, email_verified: 'false' },
    { ...good, email: '' },
    { ...good, exp: String(NOW / 1000 - 1) }
  ]) {
    assert.throws(() => checkTokenInfo(bad, CLIENT, NOW), err => err.code === 'signin');
  }
  assert.throws(() => checkTokenInfo(null, CLIENT, NOW), err => err.code === 'signin');
});
