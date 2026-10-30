#!/usr/bin/env node
// Keeps .claude/ healthy: agent and skill frontmatter, names matching files, skills and agents
// referenced in prose exist, hook scripts referenced from settings and agents exist.
// Usage: node tools/harness-audit.mjs [--root <dir>]   exit 1 on findings.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { listField, readFrontmatter } from './harness/frontmatter.mjs';

export function auditHarness(root) {
  const findings = [];
  const add = (file, message) => findings.push({ file, message });
  const claude = join(root, '.claude');
  const agentsDir = join(claude, 'agents');
  const skillsDir = join(claude, 'skills');
  const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : [];
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const agentNames = new Set(agents.map((f) => f.replace(/\.md$/, '')));
  const skillNames = new Set(skills);
  const builtinAgents = new Set(['general-purpose', 'Explore', 'Plan']);
  // Skills provided by the user's global or plugin setup, allowed to be referenced but not present here.
  const externalSkills = new Set(['skill-creator', 'readme-design', 'security-review']);

  const texts = [];
  for (const f of agents) {
    const rel = `.claude/agents/${f}`;
    const text = readFileSync(join(agentsDir, f), 'utf8');
    texts.push([rel, text]);
    const fm = readFrontmatter(text);
    if (!fm) {
      add(rel, 'missing frontmatter');
      continue;
    }
    if (fm.data.name !== f.replace(/\.md$/, '')) {
      add(rel, `name "${fm.data.name}" does not match the file name`);
    }
    if (!fm.data.description || fm.data.description.length < 40) {
      add(rel, 'description missing or too short to route on');
    }
    for (const s of listField(fm.data.skills)) {
      if (!skillNames.has(s)) {
        add(rel, `preloads unknown skill "${s}"`);
      }
    }
    for (const a of (fm.data.tools ?? '').matchAll(/Agent\(([^)]*)\)/g)) {
      for (const n of listField(a[1])) {
        if (!agentNames.has(n)) {
          add(rel, `may delegate to unknown agent "${n}"`);
        }
      }
    }
  }
  for (const s of skills) {
    const rel = `.claude/skills/${s}/SKILL.md`;
    if (!existsSync(join(skillsDir, s, 'SKILL.md'))) {
      add(rel, 'missing SKILL.md');
      continue;
    }
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    texts.push([rel, text]);
    const fm = readFrontmatter(text);
    if (!fm) {
      add(rel, 'missing frontmatter');
      continue;
    }
    if (fm.data.name !== s) {
      add(rel, `name "${fm.data.name}" does not match the folder`);
    }
    if (!fm.data.description || fm.data.description.length < 40) {
      add(rel, 'description missing or too short to trigger on');
    }
  }
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    if (existsSync(join(root, doc))) {
      texts.push([doc, readFileSync(join(root, doc), 'utf8')]);
    }
  }
  const commandsDir = join(claude, 'commands');
  if (existsSync(commandsDir)) {
    for (const f of readdirSync(commandsDir).filter((x) => x.endsWith('.md'))) {
      texts.push([`.claude/commands/${f}`, readFileSync(join(commandsDir, f), 'utf8')]);
    }
  }

  // Prose references: "the `x` skill", "`x` agent", hook scripts.
  for (const [rel, text] of texts) {
    for (const m of text.matchAll(/`([a-z0-9][a-z0-9-]*)` skill/g)) {
      if (!skillNames.has(m[1]) && !externalSkills.has(m[1])) {
        add(rel, `mentions unknown skill "${m[1]}"`);
      }
    }
    for (const m of text.matchAll(/`([a-z0-9][a-z0-9-]*)` agent/g)) {
      if (!agentNames.has(m[1]) && !builtinAgents.has(m[1])) {
        add(rel, `mentions unknown agent "${m[1]}"`);
      }
    }
    for (const m of text.matchAll(/\.claude\/hooks\/([\w.-]+\.(?:mjs|sh))/g)) {
      if (!existsSync(join(claude, 'hooks', m[1]))) {
        add(rel, `references missing hook ${m[1]}`);
      }
    }
  }
  const settings = join(claude, 'settings.json');
  if (existsSync(settings)) {
    const raw = readFileSync(settings, 'utf8');
    try {
      JSON.parse(raw);
    } catch (e) {
      add('.claude/settings.json', `invalid JSON: ${e.message}`);
    }
    for (const m of raw.matchAll(/\.claude\/hooks\/([\w.-]+)/g)) {
      if (!existsSync(join(claude, 'hooks', m[1]))) {
        add('.claude/settings.json', `references missing hook ${m[1]}`);
      }
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const k = process.argv.indexOf('--root');
  const root = resolve(k > 0 ? process.argv[k + 1] : process.cwd());
  const findings = auditHarness(root);
  for (const f of findings) {
    console.log(`${f.file}: ${f.message}`);
  }
  console.log(findings.length ? `\naudit:harness: ${findings.length} finding(s)` : 'audit:harness: clean');
  process.exit(findings.length ? 1 : 0);
}
