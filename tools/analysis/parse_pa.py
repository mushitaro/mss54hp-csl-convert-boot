#!/usr/bin/env python3
"""Parse a BMW Austausch-Datei (.0PA program / .0DA data) - Intel HEX + BMW directives."""
import sys, re
from collections import OrderedDict

def parse(path):
    raw = open(path,'rb').read().replace(b'\r\n', b'\n')
    header, directives, sections = [], [], []
    base = 0
    cur = None
    for ln, line in enumerate(raw.split(b'\n'), 1):
        if not line: continue
        if line.startswith(b';'):
            header.append(line.decode('latin1')); continue
        if line.startswith(b'$'):
            directives.append((ln, line.decode('latin1'))); continue
        if not line.startswith(b':'): 
            directives.append((ln, '??? ' + line.decode('latin1'))); continue
        b = bytes.fromhex(line[1:].decode())
        ll, addr, tt, data, cks = b[0], int.from_bytes(b[1:3],'big'), b[3], b[4:4+b[0]], b[4+b[0]]
        if (sum(b[:-1]) + cks) & 0xFF: raise ValueError(f'line {ln}: bad checksum')
        if tt == 0x02: base = int.from_bytes(data,'big') << 4
        elif tt == 0x04:
            base = int.from_bytes(data,'big') << 16
            cur = {'base': base, 'start': None, 'end': None, 'bytes': bytearray(), 'gaps': 0}
            sections.append(cur)
        elif tt in (0x00, 0x10):
            # BMW uses record type 0x10 for the LAST data record of each 64K block. It is a
            # data record, not a terminator: dropping it loses 16 bytes per block (128 per file)
            # and the loss is invisible because the bytes it carries are real program code.
            if ll == 0:
                cur['term'] = base + addr
                continue
            a = base + addr
            if cur['start'] is None: cur['start'] = a
            elif a != cur['end']: cur['gaps'] += 1
            cur['bytes'] += data
            cur['end'] = a + ll
        elif tt == 0x01: pass
        else: raise ValueError(f'line {ln}: unknown record type 0x{tt:02X}')
    return header, directives, sections

def main(path):
    header, directives, sections = parse(path)
    meta = OrderedDict()
    for h in header:
        m = re.match(r';;(\S+):?\s+(.*)', h)
        if m and m.group(2).strip(): meta.setdefault(m.group(1).rstrip(':'), m.group(2).strip())
    print(f"=== {path} ===")
    for k in ('ZL_System','ZL_Projekt','ZL_REFERENZ','K_Stand','K_File-Name','K_V2','Z_Stand','Z_File-Name'):
        if k in meta: print(f"  {k:<14} {meta[k]}")
    print(f"  directives: {[d for _,d in directives]}")
    total = 0
    print(f"  {'#':>2} {'base':>10} {'start':>10} {'end':>10} {'bytes':>8} {'gaps':>5}  term")
    sections = [s for s in sections if s['start'] is not None]
    for i,s in enumerate(sections):
        n = len(s['bytes']); total += n
        t = f"0x{s['term']:06X}" if 'term' in s else '-'
        print(f"  {i:>2} 0x{s['base']:08X} 0x{s['start']:06X} 0x{s['end']:06X} {n:>8} {s['gaps']:>5}  {t}")
    print(f"  TOTAL payload: {total} bytes ({total/1024:.1f} KiB)")
    return sections

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv)>1 else
         r"C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54\7837340A.0PA")
