/** Execute resident routines without substituting helper return values. Peripheral
 * registers and NOR timing retain Machine's documented modelling limitations. */
import { Cpu32 } from './cpu32';
import { Machine, SIM } from './machine';

export function firmwareRig(image: Uint8Array) {
    const machine = new Machine(image, { watchdogInstructions: 5_000_000 });
    machine.enableRamLikeFirmware();
    // Bootloader TRAMBAR=FFD0 maps the 4 KiB page at FFD000.
    machine.writeWord(SIM.CSORBT, 0x68f0);
    machine.writeWord(SIM.CSOR0, 0);
    const cpu = new Cpu32(machine);
    const writeLong = (a: number, v: number) => {
        machine.writeWord(a, v >>> 16); machine.writeWord(a + 2, v & 0xffff);
    };
    const run = (stop: () => boolean, limit = 2_000_000) => {
        for (let i = 0; i < limit; i++) {
            if (stop()) return;
            const resets = cpu.resetExecuted;
            cpu.step(); machine.tick();
            if (cpu.resetExecuted !== resets) machine.applyResetInstruction();
            if (machine.watchdogFired) throw new Error(`watchdog at ${cpu.pc.toString(16)}`);
        }
        throw new Error(`instruction limit at ${cpu.pc.toString(16)}`);
    };
    const call = (pc: number, args: number[] = []) => {
        cpu.pc = pc; cpu.a[7] = 0xffe800; cpu.sr = 0x2700;
        writeLong(cpu.a[7]!, 0x7ff00);
        args.forEach((v, i) => writeLong(cpu.a[7]! + 4 + i * 4, v));
        run(() => cpu.pc === 0x7ff00);
        return cpu.d[0]!;
    };
    const telegram = (data: Uint8Array) => {
        // Command-entry harness: the outer UART/peer scheduler is not executed.
        // Its pending-forward state must not leak from the previous dispatch.
        machine.writeByte(0xffd007, 0);
        writeLong(0xffd026, 0xffd200); writeLong(0xffd02a, 0xffd300);
        const request = [0x12, data.length, ...data];
        request.forEach((v, i) => machine.writeByte(0xffd200 + i, v));
        call(0x216c);
        return Uint8Array.from({ length: 7 }, (_, i) => machine.readByte(0xffd302 + i));
    };
    const control = (segment: number, address = 0) => telegram(Uint8Array.from([
        7, segment, address >>> 16, address >>> 8 & 255, address & 255, 0]));
    return { machine, cpu, call, run, writeLong, control, telegram };
}
