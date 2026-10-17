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
      get: k => store[k] || null, getAll: () => ({}), putAll: v => Object.assign(store, v), remove: k => { delete store[k]; }
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
  ctx.currentUser_ = () => ({ email: 's@example.com', name: 'Steffen' });
  ctx.sheet_ = () => ({ appendRow: r => writes.push(r) });
  ctx.setWhereSeen_ = () => {};
  ctx.getLibrary = () => 'fresh library';
  return { ctx, writes };
}

test('return is refused when the sheet no longer matches what the page showed', () => {
  const { ctx, writes } = load();
  assert.throws(() => ctx.returnDisc('d-0001', 'Steffen'), /now at Matthias/);
  assert.strictEqual(writes.length, 0);
});

test('return writes when the page was up to date', () => {
  const { ctx, writes } = load();
  assert.strictEqual(ctx.returnDisc('d-0001', 'Matthias'), 'fresh library');
  assert.strictEqual(writes[0], 'Steffen');
});

test('embedded JSON cannot close the script tag', () => {
  const { ctx } = load();
  const out = ctx.embedJson_({ notes: '</script><b>' });
  assert.ok(!out.includes('</script>'));
  assert.deepStrictEqual(JSON.parse(out), { notes: '</script><b>' });
});
