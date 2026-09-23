#!/usr/bin/env python3
"""Locate region_table by disassembling flash_req_parse (master 0x289c).

flash_req_parse walks a table of <=0x41 entries {id, variant, start_addr, end_addr}
with a 10-byte stride (decomp master/00289c.txt: `puVar2 = puVar2 + 10`).
The table base is loaded as an absolute address, so find the LEA/MOVEA immediates.
"""
import sys
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_040

BIN = r"C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin"
START = 0x289C
LENGTH = 0x140

def main():
    data = open(BIN, 'rb').read()
    md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_040)
    md.detail = False
    print(f"# disassembly of flash_req_parse @ 0x{START:06X} ({LENGTH} bytes)")
    for ins in md.disasm(data[START:START+LENGTH], START):
        print(f"  {ins.address:06X}  {ins.bytes.hex():<12} {ins.mnemonic:<8} {ins.op_str}")

if __name__ == '__main__':
    main()
