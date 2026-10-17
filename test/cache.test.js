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
      for (const v of Object.values(vals)) if (v.length > 100000) throw new Error('value too large');
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
  ctx.writeLibraryCache_(data);
  assert.ok(+store['library:n'] > 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.readLibraryCache_())), data);
});

test('clearing the cache makes the next read miss', () => {
  const { ctx } = load();
  ctx.writeLibraryCache_({ people: [], discs: [] });
  ctx.clearLibraryCache_();
  assert.strictEqual(ctx.readLibraryCache_(), null);
});
