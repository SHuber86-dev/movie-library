const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeProperties } = require('./fakes');
const { discRow, cleanSources, cleanLink, isDigital, visibleDiscs } = require('../src/Code.gs');

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

function load() {
  const inv = fakeSheet([
    ['title', 'release date', 'disc type', 'type', 'notes', 'owner', 'where?', 'id'],
    ['Heat', 1995, 'HD Blu Ray', 'Film', '', 'Matthias', 'Matthias', 'd-0007'],
    ['Alien', 1979, 'Digital', 'Film', '', 'Matthias', 'Matthias', 'd-0008']
  ]);
  const tabs = {
    Metadata: fakeSheet([['id', 'title_seen', 'year_seen', 'tmdb_ids', 'manual', 'data_json', 'fetched_at', 'where_seen', 'error']]),
    Wishlist: fakeSheet([['ref', 'title', 'year', 'poster', 'imdb_id', 'by', 'at']]),
    Loans: fakeSheet([['id', 'title', 'from', 'to', 'at', 'by', 'note']]),
    Requests: fakeSheet([['id', 'disc', 'title', 'by', 'note', 'at', 'status', 'closed_at', 'closed_by']])
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
  ctx.setWhereSeen_ = () => {};
  ctx.movieDetails_ = id => ({ kind: 'movie', tmdbId: id, title: 'The Matrix', year: '1999' });
  return { ctx, inv, tabs };
}

const steffen = { email: 's@example.com', name: 'Steffen' };
const matthias = { email: 'm@example.com', name: 'Matthias' };

test('a digital title is a row with "Digital" as its disc type and its sources in a new source column', () => {
  const { ctx, inv } = load();
  ctx.addDisc({ ref: 'movie:603', digital: true, sources: ['Apple TV', 'Netflix'], other: 'Maxdome', formats: ['HD Blu Ray'] }, steffen);
  assert.strictEqual(inv.values[0][8], 'source');
  assert.deepStrictEqual(inv.values[3], ['The Matrix', '1999', 'Digital', 'Film', '', 'Steffen', 'Steffen', 'd-0009', 'Netflix, Apple TV, Maxdome']);
  // A second one reuses the column.
  ctx.addDisc({ ref: 'movie:603', digital: true, sources: ['Disney+'] }, steffen);
  assert.strictEqual(inv.values[0].length, 9);
  assert.strictEqual(inv.values[4][8], 'Disney+');
});

test('a disc added after the source column exists leaves it empty', () => {
  const { ctx, inv } = load();
  ctx.addDisc({ ref: 'movie:603', digital: true, sources: ['Netflix'] }, steffen);
  ctx.addDisc({ ref: 'movie:603', formats: ['HD Blu Ray'] }, steffen);
  assert.deepStrictEqual(inv.values[4].slice(2, 3).concat(inv.values[4].slice(8)), ['HD Blu Ray', '']);
});

test('sources: known ones in list order, an "Other" one typed in, at least one needed', () => {
  assert.deepStrictEqual(cleanSources(['Sky / WOW', 'Netflix', 'Hacked'], ' My, NAS '), ['Netflix', 'Sky / WOW', 'My NAS']);
  assert.deepStrictEqual(cleanSources(null, '=cmd'), ["'=cmd"]);
  assert.throws(() => discRow({ ref: 'movie:603', digital: true, sources: [] }), /at least one source/);
  assert.deepStrictEqual(discRow({ ref: 'tv:1396', digital: true, sources: ['Netflix'], season: 2 }).formats, ['Digital']);
});

test('a row typed into the sheet as "digital" counts as digital', () => {
  assert.strictEqual(isDigital(['digital']), true);
  assert.strictEqual(isDigital(['HD Blu Ray']), false);
});

test('only the owner gets their digital titles', () => {
  const discs = [{ key: 'a', owner: 'Matthias' }, { key: 'b', owner: 'Matthias', digital: true }, { key: 'c', owner: 'Steffen', digital: true }];
  assert.deepStrictEqual(visibleDiscs(discs, 'Steffen').map(d => d.key), ['a', 'c']);
  assert.deepStrictEqual(visibleDiscs(discs, 'Matthias').map(d => d.key), ['a', 'b']);
});

test('a digital title cannot be lent or requested, and others are told it does not exist', () => {
  const { ctx, inv, tabs } = load();
  assert.throws(() => ctx.lendDisc('d-0008', 'Steffen', 'Matthias', matthias), /digital and can't be lent/);
  assert.throws(() => ctx.requestDisc('d-0008', '', steffen), /Disc not found/);
  assert.throws(() => ctx.lendDisc('d-0008', 'Anna', 'Matthias', steffen), /Disc not found/);
  assert.throws(() => ctx.removeDisc('d-0008', 'Matthias', steffen), /Disc not found/);
  assert.strictEqual(tabs.Loans.values.length, 1);
  assert.strictEqual(tabs.Requests.values.length, 1);
  assert.strictEqual(ctx.removeDisc('d-0008', 'Matthias', matthias), 'fresh library');
  assert.strictEqual(inv.values.length, 2);
});

test('a digital title can carry a streaming link, in a link column added when first needed', () => {
  const { ctx, inv } = load();
  ctx.addDisc({ ref: 'movie:603', digital: true, sources: ['Netflix'], link: ' https://www.netflix.com/title/20557937 ' }, steffen);
  assert.deepStrictEqual(inv.values[0].slice(8), ['source', 'link']);
  assert.deepStrictEqual(inv.values[3].slice(8), ['Netflix', 'https://www.netflix.com/title/20557937']);
});

test('the owner sets and clears the link of their digital title; nobody else can, and discs have none', () => {
  const { ctx, inv } = load();
  ctx.setLink('d-0008', 'https://tv.apple.com/movie/alien', matthias);
  assert.strictEqual(inv.values[0][8], 'link');
  assert.strictEqual(inv.values[2][8], 'https://tv.apple.com/movie/alien');
  ctx.setLink('d-0008', '', matthias);
  assert.strictEqual(inv.values[2][8], '');
  assert.throws(() => ctx.setLink('d-0008', 'https://x.example/a', steffen), /not found/);
  assert.throws(() => ctx.setLink('d-0007', 'https://x.example/a', matthias), /not found/);
});

test('streaming links: empty or a web address, nothing else', () => {
  assert.strictEqual(cleanLink(''), '');
  assert.strictEqual(cleanLink(null), '');
  assert.strictEqual(cleanLink('https://www.primevideo.com/detail/0ABC'), 'https://www.primevideo.com/detail/0ABC');
  assert.throws(() => cleanLink('javascript:alert(1)'), /web address/);
  assert.throws(() => cleanLink('netflix.com/title/1'), /web address/);
  assert.throws(() => cleanLink('https://a.com/' + 'x'.repeat(600)), /web address/);
  assert.throws(() => discRow({ ref: 'movie:603', digital: true, sources: ['Netflix'], link: 'ftp://x.com' }), /web address/);
});

test('where to watch: the region page and every service, once each', () => {
  const { parseProviders } = require('../src/Code.gs');
  const json = { results: { DE: {
    link: 'https://www.themoviedb.org/movie/603-the-matrix/watch?locale=DE',
    flatrate: [{ provider_name: 'Netflix' }],
    buy: [{ provider_name: 'Apple TV' }, { provider_name: 'Amazon Video' }],
    rent: [{ provider_name: 'Apple TV' }]
  }, US: { flatrate: [{ provider_name: 'Max' }] } } };
  assert.deepStrictEqual(parseProviders(json, 'DE'), { link: 'https://www.themoviedb.org/movie/603-the-matrix/watch?locale=DE', providers: ['Netflix', 'Apple TV', 'Amazon Video'] });
  assert.deepStrictEqual(parseProviders(json, 'AT'), { link: '', providers: [] });
});

test('streaming links found: the first owned source that offers the title, or the iTunes hit from the same year', () => {
  const { pickStreamLink, pickItunesLink } = require('../src/Code.gs');
  const show = { streamingOptions: { de: [
    { service: { id: 'apple' }, type: 'buy', link: 'https://tv.apple.com/de/movie/x' },
    { service: { id: 'netflix' }, type: 'subscription', link: 'https://www.netflix.com/title/20557937/' },
    { service: { id: 'prime' }, type: 'rent', link: 'javascript:alert(1)' }
  ] } };
  assert.strictEqual(pickStreamLink(show, 'de', ['Netflix', 'Apple TV']), 'https://www.netflix.com/title/20557937/');
  assert.strictEqual(pickStreamLink(show, 'de', ['Amazon Prime Video']), '');
  assert.strictEqual(pickStreamLink(show, 'at', ['Netflix']), '');
  const hits = [
    { trackViewUrl: 'https://itunes.apple.com/de/movie/the-matrix-reloaded/id1', releaseDate: '2003-05-15T07:00:00Z' },
    { trackViewUrl: 'https://itunes.apple.com/de/movie/matrix/id2', releaseDate: '1999-03-31T08:00:00Z' }
  ];
  assert.strictEqual(pickItunesLink(hits, false, '1999'), 'https://itunes.apple.com/de/movie/matrix/id2');
  assert.strictEqual(pickItunesLink(hits, false, ''), 'https://itunes.apple.com/de/movie/the-matrix-reloaded/id1');
  assert.strictEqual(pickItunesLink([], true, '2008'), '');
  assert.strictEqual(pickItunesLink(hits, false, '1985'), '', 'a film from another year is a different film');
});

test('Apple links open the region\'s store', () => {
  const { localLink, pickStreamLink } = require('../src/Code.gs');
  assert.strictEqual(localLink('https://tv.apple.com/us/movie/the-matrix/umc.cmc.1', 'de'), 'https://tv.apple.com/de/movie/the-matrix/umc.cmc.1');
  assert.strictEqual(localLink('https://tv.apple.com/movie/umc.cmc.1', 'de'), 'https://tv.apple.com/de/movie/umc.cmc.1');
  assert.strictEqual(localLink('https://itunes.apple.com/us/movie/matrix/id2?uo=4', 'de'), 'https://itunes.apple.com/de/movie/matrix/id2?uo=4');
  assert.strictEqual(localLink('https://www.netflix.com/title/1', 'de'), 'https://www.netflix.com/title/1');
  assert.strictEqual(localLink('', 'de'), '');
  const show = { streamingOptions: { de: [{ service: { id: 'apple' }, link: 'https://tv.apple.com/us/movie/x/umc.1' }] } };
  assert.strictEqual(pickStreamLink(show, 'de', ['Apple TV']), 'https://tv.apple.com/de/movie/x/umc.1');
});
