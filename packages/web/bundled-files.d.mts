/** Types for bundled-files.mjs, which stays plain JavaScript so scripts/deploy.mjs can import it. */
export declare const REQUIRED_BINARIES: readonly string[];
export declare const BUNDLED_DIRS: readonly string[];
export declare function bundledNames(dir: 'spdaten' | 'program' | 'bootloader'): string[];
