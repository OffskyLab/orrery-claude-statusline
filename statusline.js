#!/usr/bin/env node
'use strict';

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

function main() {
  if (process.argv.includes('--refresh-scoped-limits')) {
    refreshScopedLimits().finally(() => process.exit(0));
    return;
  }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => (raw += d));
  process.stdin.on('end', () => {
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    try { process.stdout.write(render(data)); } catch {}
  });
}

// ── Cache ─────────────────────────────────────────────────────

// Cache lives inside the per-account config dir, so accounts are naturally
// isolated — no in-file account key needed. Falls back to ~/.claude (the origin
// account dir symlink) when CLAUDE_CONFIG_DIR is unset (bare `claude` at origin).
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CACHE_FILE = path.join(CONFIG_DIR, 'statusline-cache.json');

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
  return {};
}

function writeCache(patch) {
  try {
    const c = readCache();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.assign(c, patch)));
  } catch {}
}

// mtime of the active .claude.json — used to invalidate caches when
// `orrery use` / `/orrery:phantom` swaps the pinned account: both
// rewrite this file as part of materialize, so a newer mtime than the
// cache timestamp means the cached account no longer matches the live
// credentials Claude is reading.
function claudeJsonMtime() {
  try {
    const p = path.join(CONFIG_DIR, '.claude.json');
    return fs.statSync(p).mtimeMs;
  } catch { return 0; }
}

function loadRateLimitsCache() {
  const c = readCache();
  if (!c.rate_limits) return null;
  const cachedTs = c.ts || 0;
  if (Date.now() - cachedTs >= 8 * 3600 * 1000) return null;
  if (claudeJsonMtime() > cachedTs) return null;
  return c.rate_limits;
}

function saveRateLimitsCache(rl) {
  writeCache({ rate_limits: rl, ts: Date.now() });
}

function loadAccountCache() {
  // The cache file is per-account (it lives in the account config dir), so the
  // directory is the partition — no in-file account key needed.
  const c = readCache();
  if (!c.account) return null;
  const cachedTs = c.account_ts || 0;
  if (Date.now() - cachedTs >= 24 * 3600 * 1000) return null;
  if (claudeJsonMtime() > cachedTs) return null;
  return c.account;
}

function saveAccountCache(acct) {
  writeCache({ account: acct, account_ts: Date.now() });
}

// Model-scoped weekly windows (e.g. Fable) come from a network call, so they
// are cached for SCOPED_TTL and refreshed in the background — the render path
// never waits on the network. Rows stay visible (stale) for up to 24h so a
// transient fetch failure doesn't make the row flicker away.
const SCOPED_TTL      = 5 * 60 * 1000;
const SCOPED_MAX_AGE  = 24 * 3600 * 1000;
const SCOPED_LOCK_TTL = 60 * 1000;

// Which account the scoped rows belong to. Claude Code rewrites .claude.json
// constantly during a session, so the mtime rule the other caches use would
// hide these rows most of the time; compare the account uuid instead, which
// only changes when `orrery use` / phantom re-materializes the credentials.
function scopedOwner() {
  try {
    const p = path.join(CONFIG_DIR, '.claude.json');
    const acct = JSON.parse(fs.readFileSync(p, 'utf8'))?.oauthAccount;
    return acct?.accountUuid || acct?.emailAddress || null;
  } catch { return null; }
}

function loadScopedLimitsCache() {
  const c = readCache();
  const ts = c.scoped_limits_ts || 0;
  const age = Date.now() - ts;
  if (!Array.isArray(c.scoped_limits) || age >= SCOPED_MAX_AGE
      || (c.scoped_limits_owner || null) !== scopedOwner()) {
    return { rows: null, fresh: false };
  }
  return { rows: c.scoped_limits, fresh: age < SCOPED_TTL };
}

function saveScopedLimitsCache(rows) {
  const patch = { scoped_limits_ts: Date.now(), scoped_limits_owner: scopedOwner() };
  if (rows) patch.scoped_limits = rows;
  writeCache(patch);
}

