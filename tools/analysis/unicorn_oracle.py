"""Independent M68K instruction oracle. JSON input/output; no ECU connection."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'data/verification/python'))
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN
from unicorn.m68k_const import *

results = []
for case in json.load(sys.stdin):
    cpu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
    cpu.ctl_set_cpu_model(UC_CPU_M68K_M68020)
    cpu.mem_map(0, 0x10000)
    cpu.mem_write(0x1000, bytes(case['code']))
    cpu.mem_write(0x2000, bytes(case['memory']))
    cpu.reg_write(UC_M68K_REG_SR, case['sr'])
    for i in range(8):
        cpu.reg_write(UC_M68K_REG_D0 + i, case['d'][i])
        cpu.reg_write(UC_M68K_REG_A0 + i, case['a'][i])
    cpu.emu_start(0x1000, 0x1000 + len(case['code']), count=1)
    # Materialize lazy condition codes through a real MOVE SR,D7 instruction.
    saved_d7 = cpu.reg_read(UC_M68K_REG_D7)
    saved_pc = cpu.reg_read(UC_M68K_REG_PC)
    cpu.mem_write(0x1800, bytes.fromhex('40c7'))
    cpu.emu_start(0x1800, 0x1802, count=1)
    sr = cpu.reg_read(UC_M68K_REG_D7) & 0xffff
    cpu.reg_write(UC_M68K_REG_D7, saved_d7)
    results.append(dict(d=[cpu.reg_read(UC_M68K_REG_D0 + i) for i in range(8)],
                        a=[cpu.reg_read(UC_M68K_REG_A0 + i) for i in range(8)],
                        sr=sr, pc=saved_pc,
                        memory=list(cpu.mem_read(0x2000, 0x100))))
json.dump(results, sys.stdout)
