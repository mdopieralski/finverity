import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bashFindings,
  contentAfter,
  editAllowed,
  hardRuleFindings,
  migrationFindings,
  moneyFindings,
  protectedFileFindings,
  readOnlyBashFindings,
  remindersFor,
} from '../harness/hook-rules.mjs';

const rules = (fs) => fs.map((f) => f.rule);

test('protected files', () => {
  assert.deepEqual(rules(protectedFileFindings('pnpm-lock.yaml')), ['protected-file']);
  assert.deepEqual(rules(protectedFileFindings('.env')), ['protected-file']);
  assert.deepEqual(rules(protectedFileFindings('.env.local')), ['protected-file']);
  assert.deepEqual(rules(protectedFileFindings('dist/main.js')), ['protected-file']);
  assert.deepEqual(rules(protectedFileFindings('docs/api/openapi.json')), ['protected-file']);
  assert.deepEqual(protectedFileFindings('.env.example'), []);
  assert.deepEqual(protectedFileFindings('src/main.ts'), []);
});

test('migrations: committed ones are immutable, new ones are fine', () => {
  assert.deepEqual(rules(migrationFindings('migrations/001_init.sql', { committed: true })), [
    'migration-immutable',
  ]);
  assert.deepEqual(migrationFindings('migrations/002_fx.sql', { committed: false }), []);
  assert.deepEqual(migrationFindings('src/app.module.ts', { committed: true }), []);
});

test('hard rules: synchronize, ledger mutation, public routes', () => {
  assert.deepEqual(rules(hardRuleFindings('src/app.module.ts', '{ synchronize: true }')), ['no-synchronize']);
  assert.deepEqual(hardRuleFindings('src/app.module.ts', '{ synchronize: false }'), []);

  for (const sql of [
    'UPDATE ledger_entries SET amount_minor = 0',
    'delete from ledger_entries where id = $1',
    'TRUNCATE ledger_entries',
  ]) {
    assert.deepEqual(
      rules(hardRuleFindings('src/capacity/ledger.repository.ts', sql)),
      ['ledger-append-only'],
      sql
    );
  }
  const trigger = 'CREATE TRIGGER no_mutation BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW …';
  assert.deepEqual(hardRuleFindings('migrations/001_init.sql', trigger), [], 'a guard trigger is allowed');
  assert.deepEqual(hardRuleFindings('test/helpers/db.ts', 'TRUNCATE ledger_entries'), [], 'test resets');
  assert.deepEqual(hardRuleFindings('src/capacity/x.ts', 'INSERT INTO ledger_entries'), []);

  assert.deepEqual(rules(hardRuleFindings('src/http/availability.controller.ts', '@Public()\n@Get()')), [
    'auth-everywhere',
  ]);
  assert.deepEqual(hardRuleFindings('CLAUDE.md', '@Public() synchronize: true'), [], 'docs name the rules');
});

test('money: number-typed amounts and float ops are blocked, only when newly added', () => {
  assert.deepEqual(rules(moneyFindings('src/capacity/types.ts', '', 'amountMinor: number;')), [
    'money-bigint',
  ]);
  assert.deepEqual(rules(moneyFindings('src/capacity/types.ts', '', 'creditLimit?: number')), [
    'money-bigint',
  ]);
  assert.deepEqual(rules(moneyFindings('src/capacity/types.ts', '', 'available_minor: number')), [
    'money-bigint',
  ]);
  assert.deepEqual(moneyFindings('src/capacity/types.ts', '', 'amountMinor: bigint;'), []);
  assert.deepEqual(
    moneyFindings('src/http/list.dto.ts', '', 'limit: number; offset: number'),
    [],
    'pagination'
  );
  assert.deepEqual(moneyFindings('src/a.ts', 'amount: number', 'amount: number // old'), [], 'already there');

  assert.deepEqual(rules(moneyFindings('src/fx/convert.ts', '', 'const x = parseFloat(rate)')), [
    'money-float',
  ]);
  assert.deepEqual(rules(moneyFindings('src/fx/convert.ts', '', 'Math.round(a * r)')), ['money-float']);
  assert.deepEqual(moneyFindings('src/fx/convert.spec.ts', '', 'parseFloat(x)'), [], 'specs exempt');

  assert.deepEqual(rules(moneyFindings('migrations/001_init.sql', '', 'amount DOUBLE PRECISION')), [
    'money-column',
  ]);
  assert.deepEqual(rules(moneyFindings('migrations/001_init.sql', '', 'amount real not null')), [
    'money-column',
  ]);
  assert.deepEqual(
    moneyFindings('migrations/001_init.sql', '', 'amount_minor BIGINT, rate NUMERIC(20,10)'),
    []
  );
  assert.deepEqual(
    moneyFindings('migrations/001_init.sql', '', '-- Money is BIGINT minor units\na BIGINT'),
    [],
    'comments'
  );
});

