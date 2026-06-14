const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '.venv/**',
      'venv/**',
      'node_modules/**',
      '.claude/**',
      'homebridge-ui/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      semi: ['error', 'always'],
    },
  },
];
