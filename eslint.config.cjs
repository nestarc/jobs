const js = require('@eslint/js');
const parser = require('@typescript-eslint/parser');
const ts = require('@typescript-eslint/eslint-plugin');
module.exports = [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@typescript-eslint': ts },
    rules: {
      ...js.configs.recommended.rules,
      ...ts.configs['eslint-recommended'].overrides[0].rules,
      ...ts.configs.recommended.rules,
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
