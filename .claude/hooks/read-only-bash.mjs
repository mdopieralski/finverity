#!/usr/bin/env node
// PreToolUse (Bash), wired in an agent's frontmatter.
//   read-only-bash.mjs                     reviewers and planners: no file writes, git writes, installs or inline code
//   read-only-bash.mjs --allow docs/x/,…   agents with an edit allow-list: redirects into those paths, and
//                                          branch / commit / push / open a PR
import { readFileSync } from 'node:fs';

import { readOnlyBashFindings } from '../../tools/harness/hook-rules.mjs';

const k = process.argv.indexOf('--allow');
const writable = k > 0 ? (process.argv[k + 1] ?? '').split(',').filter(Boolean) : null;
const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
const findings = readOnlyBashFindings(payload.tool_input?.command ?? '', { writable });
if (findings.length) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `.claude/hooks/read-only-bash.mjs:\n${findings.map((f) => `[${f.rule}] ${f.message}`).join('\n')}`,
      },
    })
  );
}
