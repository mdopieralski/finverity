import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditHarness } from '../harness-audit.mjs';
import {
  auditInvariants,
  docsFindings,
  EXTRA_SPECS,
  MUST_HAVE,
  progress,
  README_SECTIONS,
  readmeTableFindings,
  SPECS,
} from '../invariants-audit.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'capacity-audit-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

test('this repo’s harness is clean', () => {
  assert.deepEqual(auditHarness(repo), []);
});

test('this repo has no hard invariant violations', () => {
  assert.deepEqual(auditInvariants(repo), []);
});

test('harness audit catches a mismatched name and unknown skills', () => {
  const root = fixture({
    '.claude/agents/a.md':
      '---\nname: b\ndescription: An agent that does a fairly specific job in this repository.\n---\nUse the `ghost` skill.\n',
  });
  const msgs = auditHarness(root).map((f) => f.message);
  assert.ok(msgs.some((m) => m.includes('does not match')));
  assert.ok(msgs.some((m) => m.includes('unknown skill "ghost"')));
});

test('invariants audit: hard rules found anywhere in src and migrations', () => {
  const root = fixture({
    'src/app.module.ts': 'TypeOrmModule.forRoot({ synchronize: true })',
    'src/capacity/repo.ts': "await q('DELETE FROM ledger_entries WHERE id = $1')",
    'migrations/001.sql': 'create table t (amount double precision)',
  });
  const msgs = auditInvariants(root).map((f) => f.message);
  assert.ok(msgs.some((m) => m.includes('[no-synchronize]')));
  assert.ok(msgs.some((m) => m.includes('[ledger-append-only]')));
  assert.ok(msgs.some((m) => m.includes('[money-column]')));
});

test('invariants audit --strict: an empty repo lists every gap', () => {
  const msgs = auditInvariants(fixture({ 'x.txt': '' }), { strict: true }).map(
    (f) => `${f.file} ${f.message}`
  );
  for (const s of SPECS) {
    assert.ok(
      msgs.some((m) => m.startsWith(`test/${s} graded spec file missing`)),
      s
    );
  }
  assert.ok(msgs.some((m) => m.includes('docker-compose.yml')));
  assert.ok(msgs.some((m) => m.includes('`token` script')));
});

const PKG_SCRIPTS = { token: 'x', 'docs:export': 'x', 'docs:check': 'x', 'docs:lint': 'x' };
const op = { security: [{ jwt: [] }], responses: {} };
const validSpec = {
  openapi: '3.0.0',
  info: { title: 't', version: '1.0.0' },
  components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/programs/{id}/reservations': { post: op, get: op },
    '/reservations/{id}/release': { post: op },
    '/programs/{programId}/availability': { get: op },
  },
};

test('invariants audit --strict: a complete repo passes', () => {
  const files = Object.fromEntries(
    [...SPECS, ...EXTRA_SPECS].map((s) => [`test/${s}`, "describe('x', () => {})"])
  );
  for (const [file, , title] of MUST_HAVE) {
    files[`test/${file}`] += `\nit('${title.replace('…', 'fit N-1 →')}', async () => {});`;
  }
  files['README.md'] =
    README_SECTIONS.map((s) => `## ${s}\n`).join('\n') +
    'Kafka is at-least-once; exactly-once by consumer dedup. Fixing policy is business. Redpanda. Swagger at /docs.\n' +
    '### Environment\n| Variable | Default |\n| `JWT_SECRET` | dev |\n' +
    '### Scripts\n| Name | What |\n| `token` / `docs:export` | x |\n| `docs:check` / `docs:lint` | x |\n';
  files['.github/workflows/ci.yml'] = 'jobs:\n  ci-passed:\n    name: CI passed\n';
  files['docs/api/openapi.json'] = JSON.stringify(validSpec);
  files['docker-compose.yml'] = 'services:\n  postgres: {}\n  redpanda: {}\n  api:\n    build: .\n';
  files['migrations/001_init.sql'] = 'create table ledger_entries (amount_minor bigint)';
  files['.env.example'] = 'JWT_SECRET=';
  files['package.json'] = JSON.stringify({ version: '1.0.0', scripts: PKG_SCRIPTS });
  assert.deepEqual(auditInvariants(fixture(files), { strict: true }), []);
});

test('progress names the next step in the working order', () => {
  assert.match(progress(fixture({ 'x.txt': '' })).nextStep, /domain model and ledger/);
  const p = progress(fixture({ 'migrations/001.sql': 'create table ledger_entries ()' }));
  assert.match(p.nextStep, /concurrency guard/);
  assert.equal(p.specsPresent, 0);
});

test('docs: extra operations, unsecured operations and a stale version are found', () => {
  const spec = structuredClone(validSpec);
  spec.paths['/health'] = { get: { responses: {} } };
  spec.info.version = '0.9.0';
  const root = fixture({
    'docs/api/openapi.json': JSON.stringify(spec),
    'package.json': JSON.stringify({ version: '1.0.0', scripts: PKG_SCRIPTS }),
  });
  const msgs = docsFindings(root).map((f) => f.message);
  assert.ok(msgs.some((m) => m.includes('beyond the brief')));
  assert.ok(msgs.some((m) => m.includes('no security requirement')));
  assert.ok(msgs.some((m) => m.includes('info.version')));
});

test('README tables must match package.json scripts and .env.example', () => {
  const root = fixture({
    'package.json': JSON.stringify({ scripts: { build: 'x', token: 'x' } }),
    '.env.example': 'JWT_SECRET=dev\nDATABASE_URL=postgres://\n',
  });
  const readme =
    '### Scripts\n| Name | What |\n| `build` / `gone` | x |\n\n### Environment\n| `JWT_SECRET` | dev |\n';
  const msgs = readmeTableFindings(root, readme);
  assert.ok(msgs.some((m) => m.includes('misses: token')));
  assert.ok(msgs.some((m) => m.includes('do not exist: gone')));
  assert.ok(msgs.some((m) => m.includes('Environment table misses: DATABASE_URL')));
});
