#!/usr/bin/env node
// Checks the repo against what the take-home is graded on (CLAUDE.md).
//   node tools/invariants-audit.mjs            hard violations only (safe from day one; part of ci:quality)
//   node tools/invariants-audit.mjs --strict   + the submission gate: graded specs and test names,
//                                              README sections, one-command local run
// Exit 1 on findings. `progress(root)` feeds the session-start hook.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { hardRuleFindings, moneyFindings } from './harness/hook-rules.mjs';

export const SPECS = [
  'capacity.concurrency.spec.ts',
  'idempotency.spec.ts',
  'reconciliation.spec.ts',
  'currency.spec.ts',
  'auth.spec.ts',
  'validation.spec.ts',
  'availability.ledger.spec.ts',
];

// The five tests that must exist (CLAUDE.md "Tests"), matched loosely on the test title.
export const MUST_HAVE = [
  [
    'capacity.concurrency.spec.ts',
    /concurrent reservations.*exactly one is rejected/i,
    'N concurrent reservations … exactly one is rejected and the sum never exceeds the limit',
  ],
  [
    'idempotency.spec.ts',
    /same Idempotency-Key returns the original result/i,
    'the same Idempotency-Key returns the original result',
  ],
  ['idempotency.spec.ts', /same Kafka message is applied once/i, 'the same Kafka message is applied once'],
  [
    'reconciliation.spec.ts',
    /older snapshot does not roll the state back/i,
    'an older snapshot does not roll the state back',
  ],
  [
    'reconciliation.spec.ts',
    /snapshot does not wipe local active reservations/i,
    'a snapshot does not wipe local active reservations',
  ],
  [
    'currency.spec.ts',
    /rate A.*rate (moves to )?B.*exactly its starting value/i,
    'reserving at rate A and releasing after the rate moves to B returns availability to exactly its starting value',
  ],
];

// Specs beyond the brief's seven that the delivery needs (ingrid-style docs contract).
export const EXTRA_SPECS = ['docs.contract.spec.ts'];

// The API surface, exactly: the brief's four operations. Path parameter names are free.
export const OPERATIONS = [
  'post /programs/{}/reservations',
  'get /programs/{}/reservations',
  'post /reservations/{}/release',
  'get /programs/{}/availability',
];

export const README_SECTIONS = [
  'Quick start',
  'API',
  'How it works',
  'Behaviour decisions',
  'Assumptions and trade-offs',
  'Limitations and next steps',
];

const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', '.claude', 'tools', 'docs']);

function walk(root, dir = root, out = []) {
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(root, p, out);
    } else {
      out.push(relative(root, p).split('\\').join('/'));
    }
  }
  return out;
}

const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');

export function progress(root) {
  const missingSpecs = SPECS.filter((s) => !existsSync(join(root, 'test', s)));
  const migrations = existsSync(join(root, 'migrations'))
    ? readdirSync(join(root, 'migrations'))
        .map((f) => read(root, `migrations/${f}`))
        .join('\n')
    : '';
  const readme = read(root, 'README.md');
  const steps = [
    ['domain model and ledger (migrations with ledger_entries)', /ledger_entries/.test(migrations)],
    ['concurrency guard with test/capacity.concurrency.spec.ts', !missingSpecs.includes(SPECS[0])],
    ['API with auth (test/auth.spec.ts)', !missingSpecs.includes('auth.spec.ts')],
    ['idempotency (test/idempotency.spec.ts)', !missingSpecs.includes('idempotency.spec.ts')],
    ['Kafka consumer (src/treasury/)', existsSync(join(root, 'src/treasury'))],
    ['reconciliation (test/reconciliation.spec.ts)', !missingSpecs.includes('reconciliation.spec.ts')],
    ['currency (test/currency.spec.ts)', !missingSpecs.includes('currency.spec.ts')],
    ['README polish (all six sections)', README_SECTIONS.every((s) => readme.includes(`## ${s}`))],
  ];
  const next = steps.find(([, done]) => !done);
  return {
    specsTotal: SPECS.length,
    specsPresent: SPECS.length - missingSpecs.length,
    missingSpecs,
    nextStep: next ? next[0] : 'all steps present: run the submission-check skill',
  };
}

