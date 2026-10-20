const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HEADERS = ['id', 'disc', 'title', 'by', 'note', 'at', 'status', 'closed_at', 'closed_by'];

// A tiny in-memory sheet: getDataRange().getValues(), appendRow and getRange().setValues(), like Apps Script.
function fakeSheet(headers, rows) {
  const values = [headers].concat(rows || []);
  return {
    values,
    getDataRange: () => ({ getValues: () => values.map(r => r.slice()) }),
    appendRow: r => values.push(r),
    getRange: (row, col) => ({ setValues: v => v[0].forEach((x, i) => { values[row - 1][col - 1 + i] = x; }) })
  };
}

// Heat is Steffen's and currently at Matthias; Alien is at its owner Anna.
function load(requests) {
  const holders = { 'd-0001': 'Matthias', 'd-0002': 'Anna' };
  const ctx = {
    module: { exports: {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  const sheets = { Requests: fakeSheet(HEADERS, requests), Loans: fakeSheet(['id']) };
  ctx.readInventory_ = () => ({
    cols: { where: 6 },
    sheet: { getRange: () => ({ setValue: v => { holders['d-0001'] = v; } }) },
    rows: [
      { key: 'd-0001', rowIndex: 2, title: 'Heat', owner: 'Steffen', where: holders['d-0001'] },
      { key: 'd-0002', rowIndex: 3, title: 'Alien', owner: 'Anna', where: '' }
    ]
  });
  ctx.sheet_ = name => sheets[name];
  ctx.setWhereSeen_ = () => {};
  ctx.clearLibraryCache_ = () => {};
  ctx.getLibrary_ = () => 'fresh library';
  return { ctx, sheets };
}

const steffen = { email: 's@example.com', name: 'Steffen' };
const anna = { email: 'a@example.com', name: 'Anna' };
const matthias = { email: 'm@example.com', name: 'Matthias' };
const open = (id, disc, by) => [id, disc, 'Heat', by, '', new Date(), 'open', '', ''];
const statuses = sheets => sheets.Requests.values.slice(1).map(r => r[6]);

test('a request is added once, and not by whoever has the disc', () => {
  const { ctx, sheets } = load();
  ctx.requestDisc('d-0001', '  for   Saturday ', anna);
  ctx.requestDisc('d-0001', 'again', anna);
  ctx.requestDisc('d-0001', '', steffen);
  assert.throws(() => ctx.requestDisc('d-0001', '', matthias), /already have Heat/);
  const rows = sheets.Requests.values.slice(1);
  assert.deepStrictEqual(rows.map(r => [r[0], r[3], r[4], r[6]]), [['r-1', 'Anna', 'for Saturday', 'open'], ['r-2', 'Steffen', '', 'open']]);
});

test('lending the disc to the person who asked closes their request only', () => {
  const { ctx, sheets } = load([open('r-1', 'd-0001', 'Anna'), open('r-2', 'd-0001', 'Steffen')]);
  ctx.lendDisc('d-0001', 'Anna', 'Matthias', matthias);
  assert.deepStrictEqual(statuses(sheets), ['done', 'open']);
  assert.strictEqual(sheets.Requests.values[1][8], 'Matthias');
});

test('returning a disc closes the owner\'s request to get it back', () => {
  const { ctx, sheets } = load([open('r-1', 'd-0001', 'Steffen')]);
  ctx.returnDisc('d-0001', 'Matthias', matthias);
  assert.deepStrictEqual(statuses(sheets), ['done']);
});

test('only the person who asked can cancel, and only the holder can decline', () => {
  const { ctx, sheets } = load([open('r-1', 'd-0001', 'Anna'), open('r-2', 'd-0001', 'Steffen')]);
  assert.throws(() => ctx.closeRequest('r-1', 'cancel', steffen), /Only Anna can cancel/);
  assert.throws(() => ctx.closeRequest('r-1', 'decline', steffen), /Only Matthias, who has the disc/);
  assert.throws(() => ctx.closeRequest('r-1', 'delete', anna), /Unknown action/);
  assert.throws(() => ctx.closeRequest('r-9', 'cancel', anna), /not found/);
  ctx.closeRequest('r-1', 'cancel', anna);
  ctx.closeRequest('r-2', 'decline', matthias);
  assert.deepStrictEqual(statuses(sheets), ['cancelled', 'declined']);
});

test('the library lists open requests per disc, in the order they were made', () => {
  const { ctx } = load([open('r-1', 'd-0001', 'Anna'), ['r-2', 'd-0001', 'Heat', 'Paul', '', '', 'cancelled', '', ''],
    open('r-3', 'd-0001', 'Steffen'), open('r-4', 'd-0002', 'Anna')]);
  const empty = fakeSheet(['id']);
  const sheet = ctx.sheet_;
  ctx.sheet_ = name => name === 'Requests' ? sheet(name) : empty;
  ctx.readMetadata_ = () => ({});
  const discs = ctx.buildLibrary_().discs;
  assert.deepStrictEqual(discs[0].requests.map(r => r.by), ['Anna', 'Steffen']);
  // Anna asked for her own disc's return, and she has it now (a hand edit of "where?"), so it no longer shows.
  assert.strictEqual(discs[1].requests.length, 0);
});

test('notes are trimmed, capped and never run as formulas', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.cleanNote(null), '');
  assert.strictEqual(ctx.cleanNote('x'.repeat(300)).length, 200);
  assert.strictEqual(ctx.cleanNote('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.strictEqual(ctx.cleanNote('-1 day'), "'-1 day");
});
