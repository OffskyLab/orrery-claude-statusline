#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
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

// ── Rate-limit cache ──────────────────────────────────────────

const CACHE_FILE = path.join(os.homedir(), '.orrery', 'statusline-cache.json');

function loadRateLimitsCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - c.ts < 8 * 3600 * 1000) return c.rate_limits;
  } catch {}
  return null;
}

function saveRateLimitsCache(rl) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ rate_limits: rl, ts: Date.now() }));
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
    project: 'project', session: 'session', usage: 'usage', env: 'env', mem: 'mem',
    noEnv: '(no env)',
    months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  },
  'zh-Hant': {
    project: '專案', session: '工作階段', usage: '用量', env: '環境', mem: '記憶',
    noEnv: '（無環境）',
    months: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
  },
  'zh-Hans': {
    project: '项目', session: '会话', usage: '用量', env: '环境', mem: '记忆',
    noEnv: '（无环境）',
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

function tzOffset() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const m = String(Math.abs(off) % 60).padStart(2, '0');
  return `${sign}${h}${m}`;
}

function resetTimeStr(resetsAt) {
  if (!resetsAt) return '';
  const d = new Date(resetsAt * 1000);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm} ${tzOffset()}`;
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
  // standard
  gray:     '\x1b[90m',
  white:    '\x1b[97m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  red:      '\x1b[31m',
  cyan:     '\x1b[36m',
  // bright
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

// ── Labels ────────────────────────────────────────────────────

const ICONS = {
  project: '📁',
  session: '💬',
  usage:   '📊',
  env:     '🪐',
  mem:     '🧠',
};

const LABEL_COLORS = {
  project: A.bBlue,
  session: A.bCyan,
  usage:   A.bYellow,
  env:     A.bMagenta,
  mem:     A.bGreen,
};

// Emoji and CJK are both 2 display columns wide
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100  && cp <= 0x115F)  ||  // Hangul Jamo
      (cp >= 0x2E80  && cp <= 0x303E)  ||  // CJK Radicals
      (cp >= 0x3040  && cp <= 0x33FF)  ||  // Japanese / CJK symbols
      (cp >= 0x3400  && cp <= 0x4DBF)  ||  // CJK Ext-A
      (cp >= 0x4E00  && cp <= 0x9FFF)  ||  // CJK Unified
      (cp >= 0xAC00  && cp <= 0xD7AF)  ||  // Hangul Syllables
      (cp >= 0xF900  && cp <= 0xFAFF)  ||  // CJK Compatibility
      (cp >= 0xFF00  && cp <= 0xFF60)  ||  // Fullwidth
      (cp >= 0x1F300 && cp <= 0x1FAFF)     // Emoji (misc symbols, emoticons, etc.)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Label column: icon + space + text, padded to LABEL_WIDTH display cols
// Longest: "💬 工作階段" = 2+1+8 = 11. Use 13 to leave 2 trailing spaces.
const LABEL_WIDTH = 13;

function lbl(key) {
  const icon  = ICONS[key]        || '';
  const text  = t(key)            || key;
  const color = LABEL_COLORS[key] || A.dim;
  const full  = `${icon} ${text}`;
  const pad   = Math.max(0, LABEL_WIDTH - displayWidth(full));
  return `${color}${full}${A.reset}${' '.repeat(pad)}`;
}

// ── Render ────────────────────────────────────────────────────

function render(data) {
  const cwd       = data.cwd || process.cwd();
  const sessionId = data.session_id || '';
  const ctxPct    = data.context_window?.used_percentage ?? null;

  let rl = data.rate_limits;
  const hasLive = rl && (rl.five_hour || rl.seven_day);
  if (hasLive) {
    saveRateLimitsCache(rl);
  } else {
    rl = loadRateLimitsCache() || {};
  }

  const fiveH    = rl.five_hour  || {};
  const sevenD   = rl.seven_day  || {};
  const fivePct  = fiveH.used_percentage  ?? 0;
  const sevenPct = sevenD.used_percentage ?? 0;

  const envName = currentEnvName();
  const envDir  = findEnvDir(envName);
  const branch  = gitBranch(cwd);
  const dirty   = branch ? gitDirtyCount(cwd) : 0;
  const memDir  = findMemoryDir(envDir, cwd);

  const rows = [];

  // ── 📁 project
  const branchTag = branch
    ? `${A.bold}${A.green}${branch}${dirty ? ` ${A.yellow}(${dirty})` : ''}${A.reset}`
    : '';
  rows.push(
    lbl('project') +
    `${A.white}${shortenCwd(cwd)}${A.reset}` +
    (branchTag ? `  ${branchTag}` : '')
  );

  // ── 💬 session
  if (sessionId) {
    const ctxTag = ctxPct != null
      ? `  ${A.gray}│${A.reset}  ${A.dim}ctx${A.reset} ${A.bold}${colorPct(ctxPct)}${ctxPct}%${A.reset}`
      : '';
    rows.push(lbl('session') + `${A.gray}${sessionId}${A.reset}` + ctxTag);
  }

  // ── 📊 usage: 5h │ 7d side by side
  {
    const c5 = colorPct(fivePct);
    const c7 = colorPct(sevenPct);
    const fiveReset  = fiveH.resets_at  ? ` ${A.gray}↺ ${resetTimeStr(fiveH.resets_at)}${A.reset}`  : '';
    const sevenReset = sevenD.resets_at ? ` ${A.gray}↺ ${resetTimeStr(sevenD.resets_at)}${A.reset}` : '';
    const fiveStr  = `${A.dim}5h${A.reset} ${A.bold}${c5}${quotaBar(fivePct)}${A.reset} ${A.bold}${c5}${fivePct}%${A.reset}${fiveReset}`;
    const sevenStr = `${A.dim}7d${A.reset} ${A.bold}${c7}${quotaBar(sevenPct)}${A.reset} ${A.bold}${c7}${sevenPct}%${A.reset}${sevenReset}`;
    rows.push(lbl('usage') + fiveStr + `   ${A.gray}│${A.reset}   ` + sevenStr);
  }

  // ── 🪐 env
  if (envName) {
    const nameTag = `${A.bold}${A.cyan}${envName}${A.reset}`;
    const pathTag = envDir ? `  ${A.gray}│${A.reset}  ${A.gray}${homeShortenPath(envDir)}${A.reset}` : '';
    rows.push(lbl('env') + nameTag + pathTag);
  }

  // ── 🧠 mem
  if (memDir) {
    rows.push(lbl('mem') + `${A.gray}${shortenMemPath(memDir)}${A.reset}`);
  }

  return rows.join('\n') + '\n';
}
