'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the cache + credentials in a temp config dir, and pin the locale,
// before the module computes CONFIG_DIR / LOCALE at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-statusline-'));
process.env.CLAUDE_CONFIG_DIR = TMP;
process.env.LANG = 'en_US.UTF-8';
delete process.env.ORRERY_ACTIVE_ENV;

const sl = require('../statusline.js');
const { render, fetchScopedLimits, readOAuthToken, refreshScopedLimits } = sl;

const CACHE = path.join(TMP, 'statusline-cache.json');
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage-response.json'), 'utf8')
);

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const stdin = { cwd: TMP, session_id: 'sess', model: 'claude-fable-5-1',
  rate_limits: { five_hour: { used_percentage: 31, resets_at: 1790409000 },
                 seven_day: { used_percentage: 5,  resets_at: 1790445600 } } };
const fableRow = { label: 'Fable', used_percentage: 10, resets_at: 1790445600 };

function writeCache(obj) { fs.writeFileSync(CACHE, JSON.stringify(obj)); }
function rmCache() { try { fs.unlinkSync(CACHE); } catch {} }

test('renders a Fable usage row from a fresh cache, after the 7d row', () => {
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: Date.now() });
  const out = strip(render(stdin, { refresh: () => {} }));
  const lines = out.split('\n');
  const i7d = lines.findIndex(l => l.startsWith('◈ Usage 7d'));
  const iFable = lines.findIndex(l => l.startsWith('◈ Usage Fable'));
  assert.ok(i7d >= 0, '7d row present');
  assert.equal(iFable, i7d + 1, 'Fable row directly after 7d');
  assert.match(lines[iFable], /10%/);
  rmCache();
});

test('renders no scoped row when the server listed none (empty array)', () => {
  writeCache({ scoped_limits: [], scoped_limits_ts: Date.now() });
  const out = strip(render(stdin, { refresh: () => {} }));
  assert.doesNotMatch(out, /Fable/);
  rmCache();
});

test('renders no scoped row when nothing is cached yet', () => {
  rmCache();
  const out = strip(render(stdin, { refresh: () => {} }));
  assert.doesNotMatch(out, /Fable/);
});

test('asks for a background refresh when the scoped cache is stale, not when fresh', () => {
  let calls = 0;
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: Date.now() - 6 * 60 * 1000 });
  render(stdin, { refresh: () => calls++ });
  assert.equal(calls, 1, 'stale → refresh');

  calls = 0;
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: Date.now() });
  render(stdin, { refresh: () => calls++ });
  assert.equal(calls, 0, 'fresh → no refresh');
  rmCache();
});

test('keeps showing the last known rows while the cache is stale', () => {
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: Date.now() - 6 * 60 * 1000 });
  const out = strip(render(stdin, { refresh: () => {} }));
  assert.match(out, /◈ Usage Fable/);
  rmCache();
});

test('keeps rows when .claude.json is rewritten by the same account (Claude Code touches it constantly)', () => {
  const cj = path.join(TMP, '.claude.json');
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: Date.now() - 1000, scoped_limits_owner: 'uuid-A' });
  fs.writeFileSync(cj, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-A' } }));
  let calls = 0;
  const out = strip(render(stdin, { refresh: () => calls++ }));
  assert.match(out, /◈ Usage Fable/);
  assert.equal(calls, 0, 'same owner + fresh → no refresh');
  fs.unlinkSync(cj);
  rmCache();
});

test('drops rows and refreshes when the account in .claude.json changed', () => {
  const cj = path.join(TMP, '.claude.json');
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: Date.now(), scoped_limits_owner: 'uuid-A' });
  fs.writeFileSync(cj, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-B' } }));
  let calls = 0;
  const out = strip(render(stdin, { refresh: () => calls++ }));
  assert.doesNotMatch(out, /Fable/);
  assert.equal(calls, 1, 'owner changed → refresh');
  fs.unlinkSync(cj);
  rmCache();
});

test('refreshScopedLimits records the owning account uuid', async () => {
  rmCache();
  const cj = path.join(TMP, '.claude.json');
  fs.writeFileSync(cj, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-A' } }));
  fs.writeFileSync(path.join(TMP, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  await refreshScopedLimits(async () => ({ ok: true, status: 200, json: async () => fixture }));
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  assert.equal(c.scoped_limits_owner, 'uuid-A');
  fs.unlinkSync(cj);
  fs.unlinkSync(path.join(TMP, '.credentials.json'));
  rmCache();
});

test('fetchScopedLimits sends the bearer token and returns parsed rows', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => fixture };
  };
  const rows = await fetchScopedLimits('tok-123', fetchImpl);
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.opts.headers.Authorization, 'Bearer tok-123');
  assert.equal(seen.opts.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(rows.map(r => r.label), ['Fable']);
});

test('fetchScopedLimits returns null on a non-2xx response', async () => {
  const rows = await fetchScopedLimits('tok', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal(rows, null);
});

test('readOAuthToken falls back to .credentials.json in the config dir', () => {
  const credPath = path.join(TMP, '.credentials.json');
  fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'file-tok' } }));
  assert.equal(readOAuthToken(), 'file-tok');
  fs.unlinkSync(credPath);
  assert.equal(readOAuthToken(), null);
});

test('refreshScopedLimits writes parsed rows and a timestamp to the cache', async () => {
  rmCache();
  fs.writeFileSync(path.join(TMP, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  const before = Date.now();
  await refreshScopedLimits(async () => ({ ok: true, status: 200, json: async () => fixture }));
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  assert.deepEqual(c.scoped_limits.map(r => r.label), ['Fable']);
  assert.ok(c.scoped_limits_ts >= before);
  fs.unlinkSync(path.join(TMP, '.credentials.json'));
  rmCache();
});

test('refreshScopedLimits on failure keeps old rows but still stamps the time', async () => {
  writeCache({ scoped_limits: [fableRow], scoped_limits_ts: 1 });
  fs.writeFileSync(path.join(TMP, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  await refreshScopedLimits(async () => { throw new Error('offline'); });
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  assert.deepEqual(c.scoped_limits, [fableRow]);
  assert.ok(c.scoped_limits_ts > 1);
  fs.unlinkSync(path.join(TMP, '.credentials.json'));
  rmCache();
});
