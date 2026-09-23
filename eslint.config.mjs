/**
 * One rule, and it is here because it reached a car.
 *
 * `runBackup` was a `useCallback` whose dependency list left out `backupMode`, so the callback kept
 * whichever mode had been selected when the OTHER dependencies last changed. On screen the choice
 * moved; what BACKUP actually did was whatever had been picked first. That was found by a person
 * standing next to a DME with an hour of reading ahead of them.
 *
 * A test for that one callback would have been the wrong fix. The defect is a class - every
 * `useCallback`, `useMemo` and `useEffect` in the app has the same failure available to it, it
 * produces no error, and it is invisible in review because the code reads correctly. A linter knows
 * the whole class by construction.
 *
 * Deliberately narrow: this is not a style pass over a working codebase. `exhaustive-deps` is an
 * error and almost nothing else is on, so the signal is entirely about stale closures.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
    { ignores: ['**/dist/**', '**/node_modules/**', '**/*.generated.ts', '.wrangler/**'] },
    js.configs.recommended,
    {
        files: ['packages/web/src/**/*.{ts,tsx}'],
        plugins: { 'react-hooks': reactHooks },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
        },
        rules: {
            'react-hooks/exhaustive-deps': 'error',
            'react-hooks/rules-of-hooks': 'error',

            // TypeScript already covers these, and its answers are better - it knows the types.
            // Leaving them on would bury the one rule this config exists for.
            'no-undef': 'off',
            'no-unused-vars': 'off',
            'no-empty': 'off',
        },
    },
);
