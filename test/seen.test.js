const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeProperties } = require('./fakes');

// A tiny in-memory sheet: getDataRange().getValues(), appendRow and deleteRow, like Apps Script.
function fakeSheet(headers, rows) {
  const values = [headers].concat(rows || []);
  return {
    values,
    getDataRange: () => ({ getValues: () => values.map(r => r.slice()) }),
    appendRow: r => values.push(r),
    deleteRow: i => values.splice(i - 1, 1),
    deleteRows: (i, n) => values.splice(i - 1, n),
    getLastRow: () => values.length,
    getMaxRows: () => values.length, // a full grid, so every append has to grow it
    insertRowsAfter() {},
    getRange: (r, c, nr, nc) => ({ setValues: v => v.forEach((row, i) => { values[r - 1 + i] = row.slice(); }) })
  };
}

function load(household, seen) {
  const ctx = {
    module: { exports: {} },
    PropertiesService: fakeProperties(),
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

const tick = (movie, person, seen) => ({ movie, title: 'The Matrix', person, seen });

test('marking seen adds one row, and unmarking removes it', () => {
  const { ctx, sheets } = load([['s@example.com', 'Mia']]);
  ctx.markSeen([tick('movie:603', 'Mia', true)], steffen);
  ctx.markSeen([tick('movie:603', 'Mia', true)], steffen); // a batch sent again changes nothing
  ctx.markSeen([tick('movie:603', 'Steffen', true)], steffen);
  assert.strictEqual(sheets.Seen.values.length, 3);
  const after = ctx.markSeen([tick('movie:603', 'Mia', false)], steffen);
  assert.deepStrictEqual(Array.from(after.seen['movie:603']), ['Steffen']);
});

test('a batch of ticks across movies is saved in one call', () => {
  const { ctx, sheets } = load([['s@example.com', 'Mia']], [['movie:1', 'A', 's@example.com', 'Mia', ''], ['movie:2', 'B', 's@example.com', 'Mia', '']]);
  const after = ctx.markSeen([
    tick('movie:1', 'Mia', false), tick('movie:3', 'Mia', true), tick('movie:4', 'Steffen', true),
    tick('movie:2', 'Mia', false), tick('movie:5', 'Mia', true), tick('movie:5', 'Mia', false) // last change wins
  ], steffen);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(after.seen)), { 'movie:3': ['Mia'], 'movie:4': ['Steffen'] });
  assert.strictEqual(sheets.Seen.values.length, 3);
});

test('changes for people outside the household and odd movie keys are skipped', () => {
  const { ctx, sheets } = load([['m@example.com', 'Paul']]);
  ctx.markSeen([tick('movie:603', 'Paul', true), tick('=HYPERLINK()', 'Steffen', true), null, tick('movie:603', 'Steffen', true)], steffen);
  assert.deepStrictEqual(sheets.Seen.values.slice(1).map(r => r[3]), ['Steffen']);
  assert.throws(() => ctx.markSeen('movie:603', steffen), /Bad seen list/);
  assert.throws(() => ctx.markSeen(Array.from({ length: 201 }, () => tick('movie:1', 'Steffen', true)), steffen), /Bad seen list/);
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

test('a tick answers with only the marks and household, and a newer rev', () => {
  const { ctx } = load([['s@example.com', 'Mia']]);
  const before = ctx.revs_().rev;
  const after = JSON.parse(JSON.stringify(ctx.markSeen([tick('movie:603', 'Mia', true)], steffen, 'personal')));
  assert.deepStrictEqual(after, { rev: before + 1, household: ['Mia'], seen: { 'movie:603': ['Mia'] } });
});

test('a failed save still raises the rev, so pages don\'t keep a copy that may be half old', () => {
  const { ctx, sheets } = load([['s@example.com', 'Mia']]);
  sheets.Seen.appendRow = () => { throw new Error('sheet busy'); };
  sheets.Seen.getRange = () => ({ setValues() { throw new Error('sheet busy'); } });
  assert.throws(() => ctx.markSeen([tick('movie:603', 'Mia', true)], steffen), /sheet busy/);
  assert.strictEqual(ctx.revs_().rev, 1);
});

test('unticking neighbouring rows deletes them in one call', () => {
  const { ctx, sheets } = load([['s@example.com', 'Mia']], [
    ['movie:1', 'A', 's@example.com', 'Mia', ''], ['movie:2', 'B', 's@example.com', 'Mia', ''],
    ['movie:3', 'C', 'm@example.com', 'Paul', ''], ['movie:4', 'D', 's@example.com', 'Mia', '']
  ]);
  const calls = [];
  const del = sheets.Seen.deleteRows;
  sheets.Seen.deleteRows = (i, n) => { calls.push([i, n]); del(i, n); };
  ctx.markSeen([tick('movie:1', 'Mia', false), tick('movie:2', 'Mia', false), tick('movie:4', 'Mia', false)], steffen);
  assert.deepStrictEqual(calls, [[5, 1], [2, 2]]);
  assert.deepStrictEqual(sheets.Seen.values.slice(1).map(r => r[0]), ['movie:3']);
});

test('marks made before a disc had movie data move to the movie', () => {
  const { ctx, sheets } = load([], [
    ['disc:d-0012', 'Heat', 's@example.com', 'Mia', ''], ['movie:949', 'Heat', 's@example.com', 'Steffen', ''],
    ['disc:d-0012', 'Heat', 's@example.com', 'Steffen', ''], ['disc:d-0013', 'Lost – Season 1', 's@example.com', 'Mia', '']
  ]);
  ctx.moveSeen_([{ from: 'disc:d-0012', to: ['movie:949'], keep: false }]);
  assert.deepStrictEqual(sheets.Seen.values.slice(1).map(r => r[0] + ' ' + r[3]).sort(),
    ['disc:d-0013 Mia', 'movie:949 Mia', 'movie:949 Steffen']);
  assert.deepStrictEqual(Array.from(ctx.movieSeenKeys({ items: [{ kind: 'movie', tmdbId: 1 }, { kind: 'tv', tmdbId: 2 }] })), ['movie:1']);
  assert.strictEqual(ctx.hasSeries({ items: [{ kind: 'movie', tmdbId: 1 }] }), false);
});
