#!/usr/bin/env node
// PreToolUse (Bash): pnpm only, no hook skipping, no force-push or push to main, confirm merges,
// public repos and volume wipes. deny = Claude changes course; ask = the user confirms.
import { readFileSync } from 'node:fs';

import { gitContext } from '../../tools/harness/git-context.mjs';
import { bashFindings } from '../../tools/harness/hook-rules.mjs';

const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
const command = payload.tool_input?.command ?? '';
if (!/\b(git|gh|npm|npx|yarn|bun|docker)\b/.test(command)) {
  process.exit(0);
}
const root = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
const findings = bashFindings(command, gitContext(root));
if (findings.length) {
  const decision = findings.some((f) => f.decision === 'deny') ? 'deny' : 'ask';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: `.claude/hooks/pre-bash.mjs:\n${findings
          .filter((f) => f.decision === decision)
          .map((f) => `[${f.rule}] ${f.message}`)
          .join('\n')}`,
      },
    })
  );
}
