'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { parseScopedLimits } = require('../statusline.js');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage-response.json'), 'utf8')
);

test('extracts the Fable weekly_scoped row with label, percent and epoch reset', () => {
  const rows = parseScopedLimits(fixture);
  assert.deepEqual(rows, [{
    label: 'Fable',
    used_percentage: 10,
    resets_at: Math.floor(Date.parse('2026-09-26T17:59:59.731105+00:00') / 1000),
  }]);
});

test('ignores session and weekly_all rows (those already come from stdin)', () => {
  const rows = parseScopedLimits(fixture);
  assert.equal(rows.some(r => r.label === 'session' || r.label === 'weekly'), false);
});

test('returns an empty list when limits[] has no scoped rows', () => {
  const body = { ...fixture, limits: fixture.limits.filter(r => r.kind !== 'weekly_scoped') };
  assert.deepEqual(parseScopedLimits(body), []);
});

test('returns an empty list when limits is missing or not an array', () => {
  assert.deepEqual(parseScopedLimits({}), []);
  assert.deepEqual(parseScopedLimits({ limits: null }), []);
  assert.deepEqual(parseScopedLimits(null), []);
});

test('uses the surface display_name when the scope is a surface, and skips rows with no label', () => {
  const body = {
    limits: [
      { kind: 'weekly_scoped', percent: 42, resets_at: null, scope: { model: null, surface: { display_name: 'Cowork' } } },
      { kind: 'weekly_scoped', percent: 7, resets_at: null, scope: null },
    ],
  };
  assert.deepEqual(parseScopedLimits(body), [
    { label: 'Cowork', used_percentage: 42, resets_at: null },
  ]);
});

test('rounds percent to at most 2 decimals', () => {
  const body = { limits: [
    { kind: 'weekly_scoped', percent: 10.123456, resets_at: null, scope: { model: { display_name: 'Fable' } } },
  ] };
  assert.equal(parseScopedLimits(body)[0].used_percentage, 10.12);
});
