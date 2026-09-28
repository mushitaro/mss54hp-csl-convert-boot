/** Types for inject-supporters.mjs (a copy of tsunagi-m3/tools/credits), which stays plain JavaScript. */
export interface SupportersPayload {
    v: 1;
    project: string;
    names: string[];
    others: boolean;
    asOf: string;
}
export declare function validate(data: unknown, project: string): { names: string[]; others: boolean };
export declare function asOf(now?: Date): string;
export declare function blockFor(payload: SupportersPayload): string;
export declare function injectIntoHtml(html: string, payload: SupportersPayload | null): string;
export declare function injectDir(dir: string, payload: SupportersPayload | null): { files: number; written: number };
export declare function readSupporters(project: string, env?: Record<string, string | undefined>): Promise<{ names: string[]; others: boolean }>;
export declare function meshProject(cwd?: string): string;
