#!/usr/bin/env node
// PreToolUse (Edit|Write|MultiEdit): deny edits that break a hard rule before they land.
// Rules: tools/harness/hook-rules.mjs (unit-tested); this file only does I/O.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { isCommitted } from '../../tools/harness/git-context.mjs';
import {
  contentAfter,
  hardRuleFindings,
  migrationFindings,
  protectedFileFindings,
} from '../../tools/harness/hook-rules.mjs';

const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
const root = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
const file = payload.tool_input?.file_path;
if (!file) {
  process.exit(0);
}
const rel = relative(root, resolve(root, file)).split('\\').join('/');
if (rel.startsWith('..') || rel.startsWith('.claude/worktrees/')) {
  process.exit(0);
}
const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
const after = contentAfter(payload.tool_name, payload.tool_input ?? {}, before);
const findings = [
  ...protectedFileFindings(rel),
  ...migrationFindings(rel, { committed: /^migrations\//.test(rel) && isCommitted(root, rel) }),
  ...hardRuleFindings(rel, after),
];
if (findings.length) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked by .claude/hooks/pre-edit.mjs:\n${findings.map((f) => `[${f.rule}] ${f.message}`).join('\n')}`,
      },
    })
  );
}
