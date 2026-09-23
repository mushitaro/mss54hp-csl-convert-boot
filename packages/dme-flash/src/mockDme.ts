/**
 * A DME that answers DS2, backed by a real flash image.
 *
 * This exists so the whole read path - framing, echo, login, addressing, reassembly - can be
 * exercised end to end without a car. That matters more here than in most projects: the first
 * thing this tool will ever do on real hardware is a full backup, and a backup that is subtly
 * wrong is worse than no backup, because it will be trusted.
 *
 * What it models is what the firmware actually does, taken from the disassembly:
 *
 *  - **The K-line echo.** Every byte written comes straight back before the reply.
 *  - **The nibble-to-physical map** the write handler builds at 0x264E: nibble 0 -> 0x4000,
 *    1 -> 0x0000 (the bootloader), 2 -> 0x8000, 4 -> 0x6000, 5 -> 0x10000, and DPRAM/RAM refused.
 *  - **Linear 24-bit reads** on segments 0x05 and 0x0C, gated on the access bit that command
 *    0x90 grants - answering 0xA2 when it has not been granted.
 *  - **The censored window** at 0x4000-0x4017, which the firmware substitutes with 0xFF.
 *  - **Refusal of anything destructive**, because this mock has no business pretending to erase.
 *
 * It deliberately does NOT implement writes. A mock that accepted them would let a bug in the
 * write path look tested when nothing had been proven at all.
 */
import { DME_DS2_ADDRESS, buildDs2Frame, parseDs2Frame, Ds2Status } from './ds2';
import { Command, LinearReadSegment } from './telegrams';
import { SEED_RESPONSE_LENGTH, calculateKey } from './seedKey';
import type { ByteTransport } from './transport';

/** Nibble to physical flash base, recovered from the firmware's own dispatch table. */
const NIBBLE_BASE: Readonly<Record<number, number | 'refused'>> = {
    0x0: 0x4000, 0x1: 0x0000, 0x2: 0x8000, 0x3: 'refused',
    0x4: 0x6000, 0x5: 0x10000, 0x6: 'refused',
    0x8: 0x4000, 0x9: 0x0000, 0xa: 0x8000, 0xb: 'refused',
    0xc: 0x6000, 0xd: 0x10000, 0xe: 'refused',
};

const CENSORED = { start: 0x4000, end: 0x4018 } as const;

export interface MockDmeOptions {
    /** Master flash, 512 KiB. */
    readonly master: Uint8Array;
    /** Slave flash, 512 KiB. Defaults to a copy of the master. */
    readonly slave?: Uint8Array;
    /** Start already unlocked, for tests that are not about the login. */
    readonly unlocked?: boolean;
    /** Fail the Nth exchange, to exercise retry paths. */
    readonly failExchange?: (n: number) => 'silence' | 'corrupt' | undefined;
}

export class MockDme {
    readonly master: Uint8Array;
    readonly slave: Uint8Array;
    /** Set once command 0x90 has been completed. Gates the linear read segments. */
    unlocked: boolean;
    /** Every request payload received, for assertions about what was actually sent. */
    readonly requests: Uint8Array[] = [];
    exchanges = 0;

    constructor(private readonly options: MockDmeOptions) {
        if (options.master.length !== 0x80000) {
            throw new Error(`master flash must be 512 KiB, got ${options.master.length}`);
        }
        this.master = options.master;
        this.slave = options.slave ?? Uint8Array.from(options.master);
        this.unlocked = options.unlocked ?? false;
    }

    /** Handle one request payload and produce the reply payload (status byte first). */
    respond(request: Uint8Array): Uint8Array {
        this.requests.push(Uint8Array.from(request));
        const command = request[0];

        switch (command) {
            case Command.Ident:
                return new Uint8Array([Ds2Status.Ack, ...asciiBytes('7837340 1B009060')]);

            case Command.Login:
                return this.handleLogin(request);

            case Command.ReadMemory:
                return this.handleRead(request);

            case Command.EncodingChecksum:
                // Every area healthy. A set bit would mean FAULTED.
                return new Uint8Array([Ds2Status.Ack, 0x00]);

            case Command.BaudRate:
                return new Uint8Array([Ds2Status.Ack]);

            case Command.KeepAlive:
                return new Uint8Array([Ds2Status.Ack]);

            case Command.ProgramControl:
            case Command.Jump:
                // This mock will not pretend to modify flash.
                return new Uint8Array([Ds2Status.Rejected]);

            default:
                return new Uint8Array([Ds2Status.ParameterError]);
        }
    }

