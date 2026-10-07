"""Execute the actual assembled 16 KiB CRC routine on independent M68020 core.

CPU32-specific peripherals and whole-loader flash operations are not covered here.
"""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'data/verification/python'))
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN
from unicorn.m68k_const import *

out = Path('data/verification')
entry = json.loads((out / 'replace.json').read_text())['labels']['image_crc'] + 0x8000
for i, case in enumerate(json.loads((out / 'crc-cases.json').read_text())):
    cpu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
    cpu.ctl_set_cpu_model(UC_CPU_M68K_M68020)
    cpu.mem_map(0, 0x1000000)
    cpu.mem_write(0x8000, (out / 'replace.gnu.bin').read_bytes())
    cpu.mem_write(0x9000, bytes(case['bytes']))
    cpu.mem_write(0xffe800, bytes.fromhex('00007000'))
    cpu.reg_write(UC_M68K_REG_SR, 0x2700)
    cpu.reg_write(UC_M68K_REG_A7, 0xffe800)
    cpu.reg_write(UC_M68K_REG_A0, 0x9000)
    cpu.reg_write(UC_M68K_REG_D6, 3)
    cpu.emu_start(entry, 0x7000, count=2000000)
    assert cpu.reg_read(UC_M68K_REG_PC) == 0x7000, 'CRC routine did not return'
    assert cpu.reg_read(UC_M68K_REG_D0) & 0xffff == case['expected']
    assert cpu.reg_read(UC_M68K_REG_D6) == 3, 'retry count clobbered'
    assert cpu.reg_read(UC_M68K_REG_A0) == 0xd000, 'CRC did not cover all 16 KiB'
    print(f'Unicorn CRC case {i}: all 16 KiB, CRC={case["expected"]:04x}, retry count preserved')
