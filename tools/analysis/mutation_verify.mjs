// Run with no concurrent dev/test process using these sources. Every mutation is
// restored in finally; a mutant is killed only by assertion failures, not crashes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = 'packages/dme-flash/src/';
const mutations = [
    ['read-agreement', 'flashExecute.ts', 'verified = readBackAgreed && differingOffsets.length === 0;', 'verified = differingOffsets.length === 0;'],
    ['post-cycle-verdict', 'flashExecute.ts', 'completed = verified && encodingFaulted === false;', 'completed = true;'],
    ['ecu-fault', 'flashExecute.ts', 'if (encodingFaulted) verified = false;', 'if (false) verified = false;'],
    ['peer-armed', 'blExecute.ts', 'if (sectorIsArmed(peerBefore)) {', 'if (false) {'],
    ['partial-peer-erase', 'blExecute.ts', 'if (!peerAfter.every(b => b === 0xff)) {', 'if (false) {'],
    ['staged-readback', 'blExecute.ts', 'if (differing.count > 0) {', 'if (false) {'],
    ['control-verdict', 'session.ts', 'if (telegram[1] !== 0x0e && data[6] !== 1 && !pendingCalibration) {', 'if (false) {'],
    ['write-count', 'telegrams.ts', '...addressBytes(ds2Address), bytes.length, ...bytes', '...addressBytes(ds2Address), ...bytes'],
];
mkdirSync('data/verification', {recursive: true});
const results = [];
for (const [name, file, before, after] of mutations) {
    if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
    const path = root + file, original = readFileSync(path, 'utf8');
    assert(original.includes(before), `mutation target missing: ${name}`);
    const report = `data/verification/mutation-${name}.json`;
    try {
        writeFileSync(path, original.replaceAll(before, after));
        const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
            root + 'completionSafety.test.ts', root + 'reviewSafety.test.ts',
            root + 'flashExecute.test.ts', root + 'blExecute.test.ts',
            root + 'controlResponse.test.ts',
            root + 'emulator/residentWorkflow.test.ts',
            '--reporter=json', '--outputFile=' + report], {encoding: 'utf8', timeout: 60000});
        if (run.error) throw run.error;
        const parsed = JSON.parse(readFileSync(report, 'utf8'));
        const killed = run.status === 1 && parsed.numFailedTests > 0
            && parsed.testResults.every(result => result.assertionResults.length > 0);
        results.push({name, killed, failedTests: parsed.numFailedTests});
        console.log(`${name}: ${killed ? 'KILLED' : 'SURVIVED/INVALID'} (${parsed.numFailedTests} failed tests)`);
    } finally { writeFileSync(path, original); }
}
writeFileSync(`data/verification/mutations${process.argv.length > 2 ? '-selected' : ''}.json`, JSON.stringify(results, null, 2));
assert(results.every(r => r.killed), 'every selected guard mutation must be detected');
