import eslint from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const tsRecommended = tsPlugin.configs['flat/recommended'];

export default [
  eslint.configs.recommended,
  ...tsRecommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
];
