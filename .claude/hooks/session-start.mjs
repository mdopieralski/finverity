#!/usr/bin/env node
// SessionStart: where we stand (branch, dirty tree, which graded specs exist, next step in the
// working order). stdout = context.
import { readFileSync } from 'node:fs';

import { gitContext } from '../../tools/harness/git-context.mjs';
import { progress } from '../../tools/invariants-audit.mjs';

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  // no payload: still print what we know
}
const root = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();
const { branch, dirty } = gitContext(root);
const p = progress(root);

const lines = ['Program capacity & invoice reservation take-home (NestJS, PostgreSQL, Redpanda/Kafka).'];
if (branch === undefined) {
  lines.push('Not a git repository yet: ask the user before `git init` (ship-branch skill).');
} else if (branch) {
  lines.push(
    `On \`${branch}\`.${branch === 'main' ? ' Cut a feat/<area> branch before changing code.' : ''}`
  );
}
if (dirty) {
  lines.push(`${dirty} uncommitted path(s): may be the user's work in progress.`);
}
lines.push(
  `Graded spec files: ${p.specsPresent}/${p.specsTotal} present${p.missingSpecs.length ? ` (missing: ${p.missingSpecs.join(', ')})` : ''}.`
);
lines.push(`Next in the working order: ${p.nextStep}.`);
lines.push(
  'Graded: no oversubscription under concurrency · idempotency (HTTP + Kafka) · reconciliation ordering without wiping local reservations · convert once, release exactly. Ledger is append-only; every endpoint needs a JWT.'
);
lines.push(
  'Plan with capacity-architect, build with the add-feature skill, prove with verify-change, ship with ship-branch.'
);
process.stdout.write(`${lines.join('\n')}\n`);