// ── Compaction count (derived from transcript JSONL) ──────────

function readCompactCount(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    const stat = fs.statSync(transcriptPath);
    const cacheKey = `${transcriptPath}:${stat.mtimeMs}:${stat.size}`;
    const c = readCache();
    if (c.compact && c.compact.key === cacheKey) return c.compact.count;

    const data = fs.readFileSync(transcriptPath, 'utf8');
    let count = 0;
    const marker = '"isCompactSummary":true';
    let idx = 0;
    while ((idx = data.indexOf(marker, idx)) !== -1) {
      count++;
      idx += marker.length;
    }
    writeCache({ compact: { key: cacheKey, count } });
    return count;
  } catch { return 0; }
}

// ── Account info ──────────────────────────────────────────────

function claudeKeychainService(configDir) {
  if (!configDir) return 'Claude Code-credentials';
  const normalized = configDir.normalize('NFC');
  const hex = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hex}`;
}

// Parsed `Claude Code-credentials[-<hash>]` Keychain entry (macOS only); null
// elsewhere or when the entry is missing.
function readKeychainCredentials(configDir) {
  if (process.platform !== 'darwin') return null;
  try {
    const svc = claudeKeychainService(configDir);
    const user = process.env.USER || os.userInfo().username;
    const out = execFileSync('security',
      ['find-generic-password', '-s', svc, '-a', user, '-w'],
      { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return JSON.parse(out);
  } catch { return null; }
}

// The OAuth access token Claude Code itself is logged in with — the same
// credential `/usage` uses. Keychain first (macOS), then the on-disk
// `.credentials.json` Claude Code writes on other platforms. Never cached or
// printed; only ever sent as a bearer to api.anthropic.com.
function readOAuthToken() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || null;
  const fromKeychain = readKeychainCredentials(configDir)?.claudeAiOauth?.accessToken;
  if (fromKeychain) return fromKeychain;
  try {
    const p = path.join(CONFIG_DIR, '.credentials.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'))?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

function readClaudeAccount() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || null;

  // Orrery account name — the identity `orrery use <name>` selects — from the
  // account dir's metadata.json (`~/.claude` symlinks to the origin account dir
  // when CLAUDE_CONFIG_DIR is unset). More reliably present than the email.
  let name = null;
  try {
    const p = configDir
      ? path.join(configDir, 'metadata.json')
      : path.join(os.homedir(), '.claude', 'metadata.json');
    name = JSON.parse(fs.readFileSync(p, 'utf8'))?.displayName || null;
  } catch {}

  let email = null;
  try {
    const p = configDir
      ? path.join(configDir, '.claude.json')
      : path.join(os.homedir(), '.claude.json');
    email = JSON.parse(fs.readFileSync(p, 'utf8'))?.oauthAccount?.emailAddress || null;
  } catch {}

  const plan = readKeychainCredentials(configDir)?.claudeAiOauth?.subscriptionType || null;

  let model = null;
  try {
    const p = configDir
      ? path.join(configDir, 'settings.json')
      : path.join(os.homedir(), '.claude', 'settings.json');
    model = JSON.parse(fs.readFileSync(p, 'utf8'))?.model || null;
  } catch {}

  return { name, email, plan, model };
}

// ── Model-scoped usage (claude.ai usage endpoint) ─────────────

// The statusline stdin payload only carries the 5h / 7d windows. Per-model
// weekly buckets (e.g. Fable) are only exposed by the claude.ai usage endpoint
// that `/usage` reads, as `limits[]` rows of kind `weekly_scoped`. Pull those
// out into the same {used_percentage, resets_at} shape the stdin windows use.
function parseScopedLimits(body) {
  const limits = body && Array.isArray(body.limits) ? body.limits : [];
  const rows = [];
  for (const row of limits) {
    if (!row || row.kind !== 'weekly_scoped') continue;
    const label = row.scope?.model?.display_name || row.scope?.surface?.display_name || null;
    if (!label) continue;
    const pct = typeof row.percent === 'number' ? parseFloat(row.percent.toFixed(2)) : 0;
    const ts = row.resets_at ? Date.parse(row.resets_at) : NaN;
    rows.push({
      label,
      used_percentage: pct,
      resets_at: Number.isFinite(ts) ? Math.floor(ts / 1000) : null,
    });
  }
  return rows;
}

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

// GET the usage endpoint with the bearer token. Returns parsed scoped rows, or
// null on any failure (non-2xx, timeout, network). `fetchImpl` is injectable
// for tests.
async function fetchScopedLimits(token, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parseScopedLimits(await res.json());
  } catch { return null; }
}

// Background refresh entry (`--refresh-scoped-limits`): fetch, parse, and write
// the cache. Always stamps scoped_limits_ts — even on failure or with no token
// — so the render path doesn't respawn a refresh every 30s while offline.
async function refreshScopedLimits(fetchImpl = globalThis.fetch) {
  const token = readOAuthToken();
  const rows = token ? await fetchScopedLimits(token, fetchImpl) : null;
  saveScopedLimitsCache(rows);
}

// Kick off a detached refresh child and return immediately. A short lock in
// the cache stops overlapping children when renders come in quick succession.
function spawnScopedRefresh() {
  try {
    const c = readCache();
    if (Date.now() - (c.scoped_limits_refresh_ts || 0) < SCOPED_LOCK_TTL) return;
    writeCache({ scoped_limits_refresh_ts: Date.now() });
    const child = spawn(process.execPath, [__filename, '--refresh-scoped-limits'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
  } catch {}
}

// ── i18n ──────────────────────────────────────────────────────

function detectLocale() {
  const lang = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || '';
  if (/zh[-_](TW|HK|MO|Hant)/i.test(lang)) return 'zh-Hant';
  if (/zh[-_](CN|SG|Hans)/i.test(lang)) return 'zh-Hans';
  return 'en';
}

const LOCALE = detectLocale();

const L10N = {
  en: {
    project: 'Project', context: 'Context', session: 'Session',
    usage: 'Usage', sandbox: 'Sandbox', mem: 'Memory', acct: 'Account',
    noSandbox: '(origin)', compactUnit: 'times',
    months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  },
  'zh-Hant': {
    project: '專案', context: 'Context', session: '工作階段',
    usage: '用量', sandbox: '沙盒', mem: '記憶', acct: '帳號',
    noSandbox: '（origin）', compactUnit: '次',
    months: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
  },
  'zh-Hans': {
    project: '项目', context: 'Context', session: '会话',
    usage: '用量', sandbox: '沙盒', mem: '记忆', acct: '帐号',
    noSandbox: '（origin）', compactUnit: '次',
    months: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
  },
};

function t(key) {
  return (L10N[LOCALE] || L10N.en)[key] ?? L10N.en[key];
}

// ── Orrery helpers ────────────────────────────────────────────

function orreryHome() {
  return path.join(os.homedir(), '.orrery');
}

function currentEnvName() {
  return process.env.ORRERY_ACTIVE_ENV || null;
}

function findEnvDir(name) {
  if (!name) return null;
  if (name === 'origin') return path.join(orreryHome(), 'origin');
  try {
    const envsDir = path.join(orreryHome(), 'envs');
    for (const dir of fs.readdirSync(envsDir)) {
      const jsonPath = path.join(envsDir, dir, 'env.json');
      try {
        const env = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (env.name === name) return path.join(envsDir, dir);
      } catch {}
    }
  } catch {}
  return null;
}

function findMemoryDir(envDir, cwd) {
  if (!envDir || !cwd) return null;
  const key = cwd.replace(/\//g, '-');
  const p = path.join(envDir, 'claude', 'projects', key, 'memory');
  return fs.existsSync(p) ? p : null;
}

// ── Git helpers ───────────────────────────────────────────────

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function gitDirtyCount(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      timeout: 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').length : 0;
  } catch { return 0; }
}

// ── Display helpers ───────────────────────────────────────────

function homeShortenPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function shortenCwd(p) {
  const s = homeShortenPath(p);
  const parts = s.split('/');
  return parts.length > 5 ? '…/' + parts.slice(-4).join('/') : s;
}

function shortenMemPath(p) {
  const marker = '/claude/projects/';
  const idx = p.indexOf(marker);
  return idx >= 0 ? '…' + p.slice(idx) : homeShortenPath(p);
}

function quotaBar(pct, width = 8) {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function visibleWidth(s) {
  return displayWidth(s.replace(/\x1b\[[0-9;]*m/g, ''));
}

function resetTimeStr(resetsAt) {
  if (!resetsAt) return '';
  const d = new Date(resetsAt * 1000);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const months = t('months');
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? time : `${months[d.getMonth()]}${d.getDate()}日 ${time}`;
}

// ── ANSI ──────────────────────────────────────────────────────

const A = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  gray:     '\x1b[90m',
  white:    '\x1b[97m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  red:      '\x1b[31m',
  cyan:     '\x1b[36m',
  bBlue:    '\x1b[1;94m',
  bCyan:    '\x1b[1;96m',
  bYellow:  '\x1b[1;93m',
  bMagenta: '\x1b[1;95m',
  bGreen:   '\x1b[1;92m',
};

function colorPct(pct) {
  if (pct < 50) return A.green;
  if (pct < 80) return A.yellow;
  return A.red;
}

function colorPlan(plan) {
  if (!plan) return A.gray;
  switch (plan.toLowerCase()) {
    case 'max':    return A.bYellow;
    case 'pro':    return A.bCyan;
    case 'team':   return A.bBlue;
    case 'free':   return A.gray;
    default:       return A.gray;
  }
}

// ── Labels ────────────────────────────────────────────────────

const ICONS = {
  project: '★',
  context: '✎',
  session: '◎',
  usage:   '◈',
  sandbox: '⊕',
  mem:     '◆',
  acct:    '◉',
};

const LABEL_COLORS = {
  project: '\x1b[1;97m',
  context: '\x1b[1;97m',
  session: '\x1b[1;97m',
  usage:   '\x1b[1;97m',
  sandbox: '\x1b[1;97m',
  mem:     '\x1b[1;97m',
  acct:    '\x1b[1;97m',
};

// Emoji and CJK are both 2 display columns wide
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100  && cp <= 0x115F)  ||
      (cp >= 0x2E80  && cp <= 0x303E)  ||
      (cp >= 0x3040  && cp <= 0x33FF)  ||
      (cp >= 0x3400  && cp <= 0x4DBF)  ||
      (cp >= 0x4E00  && cp <= 0x9FFF)  ||
      (cp >= 0xAC00  && cp <= 0xD7AF)  ||
      (cp >= 0xF900  && cp <= 0xFAFF)  ||
      (cp >= 0xFF00  && cp <= 0xFF60)  ||
      (cp >= 0x1F300 && cp <= 0x1FAFF)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Label column: icon + space + text, padded to LABEL_WIDTH display cols
const LABEL_WIDTH = 12;

function lbl(key, width = LABEL_WIDTH) {
  const icon  = ICONS[key]        || '';
  const text  = t(key)            || key;
  const color = LABEL_COLORS[key] || A.dim;
  const full  = `${icon} ${text}`;
  const pad   = Math.max(0, width - displayWidth(full));
  return `${color}${full}${A.reset}${' '.repeat(pad)}`;
}

function usageLblPlain(duration) {
  return `${ICONS.usage} ${t('usage')} ${duration}`;
}

function usageLbl(duration, width = LABEL_WIDTH) {
  const icon  = ICONS.usage;
  const text  = t('usage');
  const color = LABEL_COLORS.usage;
  const full  = usageLblPlain(duration);
  const pad   = Math.max(0, width - displayWidth(full));
  return `${color}${icon} ${text}${A.reset} ${A.dim}${duration}${A.reset}${' '.repeat(pad)}`;
}

// ── Render ────────────────────────────────────────────────────

function render(data, { refresh = spawnScopedRefresh } = {}) {
  const cwd       = data.cwd || process.cwd();
  const sessionId = data.session_id || '';
  const ctxPct    = data.context_window?.used_percentage != null
    ? parseFloat(data.context_window.used_percentage.toFixed(2)) : null;

  let rl = data.rate_limits;
  const hasLive = rl && (rl.five_hour || rl.seven_day);
  if (hasLive) {
    saveRateLimitsCache(rl);
  } else {
    rl = loadRateLimitsCache() || {};
  }

  const fiveH    = rl.five_hour  || {};
  const sevenD   = rl.seven_day  || {};
  const fivePct  = parseFloat((fiveH.used_percentage  ?? 0).toFixed(2));
  const sevenPct = parseFloat((sevenD.used_percentage ?? 0).toFixed(2));

  // Model-scoped weekly rows (e.g. Fable): cache only; refresh in background.
  const scoped = loadScopedLimitsCache();
  const scopedRows = scoped.rows || [];
  if (!scoped.fresh) refresh();

  // Label column must fit the widest scoped label (e.g. "◈ Usage Fable").
  const labelW = Math.max(LABEL_WIDTH,
    ...scopedRows.map(r => displayWidth(usageLblPlain(r.label)) + 1));

  // Account info (cached 24h; read live on miss)
  let acct = loadAccountCache();
  if (!acct) {
    acct = readClaudeAccount();
    if (acct.name || acct.email || acct.plan || acct.model) saveAccountCache(acct);
  }
  const acctModel = (typeof data.model === 'string' ? data.model : null) || acct?.model || null;

  const envName = currentEnvName();
  const envDir  = findEnvDir(envName);
  const branch  = gitBranch(cwd);
  const dirty   = branch ? gitDirtyCount(cwd) : 0;
  const memDir  = findMemoryDir(envDir, cwd);

  const rows = [];

  // ── ★ project
  const branchTag = branch
    ? `${A.bold}${A.green}${branch}${dirty ? ` ${A.yellow}(${dirty})` : ''}${A.reset}`
    : '';
  rows.push(
    lbl('project', labelW) +
    `${A.white}${shortenCwd(cwd)}${A.reset}` +
    (branchTag ? `  ${branchTag}` : '')
  );

  // ── ◎ session
  if (sessionId) {
    rows.push(lbl('session', labelW) + `${A.gray}${sessionId}${A.reset}`);
  }

  // ── ◉ acct  (orrery name  email  plan  model) — render when we have the
  // orrery account name or the email.
  if (acct?.name || acct?.email) {
    const parts = [];
    if (acct.name) parts.push(`${A.bold}${A.cyan}${acct.name}${A.reset}`);
    if (acct.email) parts.push(`${A.gray}${acct.email}${A.reset}`);
    if (acct.plan) parts.push(`${A.bold}${colorPlan(acct.plan)}${acct.plan}${A.reset}`);
    if (acctModel) parts.push(`${A.dim}${acctModel}${A.reset}`);
    rows.push(lbl('acct', labelW) + parts.join('  '));
  }

  const termW = process.stdout.columns || process.stderr.columns || 120;

  // Pre-calculate usage bar width, pad pct column so ↺ aligns across rows
  const reset5Plain = fiveH.resets_at  ? ` ↺ ${resetTimeStr(fiveH.resets_at)}`  : '';
  const reset7Plain = sevenD.resets_at ? ` ↺ ${resetTimeStr(sevenD.resets_at)}` : '';
  const pct5Raw = `${fivePct}%`;
  const pct7Raw = `${sevenPct}%`;
  const ctxPctStr = ctxPct != null ? `${ctxPct}%` : '';
  const scopedPlain = scopedRows.map(r => ({
    label: r.label,
    pct: r.used_percentage,
    pctRaw: `${r.used_percentage}%`,
    resetPlain: r.resets_at ? ` ↺ ${resetTimeStr(r.resets_at)}` : '',
  }));
  const pctColW = Math.max(pct5Raw.length, pct7Raw.length, ctxPctStr.length,
    ...scopedPlain.map(r => r.pctRaw.length));
  const fixedW = [reset5Plain, reset7Plain, ...scopedPlain.map(r => r.resetPlain)]
    .map(rp => labelW + 1 + pctColW + displayWidth(rp));
  const BAR_MAX = 60;
  const barW = Math.min(BAR_MAX, Math.max(16, termW - Math.max(...fixedW)));

  // ── ✎ Context  (same bar width as usage; compact count aligned with ↺ in usage rows)
  if (ctxPct != null) {
    const c = colorPct(ctxPct);
    const compactCount = readCompactCount(data.transcript_path);
    const ctxPad = ' '.repeat(pctColW - ctxPctStr.length);
    const compactStr = ` ${A.gray}⚭ ${compactCount} ${t('compactUnit')}${A.reset}`;
    rows.push(lbl('context', labelW) +
      `${A.bold}${c}${quotaBar(ctxPct, barW)}${A.reset} ${A.bold}${c}${ctxPctStr}${A.reset}${ctxPad}${compactStr}`);
  }

  // ── ◈ usage: each row has its own "◈ Nx 用量" label; pct padded for ↺ alignment
  {
    const c5 = colorPct(fivePct);
    const c7 = colorPct(sevenPct);
    const fiveReset  = reset5Plain ? ` ${A.gray}${reset5Plain.trim()}${A.reset}` : '';
    const sevenReset = reset7Plain ? ` ${A.gray}${reset7Plain.trim()}${A.reset}` : '';
    const pct5Pad = ' '.repeat(pctColW - pct5Raw.length);
    const pct7Pad = ' '.repeat(pctColW - pct7Raw.length);
    const fiveStr  = `${A.bold}${c5}${quotaBar(fivePct, barW)}${A.reset} ${A.bold}${c5}${pct5Raw}${A.reset}${pct5Pad}${fiveReset}`;
    const sevenStr = `${A.bold}${c7}${quotaBar(sevenPct, barW)}${A.reset} ${A.bold}${c7}${pct7Raw}${A.reset}${pct7Pad}${sevenReset}`;
    rows.push(usageLbl('5h', labelW) + fiveStr);
    rows.push(usageLbl('7d', labelW) + sevenStr);

    // ── ◈ usage <model>: per-model weekly windows from the usage endpoint
    for (const r of scopedPlain) {
      const c = colorPct(r.pct);
      const reset = r.resetPlain ? ` ${A.gray}${r.resetPlain.trim()}${A.reset}` : '';
      const pad = ' '.repeat(pctColW - r.pctRaw.length);
      rows.push(usageLbl(r.label, labelW) +
        `${A.bold}${c}${quotaBar(r.pct, barW)}${A.reset} ${A.bold}${c}${r.pctRaw}${A.reset}${pad}${reset}`);
    }
  }

  // ── ⊕ sandbox  (name ▶︎ path)
  if (envName) {
    const nameTag = `${A.bold}${A.cyan}${envName}${A.reset}`;
    const pathTag = envDir
      ? ` ${A.gray}▶︎${A.reset} ${A.gray}${homeShortenPath(envDir)}${A.reset}`
      : '';
    rows.push(lbl('sandbox', labelW) + nameTag + pathTag);
  }

  // ── ◆ mem
  if (memDir) {
    rows.push(lbl('mem', labelW) + `${A.gray}${shortenMemPath(memDir)}${A.reset}`);
  }

  return rows.join('\n') + '\n';
}

// ── Entry ─────────────────────────────────────────────────────

module.exports = { render, parseScopedLimits, fetchScopedLimits, readOAuthToken, refreshScopedLimits };

if (require.main === module) main();
