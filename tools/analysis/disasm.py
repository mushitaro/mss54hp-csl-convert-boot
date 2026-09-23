#!/usr/bin/env python3
"""Linear-sweep 68k (CPU32/MC68336) disassembler for the DME master image.
Usage: disasm.py <start_hex> <nbytes> [bin]
Master CPU flash is mapped 1:1 at file offset 0 (addr == file offset)."""
import sys
from capstone import Cs, CS_ARCH_M68K, CS_MODE_M68K_020, CS_MODE_BIG_ENDIAN
BIN = sys.argv[3] if len(sys.argv) > 3 else r"data/211325000401PD31_Community_Patch_v1.bin"
d = open(BIN,'rb').read()
start = int(sys.argv[1],16)
n     = int(sys.argv[2],16) if len(sys.argv)>2 else 0x80
md = Cs(CS_ARCH_M68K, CS_MODE_M68K_020 | CS_MODE_BIG_ENDIAN)
md.detail = False
code = d[start:start+n]
for insn in md.disasm(code, start):
    hexb = insn.bytes.hex()
    hexb = ' '.join(hexb[i:i+2] for i in range(0,len(hexb),2))
    print(f"0x{insn.address:05X}: {hexb:<24} {insn.mnemonic:<8} {insn.op_str}")
