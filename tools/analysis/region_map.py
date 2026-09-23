#!/usr/bin/env python3
"""region_table -> segment x nibble map, cross-validated against TUNER's proven constants.

Layout proven by disassembling flash_req_parse (master 0x289C):
  movea.l #$3ad6,a1     -> base 0x3AD6
  idx*5 with ext-word scale 2 -> stride 10
  +0 id | +1 variant | +2 start(u32 BE) | +6 end(u32 BE)
Address resolution (decomp master/00289c.txt):
  addr_hi = req[4]; if variant != 0xFF: addr_hi &= 0x0F
  addr = req[6] | (req[5] | addr_hi<<8)<<8      # 20-bit offset when variant-mapped
  accept iff (start,end) not both 0 and start <= addr < end
  len = min(req[7], end-addr, 0x80)
=> for variant segments the TOP NIBBLE of the 24-bit address selects the window.
"""
BIN = r"C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin"
BASE, STRIDE, MAX = 0x3AD6, 10, 0x41
SEG_NAME = {0x00:'(read/generic)', 0x02:'WriteSegment', 0x06:'EraseSegment',
            0x0E:'RecyclingSegment', 0x0F:'FinishSegment'}

def u32(b,o): return int.from_bytes(b[o:o+4],'big')
data = open(BIN,'rb').read()

entries=[]
for i in range(MAX):
    o=BASE+i*STRIDE; e=data[o:o+STRIDE]
    entries.append((i,e[0],e[1],u32(e,2),u32(e,6)))

print("=== FIXED regions (variant 0xFF: address used as-is, no nibble) ===")
for i,rid,var,s,en in entries:
    if var!=0xFF: continue
    state='DISABLED (end<=start: unreachable by design)' if en<=s else f'{en-s} bytes'
    print(f"  id=0x{rid:02X} {SEG_NAME.get(rid,''):<16} 0x{s:06X}-0x{en:06X}  {state}")

print("\n=== VARIANT regions: top address nibble selects the window ===")
segs=sorted({rid for _,rid,var,_,_ in entries if var!=0xFF})
nibs=sorted({var>>4 for _,_,var,_,_ in entries if var!=0xFF})
print(f"    nibble: " + " ".join(f"{n:>7X}" for n in nibs))
for sg in segs:
    row={var>>4:(s,en) for _,rid,var,s,en in entries if var!=0xFF and rid==sg}
    cells=[]
    for n in nibs:
        cells.append(f"{(row[n][1]-row[n][0])//1024:>6}K" if n in row else "      -")
    print(f"  0x{sg:02X} {SEG_NAME.get(sg,''):<16}" + " ".join(cells))
print("\n  (missing nibbles 0x7 and 0xF are absent from the table = not addressable)")

print("\n=== Interpretation: mirrored halves = the two CPUs ===")
ref={_id:{v>>4:(s,e) for _,r,v,s,e in entries if v!=0xFF and r==_id} for _id in segs}
w=ref[0x02]
for lo,hi,who in ((0x0,0x8,'master'),(0x8,0x0,'slave')):
    pass
for n in nibs:
    if n in w:
        s,e=w[n]; sz=e-s
        half='master' if n<0x8 else 'slave'
        print(f"  nibble 0x{n:X} -> {half:<6} window {sz:>7} bytes ({sz/1024:.0f} KiB)")

print("\n=== Cross-validation against TUNER's real-vehicle-proven constants ===")
checks=[("DataProgrammingSessionAddress 0xA02000 (erase seg 6 + write seg 2)",0xA02000,(0x06,0x02)),
        ("RecycleOnlyAddress 0x424151 (segment 0x0E)",0x424151,(0x0E,)),
        ("RecycleOffAddress 0x424152 (segment 0x0E)",0x424152,(0x0E,))]
allok=True
for label,addr,segids in checks:
    for sg in segids:
        ok=False; why=''
        for _,rid,var,s,en in entries:
            if rid!=sg: continue
            if var==0xFF:
                if en>s and s<=addr<en: ok=True; why=f'fixed region 0x{s:06X}-0x{en:06X}'; break
            else:
                if (addr>>16)&0xF0 != var: continue
                off=(addr & 0x0FFFFF)
                if en>s and s<=off<en: ok=True; why=f'nibble 0x{var>>4:X} window 0x{s:06X}-0x{en:06X}, offset 0x{off:05X}'; break
        allok &= ok
        print(f"  [{'OK ' if ok else 'FAIL'}] seg 0x{sg:02X}: {label}\n         {why or 'NOT ACCEPTED by region_table'}")
print(f"\n  => table interpretation {'CONFIRMED by independently proven constants' if allok else 'CONTRADICTED - do not use'}")
