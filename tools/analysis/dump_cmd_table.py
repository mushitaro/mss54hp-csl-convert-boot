#!/usr/bin/env python3
"""Dump the DS2 command tables: {u8 cmd, u8 access_mask, u32 handler} x N."""
import sys
BIN = sys.argv[1] if len(sys.argv) > 1 else r"data\211325000401PD31_Community_Patch_v1.bin"
d = open(BIN, 'rb').read()
def dump(base, countaddr, label):
    n = d[countaddr]
    print(f"\n=== {label}: base 0x{base:05X}, count byte @0x{countaddr:05X} = {n} ===")
    print(f"{'cmd':>5} {'mask':>6} {'handler':>10}")
    for i in range(n):
        o = base + i*6
        cmd, mask = d[o], d[o+1]
        h = int.from_bytes(d[o+2:o+6], 'big')
        print(f" 0x{cmd:02X}  0x{mask:02X}  0x{h:08X}")
    print(f" (table spans 0x{base:05X}..0x{base+n*6:05X}; count byte sits at 0x{countaddr:05X})")
dump(0x37A2, 0x37EA, "BOOTLOADER command table")
appbase = int.from_bytes(d[0x10230:0x10234],'big')
appcnt  = int.from_bytes(d[0x10234:0x10238],'big')
appinit = int.from_bytes(d[0x10238:0x1023c],'big')
print(f"\napplication table pointers @0x10230: base=0x{appbase:08X} countptr=0x{appcnt:08X} init=0x{appinit:08X}")
if 0 < appbase < len(d) and 0 < appcnt < len(d):
    dump(appbase, appcnt, "APPLICATION command table")
