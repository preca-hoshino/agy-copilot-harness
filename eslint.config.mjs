import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import biome from 'eslint-config-biome';
import boundaries from 'eslint-plugin-boundaries';

export default defineConfig([
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'types', pattern: ['src/shared/**/*', 'src/acp/acpTypes.ts'], mode: 'full' },
        { type: 'bootstrap', pattern: 'src/bootstrap/**/*' },
        { type: 'acp', pattern: 'src/acp/**/*' },
        { type: 'quota', pattern: 'src/quota/**/*' },
        { type: 'auth', pattern: 'src/auth/**/*' },
        { type: 'models', pattern: 'src/models/**/*' },
        { type: 'sessions', pattern: 'src/sessions/**/*' },
        { type: 'entry', pattern: 'src/extension.ts', mode: 'file' },
      ],
    },
    rules: {
      ...tsPlugin.configs['strict-type-checked'].rules,

      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',

      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: false,
          allowAny: false,
          allowNullish: false,
          allowRegExp: false,
          allowNever: false,
        },
      ],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'never',
        },
      ],
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowNullableBoolean: true,
          allowNullableString: false,
          allowNullableNumber: false,
          allowNullableObject: true,
          allowAny: false,
        },
      ],

      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/promise-function-async': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': [
        'error',
        {
          fixMixedExportsWithInlineTypeSpecifier: true,
        },
      ],

      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
        },
      ],

      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        {
          ignoreArrowShorthand: false,
          ignoreVoidOperator: false,
        },
      ],
      '@typescript-eslint/require-array-sort-compare': 'error',
      'prefer-promise-reject-errors': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],

      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
        { selector: 'variable', modifiers: ['destructured'], format: null },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE', 'PascalCase'] },
        { selector: 'property', format: null },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
      ],

      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      'prefer-const': 'off',
      'no-var': 'off',
      'no-param-reassign': 'off',
      'no-return-assign': 'off',

      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              from: { type: 'types' },
              disallow: [{ to: { type: ['bootstrap', 'acp', 'quota', 'auth', 'models', 'sessions', 'entry'] } }],
              message: 'Types/Contracts 层不能反向依赖任何实现层。',
            },
            {
              from: { type: 'bootstrap' },
              disallow: [{ to: { type: ['acp', 'quota', 'auth', 'models', 'sessions', 'entry'] } }],
              message: 'Bootstrap 层仅可依赖 Types/Contracts 层。',
            },
            {
              from: { type: 'acp' },
              disallow: [{ to: { type: ['bootstrap', 'quota', 'auth', 'models', 'sessions', 'entry'] } }],
              message: 'ACP 传输与后端管理层不得反向依赖业务/UI 层。',
            },
            {
              from: { type: 'quota' },
              disallow: [{ to: { type: ['bootstrap', 'acp', 'auth', 'models', 'sessions', 'entry'] } }],
              message: 'Quota 层仅依赖 Types/Contracts，不得耦合具体认证/模型/会话模块。',
            },
            {
              from: { type: 'auth' },
              disallow: [{ to: { type: ['bootstrap', 'acp', 'models', 'sessions', 'entry'] } }],
              message: 'Auth 层仅依赖 Types/Contracts 与 Quota。',
            },
            {
              from: { type: 'models' },
              disallow: [{ to: { type: ['bootstrap', 'acp', 'auth', 'sessions', 'entry'] } }],
              message: 'Models 层仅依赖 Types/Contracts 与 Quota。',
            },
            {
              from: { type: 'sessions' },
              disallow: [{ to: { type: ['bootstrap', 'acp', 'auth', 'entry'] } }],
              message: 'Sessions 层仅依赖 Types/Contracts、Quota 与 Models。',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'scripts/', 'test/', '*.config.*'],
  },
  biome,
]);
