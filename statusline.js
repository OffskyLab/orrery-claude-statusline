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
// Persists the last known rate_limits so the statusline shows
// real data immediately on startup, before the first API call.

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

function shortenPath(p) {
  const home = os.homedir();
  const s = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  const parts = s.split('/');
  return parts.length > 5 ? '…/' + parts.slice(-4).join('/') : s;
}

function quotaBar(pct, width = 8) {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Absolute reset time: "18:30 +0800" (same day) or "Apr 23 14:00 +0800" (different day)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function tzOffset() {
  const off = -new Date().getTimezoneOffset(); // minutes, positive = east
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
  const tz = tzOffset();
  const time = `${hh}:${mm} ${tz}`;
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

// ── ANSI ──────────────────────────────────────────────────────

const A = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  gray:    '\x1b[90m',
};

function colorPct(pct) {
  if (pct < 50) return A.green;
  if (pct < 80) return A.yellow;
  return A.red;
}

function lbl(s) {
  return `${A.dim}${s.padEnd(5)}${A.reset}`;
}

// ── Render ────────────────────────────────────────────────────

function render(data) {
  const cwd = data.cwd || process.cwd();

  // Use live rate_limits if present; fall back to cache; save when live data arrives.
  let rl = data.rate_limits;
  const hasLive = rl && (rl.five_hour || rl.seven_day);
  if (hasLive) {
    saveRateLimitsCache(rl);
  } else {
    rl = loadRateLimitsCache() || {};
  }

  const fiveH   = rl.five_hour  || {};
  const sevenD  = rl.seven_day  || {};
  const fivePct  = fiveH.used_percentage  ?? 0;
  const sevenPct = sevenD.used_percentage ?? 0;

  const envName = currentEnvName();
  const envDir  = findEnvDir(envName);
  const branch  = gitBranch(cwd);
  const dirty   = branch ? gitDirtyCount(cwd) : 0;
  const memDir  = findMemoryDir(envDir, cwd);

  const rows = [];

  // ── Row 1: env  dir  branch
  const envTag = envName
    ? `${A.cyan}${A.bold}${envName}${A.reset}`
    : `${A.gray}(no env)${A.reset}`;
  const cwdTag = `${A.gray}${shortenPath(cwd)}${A.reset}`;
  const branchTag = branch
    ? `  ${A.green}${branch}${dirty ? `${A.reset} ${A.yellow}(${dirty})` : ''}${A.reset}`
    : '';
  rows.push(lbl('env') + envTag + '  ' + cwdTag + branchTag);

  // ── Row 2: 5h and 7d side by side
  {
    const c5 = colorPct(fivePct);
    const c7 = colorPct(sevenPct);

    const fiveReset  = fiveH.resets_at  ? ` ${A.gray}↺ ${resetTimeStr(fiveH.resets_at)}${A.reset}`  : '';
    const sevenReset = sevenD.resets_at ? ` ${A.gray}↺ ${resetTimeStr(sevenD.resets_at)}${A.reset}` : '';

    const fiveStr  = `${A.dim}5h${A.reset} ${c5}${quotaBar(fivePct)}${A.reset} ${c5}${fivePct}%${A.reset}${fiveReset}`;
    const sevenStr = `${A.dim}7d${A.reset} ${c7}${quotaBar(sevenPct)}${A.reset} ${c7}${sevenPct}%${A.reset}${sevenReset}`;

    rows.push(lbl('') + fiveStr + `   ${A.gray}│${A.reset}   ` + sevenStr);
  }

  // ── Row 3: env path
  if (envDir) {
    rows.push(lbl('path') + `${A.gray}${shortenPath(envDir)}${A.reset}`);
  }

  // ── Row 4: memory path
  if (memDir) {
    rows.push(lbl('mem') + `${A.gray}${shortenPath(memDir)}${A.reset}`);
  }

  return rows.join('\n') + '\n';
}
