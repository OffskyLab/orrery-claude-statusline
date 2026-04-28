#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  try { process.stdout.write(render(data)); } catch {}
});

// ── Cache ─────────────────────────────────────────────────────

const CACHE_FILE = path.join(os.homedir(), '.orrery', 'statusline-cache.json');

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

function loadRateLimitsCache() {
  const c = readCache();
  if (c.rate_limits && Date.now() - (c.ts || 0) < 8 * 3600 * 1000) return c.rate_limits;
  return null;
}

function saveRateLimitsCache(rl) {
  writeCache({ rate_limits: rl, ts: Date.now() });
}

function accountCacheKey() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || '';
  return configDir ? `account_${crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)}` : 'account';
}

function loadAccountCache() {
  const c = readCache();
  const key = accountCacheKey();
  const tsKey = `${key}_ts`;
  if (c[key] && Date.now() - (c[tsKey] || 0) < 24 * 3600 * 1000) return c[key];
  return null;
}

function saveAccountCache(acct) {
  const key = accountCacheKey();
  writeCache({ [key]: acct, [`${key}_ts`]: Date.now() });
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

function readClaudeAccount() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || null;

  let email = null;
  try {
    const p = configDir
      ? path.join(configDir, '.claude.json')
      : path.join(os.homedir(), '.claude.json');
    email = JSON.parse(fs.readFileSync(p, 'utf8'))?.oauthAccount?.emailAddress || null;
  } catch {}

  let plan = null;
  if (process.platform === 'darwin') {
    try {
      const svc = claudeKeychainService(configDir);
      const user = process.env.USER || os.userInfo().username;
      const out = execFileSync('security',
        ['find-generic-password', '-s', svc, '-a', user, '-w'],
        { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      plan = JSON.parse(out)?.claudeAiOauth?.subscriptionType || null;
    } catch {}
  }

  let model = null;
  try {
    const p = configDir
      ? path.join(configDir, 'settings.json')
      : path.join(os.homedir(), '.claude', 'settings.json');
    model = JSON.parse(fs.readFileSync(p, 'utf8'))?.model || null;
  } catch {}

  return { email, plan, model };
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
    usage: 'Usage', env: 'Env', mem: 'Memory', acct: 'Account',
    noEnv: '(no env)', compactUnit: 'times',
    months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  },
  'zh-Hant': {
    project: '專案', context: 'Context', session: '工作階段',
    usage: '用量', env: '環境', mem: '記憶', acct: '帳號',
    noEnv: '（無環境）', compactUnit: '次',
    months: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
  },
  'zh-Hans': {
    project: '项目', context: 'Context', session: '会话',
    usage: '用量', env: '环境', mem: '记忆', acct: '帐号',
    noEnv: '（无环境）', compactUnit: '次',
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
  env:     '⊕',
  mem:     '◆',
  acct:    '◉',
};

const LABEL_COLORS = {
  project: '\x1b[1;97m',
  context: '\x1b[1;97m',
  session: '\x1b[1;97m',
  usage:   '\x1b[1;97m',
  env:     '\x1b[1;97m',
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

function lbl(key) {
  const icon  = ICONS[key]        || '';
  const text  = t(key)            || key;
  const color = LABEL_COLORS[key] || A.dim;
  const full  = `${icon} ${text}`;
  const pad   = Math.max(0, LABEL_WIDTH - displayWidth(full));
  return `${color}${full}${A.reset}${' '.repeat(pad)}`;
}

function usageLbl(duration) {
  const icon  = ICONS.usage;
  const text  = t('usage');
  const color = LABEL_COLORS.usage;
  const full  = `${icon} ${text} ${duration}`;
  const pad   = Math.max(0, LABEL_WIDTH - displayWidth(full));
  return `${color}${icon} ${text}${A.reset} ${A.dim}${duration}${A.reset}${' '.repeat(pad)}`;
}

// ── Render ────────────────────────────────────────────────────

function render(data) {
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

  // Account info (cached 24h; read live on miss)
  let acct = loadAccountCache();
  if (!acct) {
    acct = readClaudeAccount();
    if (acct.email || acct.plan || acct.model) saveAccountCache(acct);
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
    lbl('project') +
    `${A.white}${shortenCwd(cwd)}${A.reset}` +
    (branchTag ? `  ${branchTag}` : '')
  );

  // ── ◎ session
  if (sessionId) {
    rows.push(lbl('session') + `${A.gray}${sessionId}${A.reset}`);
  }

  // ── ◉ acct  (email  plan  model) — only render when email is available
  if (acct?.email) {
    const parts = [`${A.gray}${acct.email}${A.reset}`];
    if (acct.plan) parts.push(`${A.bold}${colorPlan(acct.plan)}${acct.plan}${A.reset}`);
    if (acctModel) parts.push(`${A.dim}${acctModel}${A.reset}`);
    rows.push(lbl('acct') + parts.join('  '));
  }

  const termW = process.stdout.columns || process.stderr.columns || 120;

  // Pre-calculate usage bar width, pad pct column so ↺ aligns across rows
  const reset5Plain = fiveH.resets_at  ? ` ↺ ${resetTimeStr(fiveH.resets_at)}`  : '';
  const reset7Plain = sevenD.resets_at ? ` ↺ ${resetTimeStr(sevenD.resets_at)}` : '';
  const pct5Raw = `${fivePct}%`;
  const pct7Raw = `${sevenPct}%`;
  const ctxPctStr = ctxPct != null ? `${ctxPct}%` : '';
  const pctColW = Math.max(pct5Raw.length, pct7Raw.length, ctxPctStr.length);
  const fixed5 = LABEL_WIDTH + 1 + pctColW + displayWidth(reset5Plain);
  const fixed7 = LABEL_WIDTH + 1 + pctColW + displayWidth(reset7Plain);
  const BAR_MAX = 60;
  const barW = Math.min(BAR_MAX, Math.max(16, termW - Math.max(fixed5, fixed7)));

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
    rows.push(usageLbl('5h') + fiveStr);
    rows.push(usageLbl('7d') + sevenStr);
  }

  // ── ✎ Context  (same bar width as usage; compact count aligned with ↺ in usage rows)
  if (ctxPct != null) {
    const c = colorPct(ctxPct);
    const compactCount = readCompactCount(data.transcript_path);
    const ctxPad = ' '.repeat(pctColW - ctxPctStr.length);
    const compactStr = ` ${A.gray}⚭ ${compactCount} ${t('compactUnit')}${A.reset}`;
    rows.push(lbl('context') +
      `${A.bold}${c}${quotaBar(ctxPct, barW)}${A.reset} ${A.bold}${c}${ctxPctStr}${A.reset}${ctxPad}${compactStr}`);
  }

  // ── ⊕ env  (name ▶︎ path)
  if (envName) {
    const nameTag = `${A.bold}${A.cyan}${envName}${A.reset}`;
    const pathTag = envDir
      ? ` ${A.gray}▶︎${A.reset} ${A.gray}${homeShortenPath(envDir)}${A.reset}`
      : '';
    rows.push(lbl('env') + nameTag + pathTag);
  }

  // ── ◆ mem
  if (memDir) {
    rows.push(lbl('mem') + `${A.gray}${shortenMemPath(memDir)}${A.reset}`);
  }

  return rows.join('\n') + '\n';
}
