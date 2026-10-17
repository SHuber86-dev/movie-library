const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);
const p = ctx.module.exports;

test('parseYears handles lists and ranges', () => {
  assert.deepStrictEqual([...p.parseYears('2013')], [2013]);
  assert.deepStrictEqual([...p.parseYears('1979, 1986')], [1979, 1986]);
  assert.deepStrictEqual([...p.parseYears('1993–2002')], [1993]);
});

test('cleanTitle strips year and edition suffixes', () => {
  assert.strictEqual(p.cleanTitle('Dune (2021)'), 'Dune');
  assert.strictEqual(p.cleanTitle("SAW - US Director's Cut"), 'SAW');
});

test('parseSeason splits show and season number', () => {
  assert.deepStrictEqual({ ...p.parseSeason('Lost – Season 4') }, { show: 'Lost', season: 4 });
  assert.deepStrictEqual({ ...p.parseSeason('The X-Files Seasons 1–9') }, { show: 'The X-Files', season: null });
});

test('parseCollectionItems drops lead-in text and expands prefixes', () => {
  assert.deepStrictEqual([...p.parseCollectionItems('5-Disc Special Edition. Batman Begins, The Dark Knight')], ['Batman Begins', 'The Dark Knight']);
  assert.deepStrictEqual(
    [...p.parseCollectionItems("Harry Potter and the Philosopher's Stone, the Chamber of Secrets")],
    ["Harry Potter and the Philosopher's Stone", 'Harry Potter and the Chamber of Secrets']
  );
  assert.deepStrictEqual(
    [...p.parseCollectionItems('The Lord of the Rings: The Two Towers (Extended),\nThe Lord of the Rings: The Return of the King\n')],
    ['The Lord of the Rings: The Two Towers', 'The Lord of the Rings: The Return of the King']
  );
});
