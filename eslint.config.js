// eslint.config.js (flat config)
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import vitest from 'eslint-plugin-vitest';

export default [
  // 1) Ignore build artefacts
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'client/coverage/**',
      '**/node_modules/**'
    ]
  },

  // 2) Base JS rules
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.browser },
    ...js.configs.recommended
  },

  // 3) TypeScript rules (fast preset)
  ...tseslint.configs.recommended,

  // 4) React (JSX runtime auto, version detect)
  {
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } },
    rules: {
      // Soft defaults so you can iterate quickly
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'prefer-const': 'warn'
    }
  },

  // 5) Tests — Vitest globals + rules only for test files
  {
    files: ['**/__tests__/**/*', '**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
    languageOptions: {
      // Give tests both browser globals and Vitest globals (vi, describe, it, expect, etc.)
      globals: { ...globals.browser, ...vitest.environments.env.globals }
    }
  }
];
