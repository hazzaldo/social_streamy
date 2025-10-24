// eslint.config.js (flat config)
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import vitest from 'eslint-plugin-vitest';

export default [
  // 1) Ignore build artefacts
  { ignores: ['dist/**', 'coverage/**', '**/node_modules/**'] },

  // 2) Base JS rules
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.browser },
    ...js.configs.recommended
  },

  // 3) TypeScript (parser + rules via typescript-eslint)
  //    This is the non type-aware preset (fast). If you want type-aware later,
  //    switch to `...tseslint.configs.recommendedTypeChecked` and add project: tsconfig.
  ...tseslint.configs.recommended,

  // 4) React (JSX runtime auto, version detect)
  {
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } },
    rules: {
      // Soften or temporarily disable strict rules
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

  // 5) Tests — give Vitest globals and rules only in test files
  {
    files: ['**/__tests__/**/*', '**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
    languageOptions: { globals: globals.vitest }
  }
];
