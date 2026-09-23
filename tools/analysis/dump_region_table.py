#!/usr/bin/env python3
"""Dump region_table @ 0x3AD6 from the CSL 0401 image.

Layout proven from disassembly of flash_req_parse (master 0x289C):
  movea.l #$3ad6, a1          -> table base 0x3AD6
  d0 = idx*5, ext word scale 2 -> effective stride 10 bytes
  cmpi.b #$ff, $1(a1,...)      -> variant at offset +1
Entry (10 bytes, big-endian):
  +0 id (u8) | +1 variant (u8) | +2 start_addr (u32) | +6 end_addr (u32)
Loop bound: cmpi.b #$41, d3 -> at most 0x41 = 65 entries.
"""
BIN = r"C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin"
BASE, STRIDE, MAX = 0x3AD6, 10, 0x41

def u32(b, o): return int.from_bytes(b[o:o+4], 'big')

data = open(BIN, 'rb').read()
print(f"region_table @ 0x{BASE:04X}, stride {STRIDE}, max {MAX} entries\n")
print(f"{'#':>3} {'id':>4} {'var':>4} {'start':>10} {'end':>10} {'size':>9}  note")
rows = []
for i in range(MAX):
    o = BASE + i*STRIDE
    e = data[o:o+STRIDE]
    if len(e) < STRIDE: break
    rid, var, start, end = e[0], e[1], u32(e,2), u32(e,6)
    rows.append((i, rid, var, start, end))
    note = ''
    if start == 0 and end == 0: note = 'empty slot (rejected by parse: start==0 && end==0)'
    elif end <= start: note = 'INVALID (end<=start)'
    elif end > 0x100000: note = 'beyond 1MB image'
    size = end - start if end > start else 0
    print(f"{i:>3} 0x{rid:02X} 0x{var:02X} 0x{start:08X} 0x{end:08X} {size:>9}  {note}")

live = [r for r in rows if not (r[3]==0 and r[4]==0) and r[4] > r[3]]
print(f"\nLIVE regions (accepted by flash_req_parse): {len(live)}")
for i, rid, var, start, end in live:
    print(f"  #{i:<3} id=0x{rid:02X} variant=0x{var:02X}  0x{start:06X}-0x{end:06X}  {end-start} bytes ({(end-start)/1024:.1f} KiB)")
