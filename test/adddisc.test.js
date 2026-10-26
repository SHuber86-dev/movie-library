const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeProperties } = require('./fakes');
const { discRow } = require('../src/Code.gs');

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
    hideColumns() {},
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (values[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: v => v.forEach((row, i) => row.forEach((x, j) => { values[r - 1 + i][c - 1 + j] = x; })),
      setValue: x => { values[r - 1][c - 1] = x; }
    })
  };
}

function load(wishes) {
  const inv = fakeSheet([
    ['title', 'release date', 'disc type', 'type', 'notes', 'owner', 'where?', 'id'],
    ['Heat', 1995, 'HD Blu Ray', 'Film', '', 'Matthias', 'Matthias', 'd-0007']
  ]);
  const tabs = {
    Metadata: fakeSheet([['id', 'title_seen', 'year_seen', 'tmdb_ids', 'manual', 'data_json', 'fetched_at', 'where_seen', 'error'], ['d-0009']]),
    Wishlist: fakeSheet([['ref', 'title', 'year', 'poster', 'imdb_id', 'by', 'at']].concat(wishes || []))
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
  ctx.movieDetails_ = id => ({ kind: 'movie', tmdbId: id, title: 'The Matrix', year: '1999' });
  ctx.tvDetails_ = (id, season) => {
    if (season > 5) throw new Error('TMDB 404 for /tv/' + id + '/season/' + season);
    return { kind: 'tv', tmdbId: id, title: 'Breaking Bad' + (season ? ' – Staffel ' + season : ''), year: '2008' };
  };
  return { ctx, inv, tabs };
}

const steffen = { email: 's@example.com', name: 'Steffen' };

test('a new film is a row owned by and at the person adding it, with its metadata ready', () => {
  const { ctx, inv, tabs } = load();
  assert.strictEqual(ctx.addDisc({ ref: 'movie:603', formats: ['4k Blu Ray', 'HD Blu Ray'], notes: 'Steelbook' }, steffen), 'fresh library');
  // Formats in the sheet's usual order; the key skips d-0009, which Metadata still remembers from a deleted row.
  assert.deepStrictEqual(inv.values[2], ['The Matrix', '1999', 'HD Blu Ray, 4k Blu Ray', 'Film', 'Steelbook', 'Steffen', 'Steffen', 'd-0010']);
  const meta = tabs.Metadata.values[2];
  assert.deepStrictEqual([meta[0], meta[1], meta[3], meta[4], meta[7]], ['d-0010', 'The Matrix', 'movie:603', true, 'Steffen']);
  assert.strictEqual(JSON.parse(meta[5]).items[0].tmdbId, 603);
});

test('a series season gets the sheet title style, and a series without one is a box set', () => {
  const { ctx, inv, tabs } = load();
  ctx.addDisc({ ref: 'tv:1396', formats: ['HD Blu Ray'], season: '2' }, steffen);
  ctx.addDisc({ ref: 'tv:1396', formats: ['HD Blu Ray'] }, steffen);
  assert.deepStrictEqual(inv.values.slice(2).map(r => [r[0], r[3]]), [['Breaking Bad – Season 2', 'TV season'], ['Breaking Bad', 'TV series box set']]);
  assert.deepStrictEqual(tabs.Metadata.values.slice(2).map(r => r[3]), ['tv:1396:2', 'tv:1396']);
});

test('a season TMDB does not know is refused before anything is written', () => {
  const { ctx, inv } = load();
  assert.throws(() => ctx.addDisc({ ref: 'tv:1396', formats: ['HD Blu Ray'], season: 9 }, steffen), /no season 9/);
  assert.strictEqual(inv.values.length, 2);
});

test('adding can take the title off the wishlist', () => {
  const wishes = [['movie:603', 'The Matrix', 1999, '', '', 'Anna', ''], ['tv:1396', 'Breaking Bad', 2008, '', '', 'Anna', '']];
  const kept = load(wishes.map(w => w.slice()));
  kept.ctx.addDisc({ ref: 'movie:603', formats: ['HD Blu Ray'] }, steffen);
  assert.strictEqual(kept.tabs.Wishlist.values.length, 3);
  const removed = load(wishes.map(w => w.slice()));
  removed.ctx.addDisc({ ref: 'movie:603', formats: ['HD Blu Ray'], unwish: true }, steffen);
  assert.deepStrictEqual(removed.tabs.Wishlist.values.slice(1).map(r => r[0]), ['tv:1396']);
});

test('the page cannot send unknown formats, seasons for films, or formulas', () => {
  assert.throws(() => discRow({ ref: 'movie:603', formats: ['VHS'] }), /disc format/);
  assert.throws(() => discRow({ ref: 'movie:603', formats: ['HD Blu Ray'], season: 1 }), /Unknown season/);
  assert.throws(() => discRow({ ref: 'tv:1396', formats: ['HD Blu Ray'], season: '1; x' }), /Unknown season/);
  assert.throws(() => discRow({ ref: 'disc:d-0001', formats: ['HD Blu Ray'] }), /Unknown title/);
  assert.strictEqual(discRow({ ref: 'movie:603', formats: ['HD Blu Ray'], notes: '=HYPERLINK("x")' }).notes, '\'=HYPERLINK("x")');
});
