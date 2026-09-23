import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/**/*.test.ts'],
        environment: 'node',
    },
    resolve: {
        /**
         * The same alias the web app builds with, so a test may import a UI module.
         *
         * Without it, anything under `packages/web` that reaches the link layer is untestable here
         * - which is how `stageName` came to have a bug that only a browser could find. The web
         * build has always resolved this; only the test runner did not, and the effect was a whole
         * package being effectively out of reach rather than an error anyone saw.
         */
        alias: {
            'dme-flash': fileURLToPath(new URL('./packages/dme-flash/src/index.ts', import.meta.url)),
        },
    },
});
