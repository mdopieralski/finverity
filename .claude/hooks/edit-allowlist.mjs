#!/usr/bin/env node
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit), wired in an agent's frontmatter:
//   edit-allowlist.mjs --allow docs/product/,docs/services/ --ask apps/pwa/messages/
// --allow passes, --ask needs the user's OK, everything else is denied. Trailing `/` = folder.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { editAllowed } from '../../tools/harness/hook-rules.mjs';

const arg = (flag) => {
  const k = process.argv.indexOf(flag);
  return k > 0 ? (process.argv[k + 1] ?? '').split(',').filter(Boolean) : [];
};
const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? '';
const roots = [payload.cwd, process.env.CLAUDE_PROJECT_DIR].filter(Boolean);
const abs = isAbsolute(file) ? file : resolve(roots[0] ?? process.cwd(), file);
const rel =
  roots
    .map((r) => relative(r, abs).split('\\').join('/'))
    .find((p) => p && !p.startsWith('..'))
    ?.replace(/^\.claude\/worktrees\/[^/]+\//, '') ?? '';

const decide = (decision, reason) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: `.claude/hooks/edit-allowlist.mjs: ${reason}`,
      },
    })
  );

if (editAllowed(rel, arg('--allow'))) {
  process.exit(0);
}
if (editAllowed(rel, arg('--ask'))) {
  decide('ask', `\`${rel}\` is outside this agent's own files; the user agrees to each change here.`);
} else {
  decide(
    'deny',
    `this agent may edit only ${[...arg('--allow'), ...arg('--ask')].join(', ')}; \`${rel || file}\` belongs to another owner. Report the change you want instead (ownership map: add-feature skill).`
  );
}
