const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeProperties } = require('./fakes');
const { searchResults, parseImdbId, checkWishRef } = require('../src/Code.gs');

const HEADERS = ['ref', 'title', 'year', 'poster', 'imdb_id', 'by', 'at'];

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
    getRange: (r, c, nr, nc) => ({ setValues: v => v.forEach((row, i) => { values[r - 1 + i] = row.slice(); }) })
  };
}

function load(rows) {
  const calls = [];
  const ctx = {
    module: { exports: {} },
    PropertiesService: fakeProperties(),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
  const sheet = fakeSheet(HEADERS, rows);
  ctx.sheet_ = () => sheet;
  ctx.tmdb_ = (p, params) => {
    calls.push(p);
    if (p === '/movie/603') return { title: 'The Matrix', release_date: '1999-03-31', poster_path: '/m.jpg', imdb_id: 'tt0133093' };
    if (p === '/tv/1396') return { name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: '/b.jpg', external_ids: { imdb_id: 'tt0903747' } };
    throw new Error('unexpected ' + p);
  };
  ctx.getLibrary_ = () => ctx.readWishlist_();
  return { ctx, sheet, calls };
}

const steffen = { email: 's@example.com', name: 'Steffen' };

test('search keeps only movies and series and trims each result', () => {
  const out = searchResults([
    { media_type: 'person', id: 1, name: 'Keanu Reeves' },
    { media_type: 'movie', id: 603, title: 'The Matrix', release_date: '1999-03-31', poster_path: '/m.jpg', overview: 'x' },
    { media_type: 'tv', id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }
  ]);
  assert.deepStrictEqual(out.map(r => r.ref), ['movie:603', 'tv:1396']);
  assert.deepStrictEqual([out[0].title, out[0].year, out[1].title, out[1].year, out[1].poster], ['The Matrix', '1999', 'Breaking Bad', '2008', '']);
});

test('IMDb ids and links are recognised', () => {
  assert.strictEqual(parseImdbId('https://www.imdb.com/title/tt0133093/?ref_=x'), 'tt0133093');
  assert.strictEqual(parseImdbId('tt0903747'), 'tt0903747');
  assert.strictEqual(parseImdbId('the matrix'), null);
});

test('only movie and tv refs are accepted', () => {
  assert.strictEqual(checkWishRef('tv:1396'), 'tv:1396');
  assert.throws(() => checkWishRef('disc:d-0001'), /Unknown title/);
  assert.throws(() => checkWishRef('movie:=1'), /Unknown title/);
});

test('adding stores TMDB details with who added it, once', () => {
  const { ctx, sheet } = load();
  ctx.addWish('movie:603', steffen);
  const list = ctx.addWish('movie:603', { email: 'm@example.com', name: 'Matthias' });
  assert.strictEqual(sheet.values.length, 2);
  assert.deepStrictEqual(Array.from(sheet.values[1].slice(0, 6)), ['movie:603', 'The Matrix', '1999', '/m.jpg', 'tt0133093', 'Steffen']);
  assert.strictEqual(list[0].by, 'Steffen');
});

test('series get their IMDb id from external ids, and the newest wish comes first', () => {
  const { ctx } = load();
  ctx.addWish('movie:603', steffen);
  const list = ctx.addWish('tv:1396', steffen);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(list.map(w => [w.ref, w.kind, w.imdbId]))), [['tv:1396', 'tv', 'tt0903747'], ['movie:603', 'movie', 'tt0133093']]);
});

test('anyone can remove a title', () => {
  const { ctx, sheet } = load([['movie:603', 'The Matrix', 1999, '', '', 'Steffen', ''], ['tv:1396', 'Breaking Bad', 2008, '', '', 'Anna', '']]);
  const list = ctx.removeWish('movie:603', { email: 'm@example.com', name: 'Matthias' });
  assert.deepStrictEqual(Array.from(list.map(w => w.ref)), ['tv:1396']);
  assert.strictEqual(sheet.values.length, 2);
});
