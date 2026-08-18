#!/usr/bin/env node
'use strict';

// Stable entry point installed once per account (`<CLAUDE_DIR>/statusline.js`,
// referenced by that account's `settings.json`). It never has to change again:
// on every render it re-resolves which workspace the account is *currently*
// pinned to (via `orrery-bin _workspace-dir`) and hands off to that
// workspace's shared `statusline.js`, so `orrery pin <account> --workspace
// <name>` takes effect immediately without re-running `orrery thirdparty
// install statusline`.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function readPinnedWorkspace() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'metadata.json'), 'utf8'));
    if (typeof meta.workspace === 'string' && meta.workspace) return meta.workspace;
  } catch {}
  return 'origin';
}

function resolveWorkspaceStatusline() {
  const workspace = readPinnedWorkspace();
  let dir;
  try {
    dir = execFileSync('orrery-bin', ['_workspace-dir', workspace, '--claude'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
  if (!dir) return null;
  const target = path.join(dir, 'statusline.js');
  return fs.existsSync(target) ? target : null;
}

const target = resolveWorkspaceStatusline();
if (!target) {
  // Degrade to a blank statusline rather than crash Claude Code's renderer —
  // same philosophy as the real script's own "omit rows with no data".
  process.exit(0);
}

try {
  execFileSync('node', [target], { stdio: 'inherit' });
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
