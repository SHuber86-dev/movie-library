const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeProperties } = require('./fakes');

// A tiny in-memory sheet with the parts of the Apps Script Range API the code uses.
function fakeSheet(rows) {
  const values = rows.map(r => r.slice());
  const width = () => Math.max(...values.map(r => r.length));
  return {
    values,
    getDataRange: () => ({ getValues: () => values.map(r => { const c = r.slice(); while (c.length < width()) c.push(''); return c; }) }),
    getLastRow: () => values.length,
    getLastColumn: width,
    appendRow: r => values.push(Array.from(r)),
    deleteRow: i => values.splice(i - 1, 1),
    deleteRows: (i, n) => values.splice(i - 1, n),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: v => v.forEach((row, i) => row.forEach((x, j) => { values[r - 1 + i][c - 1 + j] = x; }))
    })
  };
}

function load() {
  const inv = fakeSheet([
    ['title', 'release date', 'disc type', 'type', 'notes', 'owner', 'where?', 'id'],
    ['Heat', 1995, 'HD Blu Ray', 'Film', '', 'Matthias', 'Matthias', 'd-0007'],
    ['The Matrix', 1999, '4k Blu Ray', 'Film', '', 'Steffen', 'Steffen', 'd-0008'],
    ['Alien', 1979, 'HD Blu Ray', 'Film', '', 'Steffen', 'Anna', 'd-0009']
  ]);
  const tabs = {
    Loans: fakeSheet([['id', 'title', 'from', 'to', 'at', 'by', 'note']]),
    Requests: fakeSheet([
      ['id', 'disc', 'title', 'by', 'note', 'at', 'status', 'closed_at', 'closed_by'],
      ['r-1', 'd-0008', 'The Matrix', 'Anna', '', '', 'open', '', ''],
      ['r-2', 'd-0008', 'The Matrix', 'Tom', '', '', 'done', '', ''],
      ['r-3', 'd-0007', 'Heat', 'Anna', '', '', 'open', '', '']
    ])
  };
  const ctx = {
    module: { exports: {} },
    PropertiesService: fakeProperties(),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => inv }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  ctx.sheet_ = name => tabs[name];
  ctx.clearLibraryCache_ = () => {};
  ctx.getLibrary_ = () => 'fresh library';
  return { ctx, inv, tabs };
}

const steffen = { email: 's@example.com', name: 'Steffen' };

test('the owner removes a disc at home: its row goes, the loan history says so, open requests close', () => {
  const { ctx, inv, tabs } = load();
  assert.strictEqual(ctx.removeDisc('d-0008', 'Steffen', steffen), 'fresh library');
  assert.deepStrictEqual(inv.values.slice(1).map(r => r[7]), ['d-0007', 'd-0009']);
  const loan = tabs.Loans.values[1];
  assert.deepStrictEqual([loan[0], loan[1], loan[2], loan[3], loan[5], loan[6]], ['d-0008', 'The Matrix', 'Steffen', '', 'Steffen', 'removed from library']);
  assert.deepStrictEqual(tabs.Requests.values.slice(1).map(r => [r[0], r[6]]), [['r-1', 'removed'], ['r-2', 'done'], ['r-3', 'open']]);
  assert.strictEqual(tabs.Requests.values[1][8], 'Steffen');
});

test('nobody else can remove a disc, and a lent-out disc has to come back first', () => {
  const { ctx, inv, tabs } = load();
  assert.throws(() => ctx.removeDisc('d-0007', 'Matthias', steffen), /Only Matthias can remove/);
  assert.throws(() => ctx.removeDisc('d-0009', 'Anna', steffen), /Alien is at Anna\. Mark it returned/);
  assert.throws(() => ctx.removeDisc('d-0042', '', steffen), /Disc not found/);
  assert.strictEqual(inv.values.length, 4);
  assert.strictEqual(tabs.Loans.values.length, 1);
});

test('a disc that moved since the page loaded is not removed', () => {
  const { ctx, inv } = load();
  assert.throws(() => ctx.removeDisc('d-0008', 'Anna', steffen), /now at Steffen/);
  assert.strictEqual(inv.values.length, 4);
});
