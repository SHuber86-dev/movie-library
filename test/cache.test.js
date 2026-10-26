const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const store = {};
  const cache = {
    get: k => (k in store ? store[k] : null),
    getAll: ks => Object.fromEntries(ks.filter(k => k in store).map(k => [k, store[k]])),
    putAll: vals => {
      for (const v of Object.values(vals)) if (Buffer.byteLength(v) > 100 * 1024) throw new Error('value too large');
      Object.assign(store, vals);
    },
    remove: k => { delete store[k]; }
  };
  const ctx = { module: { exports: {} }, CacheService: { getScriptCache: () => cache } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  return { ctx, store };
}

test('library cache round-trips data larger than one cache value', () => {
  const { ctx, store } = load();
  const data = { people: ['Steffen'], discs: Array.from({ length: 300 }, (_, i) => ({ key: 'd-' + i, overview: 'x'.repeat(1000) })) };
  ctx.writeLibraryCache_(data, 4);
  assert.ok(+store['library:n'] > 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.readLibraryCache_(4))), data);
});

test('clearing the cache makes the next read miss', () => {
  const { ctx } = load();
  ctx.writeLibraryCache_({ people: [], discs: [] }, 4);
  ctx.clearLibraryCache_();
  assert.strictEqual(ctx.readLibraryCache_(4), null);
});

test('a copy built before the library changed is never used', () => {
  const { ctx } = load();
  ctx.writeLibraryCache_({ people: ['old'], discs: [] }, 4); // built at libRev 4, written after a lend raised it to 5
  assert.strictEqual(ctx.readLibraryCache_(5), null);
});

test('titles with umlauts and dashes stay under the cache limit', () => {
  const { ctx, store } = load();
  const data = { discs: Array.from({ length: 300 }, (_, i) => ({ key: 'd-' + i, overview: 'Ärger – „Grüße“ '.repeat(60) })) };
  ctx.writeLibraryCache_(data, 1); // the fake cache throws on a value over 100 KB, as CacheService does
  assert.ok(+store['library:n'] > 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.readLibraryCache_(1))), data);
});
