const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeProperties } = require('./fakes');

// A tiny in-memory spreadsheet: each tab is an array of rows, row 1 holds the headers.
function fakeSheet(rows) {
  return {
    rows,
    getRange(r, c, n = 1, m = 1) {
      return {
        getValues: () => rows.slice(r - 1, r - 1 + n).map(row => Array.from({ length: m }, (_, j) => row[c - 1 + j] ?? '')),
        setValues: v => v.forEach((vals, i) => vals.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; })),
        setValue: x => { rows[r - 1][c - 1] = x; }
      };
    },
    getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    appendRow: r => rows.push(r.slice()),
    hideColumns() {},
    setFrozenRows() {}
  };
}

function load(tabs) {
  const sheets = {};
  for (const [name, rows] of Object.entries(tabs)) sheets[name] = fakeSheet(rows);
  const lock = { waitLock() {}, tryLock: () => true, releaseLock() {} };
  const ctx = {
    module: { exports: {} },
    PropertiesService: fakeProperties(),
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = fakeSheet([])) }) },
    LockService: { getScriptLock: () => lock, getDocumentLock: () => lock },
    CacheService: { getScriptCache: () => ({ remove() {}, removeAll() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  ctx.buildData_ = () => ({ items: [] });
  ctx.matchDisc_ = () => ['movie:1'];
  ctx.warmLibraryCache = () => {};
  return { ctx, sheets };
}

const INV = ['title', 'release date', 'disc type', 'type', 'notes', 'owner', 'where?', 'id'];
const META = ['id', 'title_seen', 'year_seen', 'tmdb_ids', 'manual', 'data_json', 'fetched_at', 'where_seen', 'error'];
const LOANS = ['id', 'title', 'from', 'to', 'at', 'by', 'note'];

test('a new disc does not reuse the key of a deleted one', () => {
  const { ctx, sheets } = load({
    Tabellenblatt1: [INV, ['Heat', '1995', '', 'Film', '', 'Steffen', 'Steffen', 'd-0001'], ['New Disc', '2020', '', 'Film', '', 'Steffen', 'Steffen', '']],
    Metadata: [META, ['d-0001'], ['d-0002']] // d-0002 was deleted from the inventory
  });
  ctx.ensureKeys();
  assert.strictEqual(sheets.Tabellenblatt1.rows[2][7], 'd-0003');
});

test('a "where?" edit in the sheet is logged once, even if refresh runs twice', () => {
  const { ctx, sheets } = load({
    Tabellenblatt1: [INV, ['Heat', '1995', '', 'Film', '', 'Steffen', 'Matthias', 'd-0001']],
    Metadata: [META, ['d-0001', 'Heat', 1995, 'movie:949', false, '{"items":[]}', '', 'Steffen', '']],
    Loans: [LOANS]
  });
  ctx.refreshMetadata();
  ctx.refreshMetadata();
  assert.strictEqual(sheets.Loans.rows.length, 2);
  assert.deepStrictEqual([...sheets.Loans.rows[1].slice(2, 4)], ['Steffen', 'Matthias']);
});

test('fetching TMDB data leaves where_seen alone', () => {
  const { ctx, sheets } = load({
    Tabellenblatt1: [INV, ['Heat', '1995', '', 'Film', '', 'Steffen', 'Steffen', 'd-0001']],
    Metadata: [META, ['d-0001', '', '', '', false, '', '', 'Steffen', '']],
    Loans: [LOANS]
  });
  const todo = ctx.syncWhere_();
  sheets.Metadata.rows[1][7] = 'Matthias'; // a lend lands while TMDB is being asked
  ctx.fetchMetadata_(todo);
  assert.strictEqual(sheets.Metadata.rows[1][7], 'Matthias');
  assert.strictEqual(sheets.Metadata.rows[1][3], 'movie:1');
});

test('a numeric title is not refetched on every run', () => {
  const { ctx } = load({});
  const meta = { title_seen: 1917, year_seen: 2019, data_json: JSON.stringify({ v: ctx.DATA_VERSION, items: [] }), manual: false };
  assert.strictEqual(ctx.isStale_(meta, { title: '1917', yearRaw: '2019' }), false);
  assert.strictEqual(ctx.isStale_(meta, { title: '1917 (4K)', yearRaw: '2019' }), true);
});

test('a run that starts while another is working leaves a note instead of queueing for the lock', () => {
  const { ctx } = load({});
  let synced = 0;
  ctx.syncWhere_ = () => { synced++; return []; };
  ctx.LockService = { getDocumentLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  ctx.refreshMetadata();
  assert.strictEqual(synced, 0);
  assert.strictEqual(ctx.PropertiesService.store.refreshAgain, '1');
});

test('the working run goes round again when a change came in meanwhile', () => {
  const { ctx } = load({});
  let synced = 0;
  ctx.syncWhere_ = () => {
    if (++synced === 1) ctx.PropertiesService.store.refreshAgain = '1'; // an edit lands during the first round
    return [];
  };
  ctx.refreshMetadata();
  assert.strictEqual(synced, 2);
});

test('a disc that gets its first movie data hands over its seen marks', () => {
  const { ctx } = load({
    Tabellenblatt1: [INV, ['Heat', '1995', '', 'Film', '', 'Steffen', 'Steffen', 'd-0001'], ['Heat', '1995', '', 'Film', '', 'Anna', 'Anna', 'd-0002']],
    Metadata: [META, ['d-0001', '', '', '', false, '', '', 'Steffen', ''],
      ['d-0002', 'Old', '1995', 'movie:5', false, JSON.stringify({ items: [{ kind: 'movie', tmdbId: 5 }] }), '', 'Anna', '']]
  });
  ctx.buildData_ = () => ({ v: ctx.DATA_VERSION, items: [{ kind: 'movie', tmdbId: 949 }] });
  const moves = JSON.parse(JSON.stringify(ctx.fetchMetadata_(ctx.syncWhere_())));
  // d-0002 already had movie data, so its marks are under a movie key already.
  assert.deepStrictEqual(moves, [{ from: 'disc:d-0001', to: ['movie:949'], keep: false }]);
});
