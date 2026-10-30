#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): Prettier on the edited file, block new float/number money,
// and give each invariant reminder once per session.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { moneyFindings, remindersFor } from '../../tools/harness/hook-rules.mjs';

const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
const root = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
const file = payload.tool_input?.file_path;
if (!file || !existsSync(file)) {
  process.exit(0);
}
const rel = relative(root, resolve(root, file)).split('\\').join('/');
if (rel.startsWith('..') || rel.startsWith('.claude/worktrees/')) {
  process.exit(0);
}

// 1. Format, so the format check in ci:quality never fails on Claude's output.
const prettier = join(root, 'node_modules/.bin/prettier');
if (/\.(ts|js|mjs|cjs|json|md|ya?ml)$/.test(rel) && existsSync(prettier)) {
  try {
    execFileSync(prettier, ['--write', '--log-level', 'warn', file], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    // syntax errors surface in typecheck; don't block here
  }
}

// 2. New float / number money.
const input = payload.tool_input ?? {};
let before;
let after;
if (payload.tool_name === 'Write') {
  try {
    before = execFileSync('git', ['show', `HEAD:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    before = '';
  }
  after = input.content ?? '';
} else {
  const edits = payload.tool_name === 'MultiEdit' ? (input.edits ?? []) : [input];
  before = edits.map((e) => e.old_string ?? '').join('\n');
  after = edits.map((e) => e.new_string ?? '').join('\n');
}
const problems = moneyFindings(rel, before, after).map((f) => `${rel} [${f.rule}] ${f.message}`);

// 3. Reminders, once per session per topic.
const dir = join(tmpdir(), 'program-capacity-claude-hooks');
const seenFile = join(dir, `${payload.session_id ?? 'none'}.json`);
let seen = [];
try {
  seen = JSON.parse(readFileSync(seenFile, 'utf8'));
} catch {
  // first reminder of the session
}
const fresh = remindersFor(rel).filter((r) => !seen.includes(r.id));
if (fresh.length) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(seenFile, JSON.stringify([...seen, ...fresh.map((r) => r.id)]));
  } catch {
    // reminders may repeat; harmless
  }
}

const out = {};
if (problems.length) {
  out.decision = 'block';
  out.reason = `Fix before moving on (.claude/hooks/post-edit.mjs):\n${problems.join('\n')}`;
}
if (fresh.length) {
  out.hookSpecificOutput = {
    hookEventName: 'PostToolUse',
    additionalContext: fresh.map((r) => `Reminder (${r.id}): ${r.message}`).join('\n'),
  };
}
if (Object.keys(out).length) {
  process.stdout.write(JSON.stringify(out));
}
