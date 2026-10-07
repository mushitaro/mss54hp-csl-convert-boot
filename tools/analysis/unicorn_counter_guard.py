"""Independent execution of the new loader's pure pre-erase AIF guard.
No flash helper substitutions: stop before erase/program starts."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'data/verification/python'))
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_CODE
from unicorn.m68k_const import *

out = Path('data/verification')
labels = json.loads((out / 'replace.json').read_text())['labels']
entry, ready, refused = [0x8000 + labels[k] for k in ('validate_counter', 'mode_ready', 'giveup')]
count = 0
for used in range(65):
    for marker in (0, 0x00ff, 0xff00, 0xf500, 0x00f5):
        cpu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
        cpu.ctl_set_cpu_model(UC_CPU_M68K_M68020)
        cpu.mem_map(0, 0x1000000)
        cpu.mem_write(0x8000, (out / 'replace.gnu.bin').read_bytes())
        cpu.mem_write(0x3ffc, b'MM')
        counter = bytearray(b'\xff' * 128)
        counter[:used * 2] = bytes(used * 2)
        if used:
            counter[used * 2 - 2:used * 2] = marker.to_bytes(2, 'big')
        cpu.mem_write(0x4800, bytes(counter))
        cpu.reg_write(UC_M68K_REG_SR, 0x2700)
        def stop(uc, address, size, user_data):
            if address in (ready, refused):
                uc.emu_stop()
        cpu.hook_add(UC_HOOK_CODE, stop)
        cpu.emu_start(entry, 0x100000, count=5000)
        accepted = 1 <= used <= 55 and marker == 0x00ff
        assert cpu.reg_read(UC_M68K_REG_PC) == (ready if accepted else refused), (used, marker)
        if accepted:
            assert cpu.reg_read(UC_M68K_REG_D5) == 1
            assert cpu.reg_read(UC_M68K_REG_A3) == 0x4800 + used * 2 - 2
            assert cpu.reg_read(UC_M68K_REG_A4) == 0x4800 + used * 2
        assert bytes(cpu.mem_read(0x4800, 128)) == bytes(counter)
        count += 1
print(f'Unicorn counter guard: {count} cases, no AIF writes, exact bounds and marker checks agree')
