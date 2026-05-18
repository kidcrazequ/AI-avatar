// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '*.js', '*.cjs', '*.mjs'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-function': 'warn',
      'prefer-const': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'default-case': 'warn',
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',

      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString']",
          message: '禁止 toISOString().slice() 获取日期，应使用 localDateString() 避免 UTC 时区偏移',
        },
        {
          selector: "CatchClause[body.body.length=0]",
          message: '禁止空 catch 块，至少记录日志或添加注释说明忽略原因',
        },
      ],
    },
  },
);
