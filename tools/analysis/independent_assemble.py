"""Compare both loader encodings against GNU binutils (CPU32), not our decoder.

Run after exporting custom assembler bytes to data/verification/{probe,replace}.bin.
Uses the locally extracted WSL Ubuntu binutils in data/verification/binutils/root.
Only syntax is translated: explicit absolute-long operands preserve our assembler's
choice instead of permitting GAS to relax them into absolute-short instructions.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/verification'
for name in ('probe', 'replace'):
    converted = ['.text']
    for raw in (ROOT / f'tools/loader/{name}.s').read_text().splitlines():
        line = raw.split(';')[0].strip()
        if not line:
            continue
        line = re.sub(r'\$([0-9a-fA-F]+)', r'0x\1', line)
        equ = re.fullmatch(r'(\w+)\s+equ\s+(.+)', line, re.I)
        if equ:
            converted.append(f'.equ {equ[1]}, {equ[2]}')
            continue
        label = ''
        if ':' in line:
            label, line = line.split(':', 1)
            label += ': '
            line = line.strip()
        if not line:
            converted.append(label)
            continue
        op, *tail = line.split(None, 1)
        operands = re.split(r',\s*(?![^()]*\))', tail[0]) if tail else []
        if not op.startswith(('b', 'db')):
            operands = [operand if operand.startswith('#') or '(' in operand
                        or re.fullmatch(r'(?:[ad][0-7]|sr|vbr|ccr)', operand, re.I)
                        or operand.endswith(('.w', '.l')) else operand + '.l'
                        for operand in operands]
        converted.append(label + op + ' ' + ','.join(operands))
    (OUT / f'{name}.gas.s').write_text('\n'.join(converted) + '\n')
    prefix = 'data/verification/binutils/root/usr'
    command = (f'export LD_LIBRARY_PATH={prefix}/lib/x86_64-linux-gnu; '
               f'{prefix}/bin/m68k-linux-gnu-as -mcpu32 --register-prefix-optional '
               f'--bitwise-or -o data/verification/{name}.o data/verification/{name}.gas.s && '
               f'{prefix}/bin/m68k-linux-gnu-ld -e 0 -Ttext=0 -o data/verification/{name}.elf data/verification/{name}.o && '
               f'{prefix}/bin/m68k-linux-gnu-objcopy -O binary data/verification/{name}.elf data/verification/{name}.gnu.bin')
    subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'sh', '-c', command], cwd=ROOT, check=True)
    expected = (OUT / f'{name}.bin').read_bytes()
    actual = (OUT / f'{name}.gnu.bin').read_bytes()
    if expected != actual:
        diffs = [(i, a, b) for i, (a, b) in enumerate(zip(expected, actual)) if a != b]
        raise AssertionError(f'{name}: lengths {len(expected)}/{len(actual)}, differences {diffs[:20]}')
    print(f'{name}: all {len(actual)} bytes agree with GNU CPU32 assembler/linker')
