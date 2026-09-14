import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'node_modules/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } }
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-unused-vars': 'off'
    }
  },
  { files: ['src/server/**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['src/web/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['*.config.{ts,js}'], languageOptions: { globals: globals.node } },
  { files: ['tests/**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.node, ...globals.browser } } }
];
