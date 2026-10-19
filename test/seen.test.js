const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// A tiny in-memory sheet: getDataRange().getValues(), appendRow and deleteRow, like Apps Script.
function fakeSheet(headers, rows) {
  const values = [headers].concat(rows || []);
  return {
    values,
    getDataRange: () => ({ getValues: () => values.map(r => r.slice()) }),
    appendRow: r => values.push(r),
    deleteRow: i => values.splice(i - 1, 1)
  };
}

function load(household, seen) {
  const ctx = {
    module: { exports: {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  const sheets = {
    Household: fakeSheet(['email', 'name'], household),
    Seen: fakeSheet(['movie', 'title', 'email', 'person', 'at'], seen)
  };
  ctx.sheet_ = name => sheets[name];
  ctx.getLibrary_ = user => ctx.personalData_(user);
  return { ctx, sheets };
}

const steffen = { email: 's@example.com', name: 'Steffen' };

test('each user only gets their own household and marks', () => {
  const { ctx } = load(
    [['s@example.com', 'Mia'], ['m@example.com', 'Paul']],
    [['movie:603', 'The Matrix', 's@example.com', 'Mia', ''], ['movie:603', 'The Matrix', 'm@example.com', 'Paul', '']]
  );
  const mine = JSON.parse(JSON.stringify(ctx.personalData_(steffen)));
  assert.deepStrictEqual(mine, { household: ['Mia'], seen: { 'movie:603': ['Mia'] } });
});

test('marking seen adds one row, and unmarking removes it', () => {
  const { ctx, sheets } = load([['s@example.com', 'Mia']]);
  ctx.markSeen('movie:603', 'The Matrix', 'Mia', true, steffen);
  ctx.markSeen('movie:603', 'The Matrix', 'Mia', true, steffen);
  ctx.markSeen('movie:603', 'The Matrix', 'Steffen', true, steffen);
  assert.strictEqual(sheets.Seen.values.length, 3);
  const after = ctx.markSeen('movie:603', 'The Matrix', 'Mia', false, steffen);
  assert.deepStrictEqual(Array.from(after.seen['movie:603']), ['Steffen']);
});

test('people outside the household and odd movie keys are refused', () => {
  const { ctx, sheets } = load([['m@example.com', 'Paul']]);
  assert.throws(() => ctx.markSeen('movie:603', 'The Matrix', 'Paul', true, steffen), /not in your household/);
  assert.throws(() => ctx.markSeen('=HYPERLINK()', 'x', 'Steffen', true, steffen), /Unknown movie/);
  assert.strictEqual(sheets.Seen.values.length, 1);
});

test('setting the household replaces only this user\'s names', () => {
  const { ctx, sheets } = load([['s@example.com', 'Mia'], ['m@example.com', 'Paul'], ['s@example.com', 'Ben']]);
  ctx.setHousehold([' Mia ', 'Lena', 'Steffen', '', 'Lena'], steffen);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sheets.Household.values.slice(1))), [['m@example.com', 'Paul'], ['s@example.com', 'Mia'], ['s@example.com', 'Lena']]);
});

test('household names are cleaned and capped', () => {
  const { ctx } = load();
  assert.deepStrictEqual(Array.from(ctx.cleanHousehold(['  Anna   Lena ', 'x'.repeat(60)], 'Steffen')), ['Anna Lena', 'x'.repeat(40)]);
  assert.throws(() => ctx.cleanHousehold('Mia', 'Steffen'), /Bad household/);
  assert.throws(() => ctx.cleanHousehold(Array.from({ length: 21 }, (_, i) => 'k' + i), 'Steffen'), /at most 20/);
});