export function auditInvariants(root, { strict = false } = {}) {
  const findings = [];
  const add = (file, message) => findings.push({ file, message });

  // Hard rules, always: the same rules the hooks enforce, over the whole tree.
  for (const rel of walk(root)) {
    if (!/\.(ts|sql)$/.test(rel)) {
      continue;
    }
    const text = read(root, rel);
    for (const f of [...hardRuleFindings(rel, text), ...moneyFindings(rel, '', text)]) {
      add(rel, `[${f.rule}] ${f.message}`);
    }
  }
  if (!strict) {
    return findings;
  }

  // Submission gate.
  for (const s of SPECS) {
    if (!existsSync(join(root, 'test', s))) {
      add(`test/${s}`, 'graded spec file missing');
    }
  }
  for (const [file, re, title] of MUST_HAVE) {
    if (!re.test(read(root, `test/${file}`))) {
      add(`test/${file}`, `must-have test missing: "${title}"`);
    }
  }
  const readme = read(root, 'README.md');
  const at = README_SECTIONS.map((s) => readme.indexOf(`## ${s}`));
  README_SECTIONS.forEach((s, i) => at[i] < 0 && add('README.md', `section "## ${s}" missing`));
  const present = at.filter((i) => i >= 0);
  if (present.some((v, i) => i > 0 && v < present[i - 1])) {
    add('README.md', `sections out of order; expected: ${README_SECTIONS.join(' → ')}`);
  }
  for (const phrase of [/at-least-once/i, /exactly-once/i, /fixing policy/i, /Redpanda/]) {
    if (!phrase.test(readme)) {
      add('README.md', `expected the README to cover ${phrase} (CLAUDE.md asks for it)`);
    }
  }
  for (const s of EXTRA_SPECS) {
    if (!existsSync(join(root, 'test', s))) {
      add(`test/${s}`, 'docs contract spec missing (api-docs skill)');
    }
  }
  for (const f of docsFindings(root)) {
    add(f.file, f.message);
  }
  for (const f of readmeTableFindings(root, readme)) {
    add('README.md', f);
  }
  if (!/\/docs\b/.test(readme)) {
    add('README.md', 'Quick start should say where Swagger UI is (/docs) and how to log in with the token');
  }
  const ci = read(root, '.github/workflows/ci.yml');
  if (!/CI passed/.test(ci)) {
    add('.github/workflows/ci.yml', 'missing, or no aggregated "CI passed" job (ci-pipeline skill)');
  }
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    .map((f) => read(root, f))
    .join('\n');
  if (!compose) {
    add('docker-compose.yml', 'missing: `docker compose up` must start everything');
  } else {
    for (const svc of [/postgres/i, /redpanda/i, /build:/]) {
      if (!svc.test(compose)) {
        add('docker-compose.yml', `expected ${svc} (Postgres, Redpanda and the service itself)`);
      }
    }
  }
  if (!existsSync(join(root, 'migrations')) || !readdirSync(join(root, 'migrations')).length) {
    add('migrations/', 'no migration files');
  }
  if (!existsSync(join(root, '.env.example'))) {
    add('.env.example', 'missing: names of every env var, no secrets');
  }
  if (!/"token"\s*:/.test(read(root, 'package.json'))) {
    add('package.json', 'no `token` script: a reviewer needs `pnpm run token` to mint a JWT');
  }
  return findings;
}

// The exported OpenAPI document: exactly the four operations, all behind the JWT, versioned from package.json.
export function docsFindings(root) {
  const f = [];
  const add = (message) => f.push({ file: 'docs/api/openapi.json', message });
  const raw = read(root, 'docs/api/openapi.json');
  if (!raw) {
    add('missing: run `pnpm run docs:export` (api-docs skill)');
    return f;
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    add(`invalid JSON: ${e.message}`);
    return f;
  }
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        continue;
      }
      const key = `${method} ${path.replace(/\{[^}]+\}/g, '{}')}`;
      ops.push(key);
      const secured = (op.security ?? spec.security ?? []).some((req) => Object.keys(req).length > 0);
      if (!secured) {
        add(`\`${key}\` has no security requirement: every endpoint needs the JWT`);
      }
    }
  }
  const extra = ops.filter((o) => !OPERATIONS.includes(o));
  const missing = OPERATIONS.filter((o) => !ops.includes(o));
  if (extra.length) {
    add(`operations beyond the brief's four (ask the user first): ${extra.join(', ')}`);
  }
  if (missing.length) {
    add(`operations missing from the spec: ${missing.join(', ')}`);
  }
  const schemes = Object.values(spec.components?.securitySchemes ?? {});
  if (!schemes.some((s) => s.type === 'http' && s.scheme === 'bearer')) {
    add('no http bearer security scheme');
  }
  const pkg = read(root, 'package.json');
  const version = pkg ? JSON.parse(pkg).version : undefined;
  if (version && spec.info?.version !== version) {
    add(`info.version "${spec.info?.version}" is not package.json's "${version}": re-export`);
  }
  for (const s of ['docs:export', 'docs:check', 'docs:lint']) {
    if (!new RegExp(`"${s}"\\s*:`).test(pkg)) {
      add(`package.json has no \`${s}\` script`);
    }
  }
  return f;
}

// ingrid's readme.test: the Scripts table lists every package.json script and no others; the
// Environment table lists every .env.example variable and no others.
const tableNames = (readme, heading) => {
  const section = readme.split(heading)[1]?.split(/\n#{2,3} /)[0] ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''));
};

export function readmeTableFindings(root, readme) {
  const f = [];
  const pkg = read(root, 'package.json');
  const scripts = pkg ? Object.keys(JSON.parse(pkg).scripts ?? {}) : [];
  const listed = tableNames(readme, '### Scripts');
  const missing = scripts.filter((s) => !listed.includes(s));
  const stale = listed.filter((s) => !scripts.includes(s));
  if (missing.length) {
    f.push(`### Scripts table misses: ${missing.join(', ')}`);
  }
  if (stale.length) {
    f.push(`### Scripts table lists scripts that do not exist: ${stale.join(', ')}`);
  }
  const env = [...read(root, '.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const envListed = tableNames(readme, '### Environment');
  const envMissing = env.filter((v) => !envListed.includes(v));
  const envStale = envListed.filter((v) => !env.includes(v));
  if (envMissing.length) {
    f.push(`### Environment table misses: ${envMissing.join(', ')}`);
  }
  if (envStale.length) {
    f.push(`### Environment table lists variables not in .env.example: ${envStale.join(', ')}`);
  }
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const k = process.argv.indexOf('--root');
  const root = resolve(k > 0 ? process.argv[k + 1] : process.cwd());
  const strict = process.argv.includes('--strict');
  const findings = auditInvariants(root, { strict });
  for (const f of findings) {
    console.log(`${f.file}: ${f.message}`);
  }
  const p = progress(root);
  console.log(`\nspecs ${p.specsPresent}/${p.specsTotal}; next: ${p.nextStep}`);
  const name = strict ? 'audit:submission' : 'audit:invariants';
  console.log(findings.length ? `${name}: ${findings.length} finding(s)` : `${name}: clean`);
  process.exit(findings.length ? 1 : 0);
}
