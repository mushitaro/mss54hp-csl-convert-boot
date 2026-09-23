#!/usr/bin/env python3
"""Locate the DS2 command dispatch table by disassembling diag_command_dispatch_handler.

decomp master/0010a4.txt: walks entries of 6 bytes {u8 cmd, u8 access_mask, u32 handler}
between diag_command_table_first_entry and diag_command_table_last_entry, with a
bootloader fallback table at &DAT_000037ea.
"""
import sys, re
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_040

BIN = sys.argv[1] if len(sys.argv) > 1 else r"data\211325000401PD31_Community_Patch_v1.bin"
data = open(BIN, 'rb').read()
md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_040); md.detail = False
print(f"# {BIN}")
print("# diag_command_dispatch_handler @ 0x0010A4")
imms = []
for ins in md.disasm(data[0x10A4:0x10A4 + 0x120], 0x10A4):
    print(f"  {ins.address:06X}  {ins.bytes.hex():<14} {ins.mnemonic:<9} {ins.op_str}")
    for m in re.finditer(r'\$0x([0-9a-f]{3,6})', ins.op_str):
        v = int(m.group(1), 16)
        if 0x100 <= v < 0x80000: imms.append((ins.address, v))
print("\n# absolute addresses referenced:", [f"0x{v:05X}" for _, v in imms])
