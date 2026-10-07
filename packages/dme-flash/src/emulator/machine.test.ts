import { describe, it, expect } from 'vitest';
import { Machine, SIM } from './machine';

describe('register behavior checked against MC68336/376 UM', () => {
    it('maps TRAMBAR[15:4] to ADDR[23:12] (12.3/D.9.3)', () => {
        const machine = new Machine();
        machine.writeWord(SIM.TRAMBAR, 0xffd0);
        expect(machine.tpuramBase).toBe(0xffd000);
        machine.writeWord(0xffd000, 0x1234);
        expect(machine.readWord(0xffd000)).toBe(0x1234);
        expect(machine.violations).toEqual([]);
    });
    it('enforces SYPCR write-once and reopens it after reset (D.2.12)', () => {
        const machine = new Machine(undefined, { watchdogInstructions: 2 });
        machine.writeByte(SIM.SYPCR, 0xbd);
        machine.writeByte(SIM.SYPCR, 0);
        expect(machine.watchdogEnabled).toBe(true);
        machine.tick(); machine.tick(); machine.tick();
        expect(machine.watchdogFired).toBe(true);
        machine.applyResetInstruction();
        expect(machine.watchdogFired).toBe(false);
        machine.writeByte(SIM.SYPCR, 0);
        expect(machine.watchdogEnabled).toBe(false);
    });
    it('reads the chip-select values the bus actually uses', () => {
        const machine = new Machine();
        expect(machine.readWord(SIM.CSORBT)).toBe(0x7b70);
        machine.enableFlashWritesLikeFirmware();
        expect(machine.readWord(SIM.CSORBT)).toBe(0x68f0);
        machine.applyResetInstruction();
        expect(machine.readWord(SIM.CSORBT)).toBe(0x7b70);
    });
});
