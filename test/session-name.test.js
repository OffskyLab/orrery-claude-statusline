'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-statusline-name-'));
process.env.CLAUDE_CONFIG_DIR = TMP;
process.env.LANG = 'en_US.UTF-8';
delete process.env.ORRERY_ACTIVE_ENV;

const { render } = require('../statusline.js');
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const noRefresh = { refresh: () => {} };

function transcript(lines) {
  const p = path.join(fs.mkdtempSync(path.join(TMP, 't-')), 's.jsonl');
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
function sessionRow(input) {
  return strip(render({ cwd: TMP, session_id: 'sess-1', ...input }, noRefresh))
    .split('\n').find(l => l.startsWith('◎'));
}

test('shows the ai-title before the session id', () => {
  const p = transcript([
    { type: 'ai-title', aiTitle: 'Old title' },
    { type: 'user', message: 'hi' },
    { type: 'ai-title', aiTitle: 'List session names' },
  ]);
  assert.match(sessionRow({ transcript_path: p }), /List session names\s+sess-1$/);
});

test('a /rename custom-title wins over the ai-title', () => {
  const p = transcript([
    { type: 'custom-title', customTitle: 'My rename' },
    { type: 'ai-title', aiTitle: 'Auto title' },
  ]);
  assert.match(sessionRow({ transcript_path: p }), /My rename\s+sess-1$/);
});

test('session_name from stdin takes precedence', () => {
  const p = transcript([{ type: 'custom-title', customTitle: 'From transcript' }]);
  assert.match(sessionRow({ transcript_path: p, session_name: 'From stdin' }), /From stdin\s+sess-1$/);
});

test('no title: just the session id', () => {
  const p = transcript([{ type: 'user', message: 'hi' }]);
  assert.match(sessionRow({ transcript_path: p }), /Session\s+sess-1$/);
});

function writePeer(pid, obj) {
  const dir = path.join(TMP, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(obj));
}

test('shows the peer (SendMessage) name after the title', () => {
  writePeer(111, { sessionId: 'other', name: 'not-me' });
  writePeer(222, { sessionId: 'sess-peer', name: 'repo-d4', nameSource: 'derived' });
  const p = transcript([{ type: 'ai-title', aiTitle: 'Auto title' }]);
  const row = strip(render({ cwd: TMP, session_id: 'sess-peer', transcript_path: p }, noRefresh))
    .split('\n').find(l => l.startsWith('◎'));
  assert.match(row, /Auto title\s+@repo-d4\s+sess-peer$/);
});

test('a renamed session shows its name once, as the peer address', () => {
  writePeer(333, { sessionId: 'sess-renamed', name: 'My rename', nameSource: 'user' });
  const p = transcript([{ type: 'custom-title', customTitle: 'My rename' }]);
  const row = strip(render({ cwd: TMP, session_id: 'sess-renamed', transcript_path: p }, noRefresh))
    .split('\n').find(l => l.startsWith('◎'));
  assert.match(row, /Session\s+@My rename\s+sess-renamed$/);
});
