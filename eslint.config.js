import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } }, rules: { 'vue/multi-word-component-names': 'off' } },
);
