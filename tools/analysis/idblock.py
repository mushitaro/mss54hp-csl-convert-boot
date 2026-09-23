#!/usr/bin/env python3
"""Extract the program identity block + its trailing 16-bit value from every .0PA."""
import sys, os, re
sys.path.insert(0, os.path.dirname(__file__))
from parse_pa import parse

D = os.environ.get('SP_DATEN_MSS54', r"C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54")

def samples():
    out = []
    for fn in sorted(os.listdir(D)):
        if not fn.upper().endswith('.0PA'): continue
        hdr, dirs, secs = parse(os.path.join(D, fn))
        secs = [s for s in secs if s['start'] is not None]
        ref = next((h.split(':',1)[1].strip() for h in hdr if 'ZL_REFERENZ' in h), None)
        sysn = next((h.split(':',1)[1].strip() for h in hdr if 'ZL_System' in h), '?')
        if not ref: continue
        for s in secs:
            b = bytes(s['bytes']); base = s['start']
            m = re.search(re.escape(ref.encode())*3, b)
            if not m: continue
            o = m.start()
            blk = b[o:o+80]                      # ref*3 (36) + partno*6 (42) + 0000 (2)
            if blk[78:80] != b'\x00\x00': continue
            val = (b[o+80] << 8) | b[o+81]
            out.append(dict(file=fn, sys=sysn, ref=ref, addr=base+o, block=blk, value=val,
                            prefix=b[o-16:o]))
            break
    return out

if __name__ == '__main__':
    for s in samples():
        print(f"{s['file']:<15} {s['sys']:<8} {s['ref']}  @0x{s['addr']:06X}  value=0x{s['value']:04X}")
