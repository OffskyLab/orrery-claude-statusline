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
  // Claude Code project key: replace all '/' with '-'
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
  // keep last 4 segments; if trimmed, prepend '…/'
  return parts.length > 5 ? '…/' + parts.slice(-4).join('/') : s;
}

function quotaBar(pct, width = 8) {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function countdown(resetsAt) {
  if (!resetsAt) return '';
  const diff = resetsAt * 1000 - Date.now();
  if (diff <= 0) return 'reset';
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
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
  const cwd     = data.cwd || process.cwd();
  const rl      = data.rate_limits || {};
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

  // ── env  +  dir  +  branch
  const envTag = envName
    ? `${A.cyan}${A.bold}${envName}${A.reset}`
    : `${A.gray}(no env)${A.reset}`;
  const cwdTag = `${A.gray}${shortenPath(cwd)}${A.reset}`;
  const branchTag = branch
    ? `  ${A.green}${branch}${dirty ? `${A.reset} ${A.yellow}(${dirty})` : ''}${A.reset}`
    : '';
  rows.push(lbl('env') + envTag + '  ' + cwdTag + branchTag);

  // ── 5h quota
  {
    const c = colorPct(fivePct);
    const reset = fiveH.resets_at
      ? `  ${A.gray}resets ${countdown(fiveH.resets_at)}${A.reset}`
      : '';
    rows.push(lbl('5h') + `${c}${quotaBar(fivePct)}${A.reset} ${c}${fivePct}%${A.reset}` + reset);
  }

  // ── 7d quota
  {
    const c = colorPct(sevenPct);
    const reset = sevenD.resets_at
      ? `  ${A.gray}resets ${countdown(sevenD.resets_at)}${A.reset}`
      : '';
    rows.push(lbl('7d') + `${c}${quotaBar(sevenPct)}${A.reset} ${c}${sevenPct}%${A.reset}` + reset);
  }

  // ── env path
  if (envDir) {
    rows.push(lbl('path') + `${A.gray}${shortenPath(envDir)}${A.reset}`);
  }

  // ── memory path
  if (memDir) {
    rows.push(lbl('mem') + `${A.gray}${shortenPath(memDir)}${A.reset}`);
  }

  return rows.join('\n') + '\n';
}