    private handleLogin(request: Uint8Array): Uint8Array {
        // The seed request is "BMW" + level; anything else of this length is the key coming back.
        const isSeedRequest = request[1] === 0x42 && request[2] === 0x4d && request[3] === 0x57;
        if (isSeedRequest) {
            const frame = new Uint8Array(SEED_RESPONSE_LENGTH);
            frame[0] = DME_DS2_ADDRESS;
            frame[1] = SEED_RESPONSE_LENGTH;
            frame[2] = Ds2Status.Ack;
            for (let i = 3; i < SEED_RESPONSE_LENGTH - 1; i++) frame[i] = (i * 13 + 7) & 0xff;
            this.pendingSeedFrame = frame;
            this.pendingLevel = request[4] ?? 0;
            // The caller frames this; hand back the data portion.
            return frame.subarray(2, SEED_RESPONSE_LENGTH - 1);
        }
        // A key. Accept it when it matches what the seed implies.
        if (this.pendingSeedFrame) {
            const expected = calculateKey(this.pendingLevel, this.pendingSeedFrame);
            const offered = (((request[1] ?? 0) << 24) | ((request[2] ?? 0) << 16)
                | ((request[3] ?? 0) << 8) | (request[4] ?? 0)) >>> 0;
            if (offered === expected) {
                this.unlocked = true;
                return new Uint8Array([Ds2Status.Ack]);
            }
        }
        return new Uint8Array([Ds2Status.Rejected]);
    }

    private pendingSeedFrame: Uint8Array | undefined;
    private pendingLevel = 0;

    private handleRead(request: Uint8Array): Uint8Array {
        const segment = request[1] ?? 0;
        const address = ((request[2] ?? 0) << 16) | ((request[3] ?? 0) << 8) | (request[4] ?? 0);
        const count = request[5] ?? 0;
        if (count === 0 || count > 0xfe) return new Uint8Array([Ds2Status.ParameterError]);

        let bank: Uint8Array;
        let offset: number;

        if (segment === LinearReadSegment.master || segment === LinearReadSegment.slave) {
            // Linear 24-bit read. The firmware gates these on an access bit command 0x90 grants.
            if (!this.unlocked) return new Uint8Array([Ds2Status.Rejected]);
            bank = segment === LinearReadSegment.master ? this.master : this.slave;
            offset = address;
            if (offset + count > bank.length) return new Uint8Array([Ds2Status.ParameterError]);
        } else if (segment === 0x00) {
            // Windowed read: the top nibble selects the window, the low 20 bits are the offset.
            const nibble = (address >>> 20) & 0xf;
            const base = NIBBLE_BASE[nibble];
            if (base === undefined || base === 'refused') return new Uint8Array([Ds2Status.ParameterError]);
            bank = nibble < 0x8 ? this.master : this.slave;
            offset = base + (address & 0xfffff);
            if (offset + count > bank.length) return new Uint8Array([Ds2Status.ParameterError]);
        } else {
            return new Uint8Array([Ds2Status.ParameterError]);
        }

        const out = new Uint8Array(count + 1);
        out[0] = Ds2Status.Ack;
        for (let i = 0; i < count; i++) {
            const at = offset + i;
            // The firmware substitutes 0xFF over this window - see handler 0x201A.
            out[i + 1] = (at >= CENSORED.start && at < CENSORED.end) ? 0xff : (bank[at] ?? 0xff);
        }
        return out;
    }

    /**
     * A ByteTransport that speaks to this mock, echoing like a real K-line.
     *
     * Bytes written are queued straight back as the echo, then the reply is appended - which is
     * exactly the order a K+DCAN interface delivers them in.
     */
    transport(): ByteTransport {
        let buffer: number[] = [];
        return {
            write: async (bytes: Uint8Array) => {
                this.exchanges++;
                const fault = this.options.failExchange?.(this.exchanges);

                // The echo comes back regardless of what the ECU then does.
                buffer.push(...bytes);
                if (fault === 'silence') return;

                const parsed = parseDs2Frame(bytes);
                if (!parsed.ok || !parsed.data) return;
                const reply = buildDs2Frame(DME_DS2_ADDRESS, this.respond(parsed.data));
                if (fault === 'corrupt') {
                    const broken = Uint8Array.from(reply);
                    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0xff;
                    buffer.push(...broken);
                    return;
                }
                buffer.push(...reply);
            },
            read: async (count: number) => {
                if (buffer.length < count) {
                    throw new Error(`mock DME has ${buffer.length} bytes buffered, ${count} requested`);
                }
                return Uint8Array.from(buffer.splice(0, count));
            },
            drain: async () => { buffer = []; },
        };
    }
}

function asciiBytes(text: string): number[] {
    return Array.from(text, (c) => c.charCodeAt(0));
}
