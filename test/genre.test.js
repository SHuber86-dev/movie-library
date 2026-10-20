const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
const cats = item => Array.from(ctx.genreCategories(item));

test('a film with several genres is in every matching category, in display order', () => {
  // The Matrix: Action, Science Fiction
  assert.deepStrictEqual(cats({ genreIds: [878, 28] }), ['Action & Adventure', 'Sci-Fi & Fantasy']);
  // Toy Story: Animation, Adventure, Family, Comedy
  assert.deepStrictEqual(cats({ genreIds: [16, 12, 10751, 35] }), ['Action & Adventure', 'Comedy', 'Family & Animation']);
});

test('genre ids decide the category whatever language the names are in', () => {
  assert.deepStrictEqual(cats({ genres: ['Krimi', 'Thriller'], genreIds: [80, 53] }), ['Crime & Thriller']);
});

test('TV genres map onto the same categories', () => {
  assert.deepStrictEqual(cats({ genreIds: [10765, 18] }), ['Sci-Fi & Fantasy', 'Drama']);
  assert.deepStrictEqual(cats({ genreIds: [10762, 10764] }), ['Family & Animation', 'Documentary']);
});

test('rows cached before genre ids existed fall back to the English names', () => {
  assert.deepStrictEqual(cats({ genres: ['Horror', 'Mystery'] }), ['Crime & Thriller', 'Horror']);
});

test('an item with no known genre goes under Other', () => {
  assert.deepStrictEqual(cats({ genreIds: [] }), ['Other']);
  assert.deepStrictEqual(cats({ genres: ['Unbekannt'] }), ['Other']);
  assert.deepStrictEqual(cats({}), ['Other']);
});

test('every category the page can show is listed in order, Other last', () => {
  assert.deepStrictEqual(Array.from(ctx.CATEGORY_ORDER.concat([ctx.OTHER_CATEGORY])), [
    'Action & Adventure', 'Sci-Fi & Fantasy', 'Comedy', 'Crime & Thriller', 'Horror',
    'Drama', 'Romance', 'Family & Animation', 'Documentary', 'Other'
  ]);
});

test('the library the page gets carries the category order', () => {
  const lib = { people: [], categories: ['Drama', 'Other'], discs: [] };
  const c = { module: { exports: {} } };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), c);
  c.readLibraryCache_ = () => lib;
  c.personalData_ = () => ({ household: [], seen: {} });
  c.readWishlist_ = () => [];
  assert.deepStrictEqual(Array.from(c.getLibrary_({ name: 'Steffen' }).categories), ['Drama', 'Other']);
});
