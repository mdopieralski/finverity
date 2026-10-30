import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.claude/worktrees/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  { files: ['scripts/**', 'tools/**', 'test/**'], rules: { 'no-console': 'off' } },
  // Tests read arbitrary JSON responses; `any` there is the honest type.
  { files: ['test/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } }
);
