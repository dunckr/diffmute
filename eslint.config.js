import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'dist-chrome/**',
      'web-ext-artifacts/**',
      '.firefox-profile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  unicorn.configs['flat/recommended'],
  perfectionist.configs['recommended-natural'],
  {
    files: ['**/*.{ts,mjs,js}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'unicorn/filename-case': [
        'error',
        { cases: { kebabCase: true, pascalCase: true } },
      ],
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': [
        'error',
        {
          allowList: {
            dir: true,
            docs: true,
            env: true,
            fn: true,
            params: true,
            props: true,
            req: true,
            res: true,
            utils: true,
          },
        },
      ],
    },
  },
  {
    // Extension scripts are bundled as IIFEs, which cannot use top-level await.
    files: ['src/**/*.ts'],
    rules: { 'unicorn/prefer-top-level-await': 'off' },
  },
  {
    // web-ext looks for this exact file name.
    files: ['web-ext-config.mjs'],
    rules: { 'unicorn/prevent-abbreviations': 'off' },
  },
  {
    // Build and packaging scripts run by hand in Node.
    files: ['scripts/**/*.mjs', 'web-ext-config.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'unicorn/no-process-exit': 'off',
    },
  },
  prettier
);
