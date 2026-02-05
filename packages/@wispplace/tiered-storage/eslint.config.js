import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	prettier,
	{
		languageOptions: {
			parserOptions: {
				project: './tsconfig.eslint.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': 'error',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/prefer-nullish-coalescing': 'error',
			'@typescript-eslint/prefer-optional-chain': 'error',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/require-await': 'off', // Interface methods can be async for compatibility
			'@typescript-eslint/explicit-function-return-type': 'off', // Too noisy for test files
			'prettier/prettier': 'error',
			'indent': ['error', 'tab', { 'SwitchCase': 1 }],
			'@typescript-eslint/indent': 'off', // Prettier handles this
		},
	},
	{
		ignores: ['dist/', 'node_modules/', '*.js', '*.cjs', '*.mjs'],
	},
);
