import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import ts from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-plugin-prettier';
import js from '@eslint/js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default [
  js.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/__tests__/**',
      '**/node_modules/**',
    ],
  },

  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parser: ts,
      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: process.cwd(),
        sourceType: 'module',
      },
    },
    rules: {
      // Disabling the check for "useless" catch
      'no-useless-catch': 'off',
      
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off',

      ...compat.config({
        rules: {
          '@typescript-eslint/interface-name-prefix': 'off',
          '@typescript-eslint/explicit-function-return-type': 'off',
          '@typescript-eslint/explicit-module-boundary-types': 'off',
          '@typescript-eslint/no-explicit-any': 'off',
          '@typescript-eslint/no-this-alias': 'warn'
        },
      }).rules,
      // Rule for import type
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      // Ban on default imports
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDefaultSpecifier',
          message:
            'Default import of CommonJS modules is forbidden. Use `import * as name from "module"`.',
        },
      ],
    },
  },
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'error',
    },
  },
  {
    files: ['**/check-docs.ts', '**/rpc.transport.ts', '**/http.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