test('contentAfter applies Edit, MultiEdit and Write', () => {
  assert.equal(contentAfter('Write', { content: 'new' }, 'old'), 'new');
  assert.equal(contentAfter('Edit', { old_string: 'a', new_string: 'b' }, 'a a'), 'b a');
  assert.equal(contentAfter('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'a a'), 'b b');
  const multi = {
    edits: [
      { old_string: 'x', new_string: 'y' },
      { old_string: 'y', new_string: 'z' },
    ],
  };
  assert.equal(contentAfter('MultiEdit', multi, 'x'), 'z');
});

// Commands are assembled from parts so the live pre-bash hook doesn't flag this file's own text.
const NPM = ['np', 'm'].join('');
const FORCE = ['--', 'force'].join('');
const NO_VERIFY = ['--', 'no-verify'].join('');

test('bash: pnpm only', () => {
  assert.deepEqual(rules(bashFindings(`${NPM} install @nestjs/core`)), ['pnpm-only']);
  assert.deepEqual(rules(bashFindings('yarn add pg')), ['pnpm-only']);
  assert.deepEqual(rules(bashFindings(`${NPM.replace('m', 'x')} nest new`)), ['pnpm-only']);
  assert.deepEqual(bashFindings('pnpm add pg'), []);
  assert.deepEqual(bashFindings('pnpm run test:e2e'), []);
});

test('bash: git safety', () => {
  assert.deepEqual(rules(bashFindings(`git commit ${NO_VERIFY} -m x`)), ['no-verify']);
  assert.deepEqual(rules(bashFindings(`git push ${FORCE} origin feat/x`)), ['force-push']);
  assert.deepEqual(rules(bashFindings('git push origin main')), ['push-main']);
  assert.deepEqual(rules(bashFindings('git push', { branch: 'main' })), ['push-main']);
  assert.deepEqual(bashFindings('git push -u origin HEAD', { branch: 'feat/ledger' }), []);
  const merge = bashFindings('gh pr merge 3');
  assert.deepEqual([merge[0].rule, merge[0].decision], ['merge', 'ask']);
  assert.equal(bashFindings('gh repo create x --public --source .')[0].decision, 'ask');
});

test('bash: wiping local data asks first', () => {
  assert.deepEqual(rules(bashFindings('docker compose down -v')), ['wipe-volumes']);
  assert.deepEqual(rules(bashFindings('docker volume prune -f')), ['wipe-volumes']);
  assert.deepEqual(bashFindings('docker compose down'), []);
  assert.deepEqual(bashFindings('docker compose up --build -d'), []);
});

test('read-only bash: reading is fine, writing is not', () => {
  for (const ok of [
    'git diff --stat',
    'grep -rn reserved src',
    'cat a | jq .',
    'pnpm run test:e2e',
    'docker compose ps',
    'docker compose logs api --tail 50',
    'docker compose exec postgres psql -U app -c "select * from programs"',
    'git log > /tmp/log.txt',
  ]) {
    assert.deepEqual(readOnlyBashFindings(ok), [], ok);
  }
  for (const bad of [
    'echo x > src/a.ts',
    'rm -rf dist',
    'git commit -m x',
    'pnpm add pg',
    'node -e "1"',
    'docker compose exec postgres psql -c "delete from programs"',
    'docker compose down',
    'gh pr create',
  ]) {
    assert.ok(readOnlyBashFindings(bad).length > 0, bad);
  }
});

test('read-only bash with an allow-list: own paths and shipping are fine', () => {
  const scope = { writable: ['docs/'] };
  assert.deepEqual(readOnlyBashFindings('echo x > docs/a.md', scope), []);
  assert.deepEqual(readOnlyBashFindings('git add docs/a.md && git commit -m x', scope), []);
  assert.ok(readOnlyBashFindings('echo x > src/a.ts', scope).length > 0);
});

test('editAllowed matches folders and exact files', () => {
  assert.ok(editAllowed('src/capacity/a.ts', ['src/capacity/']));
  assert.ok(editAllowed('README.md', ['README.md']));
  assert.ok(!editAllowed('src/capacityx/a.ts', ['src/capacity/']));
  assert.ok(!editAllowed('docs/README.md', ['README.md']));
});

test('reminders fire for the right paths', () => {
  const ids = (p) => remindersFor(p).map((r) => r.id);
  assert.deepEqual(ids('src/capacity/capacity.repository.ts'), ['oversubscription']);
  assert.deepEqual(ids('src/treasury/snapshot.handler.ts'), ['idempotency', 'reconciliation']);
  assert.deepEqual(ids('src/fx/fx-rate.provider.ts'), ['currency']);
  assert.deepEqual(ids('src/http/reservations.controller.ts'), ['errors', 'api-docs']);
  assert.deepEqual(ids('src/capacity/reserve.dto.ts'), ['oversubscription', 'api-docs']);
  assert.deepEqual(ids('migrations/001_init.sql'), ['migrations']);
  assert.deepEqual(ids('README.md'), ['readme']);
  assert.deepEqual(ids('docker-compose.yml'), ['compose']);
  assert.deepEqual(ids('test/reconciliation.spec.ts'), [], 'tests get no reminders');
});
