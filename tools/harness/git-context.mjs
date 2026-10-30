// Branch and working-tree facts for the hooks. Never throws: outside git it returns {}.
import { execFileSync } from 'node:child_process';

const git = (root, args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

export function gitContext(root) {
  const branch = git(root, ['branch', '--show-current']);
  if (!branch && !git(root, ['rev-parse', '--git-dir'])) {
    return {};
  }
  const dirty = git(root, ['status', '--porcelain']).split('\n').filter(Boolean).length;
  return { branch: branch || null, dirty };
}

// True when `rel` exists in HEAD: a committed file (used to keep committed migrations immutable).
export function isCommitted(root, rel) {
  return git(root, ['cat-file', '-t', `HEAD:${rel}`]) === 'blob';
}
