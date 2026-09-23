; ============================================================================
;  PROBE LOADER  -  MSS54HP bootloader replacement, step one
; ============================================================================
;
;  This is the FIRST piece of code that will ever be armed on a real DME, and
;  it deliberately does not touch the bootloader.
;
;  ## Why a probe exists at all
;
;  The only way to run any loader is to program the magic word 5AA556C9 into
;  flash 0xFFFC. From that moment the reset handler at 0x24A jumps to 0x8000
;  on every power-up, before the SIM, the stack or the K-line come up. If the
;  loader is defective, the ECU can never be reached over OBD again - with the
;  bootloader still perfectly intact. So there is no such thing as a safe
;  rehearsal: the first arming IS the first execution.
;
;  Therefore the first thing ever armed should be the smallest program that
;  proves the machine setup works, and its first successful flash operation
;  should be to DISARM itself.
;
;  ## What it does
;
;      set up the machine (interrupts, RAM, stack)
;      copy a programming stub into RAM
;      program 0000 0000 over the magic at 0xFFFC   <- disarms the ECU
;      read it back and confirm
;      stop servicing the watchdog and spin
;
;  The watchdog then resets the CPU, the reset handler finds no magic, and the
;  ECU boots normally. Success and failure both end in a reset; the difference
;  is whether the magic is gone.
;
;  ## Entry state, from 0x1BDE
;
;      move.w #$2700,sr / reset / ... / lea $8000,a0 / jmp (a0)
;
;  So on entry: interrupts masked, all on-chip modules freshly reset, SRAM and
;  TPURAM DISABLED, port directions all inputs, chip selects at reset values,
;  A7 unreliable (0 on the reset path), VBR = 0.
;
;  ## Two things this deliberately does NOT do
;
;  1. **It does not touch the chip selects.** CSORBT's reset value is 0x7B70:
;     R/W = read AND write, 13 wait states. Flash is already writable, slowly.
;     The resident firmware reconfigures CS only to go faster. Not touching
;     them removes the single most likely way to arm an ECU and then find its
;     writes silently discarded.
;
;  2. **It does not disable the watchdog.** Leaving it running is what makes
;     failure survivable: any hang ends in a reset rather than a dead ECU.
;     Clearing the magic is itself safe to interrupt, because a partially
;     cleared magic no longer matches.
;
;  ## The first-byte rule
;
;  Both the reset path and cmd 0x34 test the top byte of the longword at
;  0x8000 and refuse 0x01 on the master / 0x02 on the slave, so that a genuine
;  calibration is never "run". This starts with MOVE to SR = 0x46, which is
;  safe on both.
; ============================================================================

; ---- addresses -------------------------------------------------------------
; RAMBAH:RAMBAL as one longword, and the SRAM module control register.
; The resident reset code programs exactly these values.
RAMBASE     equ     $00ffe000
STACKTOP    equ     $00ffe800
STUBDEST    equ     $00ffe900
MAGICLO     equ     $0000fffe
MAGICHI     equ     $0000fffc

; ============================================================================
start:
        move.w  #$2700,sr               ; interrupts masked (first byte $46)

; ---- give the watchdog the longest timeout it has -------------------------
; SYPCR is write-once after a reset, and the RESET instruction in 0x1BDE
; reopened that window - the bootloader does not write SYPCR until 0x276,
; which is AFTER the magic check, so on this path the window is still ours.
; $BD is what BMW's own application writes: SWE set, SWT = longest.
;
; This is best-effort: entered through the cmd 0x34 dispatcher instead, the
; bootloader will already have claimed the write and this is ignored. So the
; loops below service the watchdog regardless rather than relying on it.
        move.b  #$bd,$00fffa21

; ---- enable the SRAM array -------------------------------------------------
; After the RESET instruction the array is disabled. A stub copied into RAM
; before this point would go nowhere, and the jump into it would land in
; unmapped space.
        move.l  #RAMBASE,$00fffb44      ; RAMBAH:RAMBAL
        clr.w   $00fffb40               ; RAMMCR: leave low-power stop

        lea     STACKTOP,a7             ; a stack we chose, not one we inherited

; ---- copy the programming stub into RAM ------------------------------------
; The stub must run from RAM: Am29F400B is a single bank with no
; read-while-write, so while a program is in progress an instruction fetch
; from flash returns status bits and the CPU executes them as opcodes. The
; stub programs a word in SA3, and this code is itself in SA3.
        lea     stub(pc),a0
        lea     STUBDEST,a1
        move.w  #(stub_end-stub)/2-1,d0
copy:   move.b  #$55,$00fffa27          ; the copy loop is long enough to matter if the
        move.b  #$aa,$00fffa27          ; watchdog came up on its shortest timeout
        move.w  (a0)+,(a1)+
        dbra    d0,copy

; ---- disarm: program zeros over the magic ---------------------------------
; NOR programming can only clear bits, so 5AA556C9 -> 00000000 needs no erase.
; This is done FIRST, before anything else, so that from here on a failure
; leaves an ECU that boots normally.
        lea     MAGICHI,a5
        moveq   #0,d1
        jsr     STUBDEST
        tst.b   d0
        bne.w   failed

        lea     MAGICLO,a5
        moveq   #0,d1
        jsr     STUBDEST
        tst.b   d0
        bne.w   failed

; ---- verify ----------------------------------------------------------------
; Read the magic back. The device returns to read-array after a successful
; program, so this is a real array read.
        lea     MAGICHI,a5
        move.w  (a5),d2
        bne.w   failed
        lea     MAGICLO,a5
        move.w  (a5),d2
        bne.w   failed

; ---- done ------------------------------------------------------------------
; Stop servicing the watchdog and spin. It resets the CPU, the reset handler
; finds no magic, and the ECU boots normally. Leaving by watchdog rather than
; by RESET+JMP means we depend on nothing else being correct.
done:   bra.b   done

; A failure lands here. The magic may or may not be cleared; either way the
; watchdog takes us out, and a partially cleared magic does not match.
failed: bra.b   failed

; ============================================================================
;  The RAM-resident programming stub.
;
;  Entry: A5 = word address to program, D1 = data.
;  Exit:  D0 = 0 on success, non-zero on failure.
;
;  This mirrors BMW's flash_program_word (master 0x348E) including the details
;  that matter: word-width status reads, the DQ7-after-DQ5 re-check, and
;  servicing the watchdog inside the polling loop.
; ============================================================================
stub:
        move.w  #$f0,(a5)               ; reset / read-array
        moveq   #2,d0                   ; default: failure
        move.w  #$aa,$0000aaaa          ; unlock 1
        move.w  #$55,$5554.w            ; unlock 2
        move.w  #$a0,$0000aaaa          ; program setup
        move.w  d1,(a5)                 ; data cycle - the device is now busy

poll:   move.b  #$55,$00fffa27          ; service the watchdog INSIDE the loop
        move.b  #$aa,$00fffa27
        move.w  (a5),d2                 ; status, read as a word
        move.w  d2,d3
        eor.w   d1,d2
        andi.w  #$80,d2                 ; DQ7 matches the data?
        beq.b   ok
        andi.w  #$20,d3                 ; DQ5 - timeout?
        beq.b   poll
        move.w  (a5),d2                 ; DQ7 must be re-read after DQ5
        eor.w   d1,d2
        andi.w  #$80,d2
        beq.b   ok
        moveq   #6,d0                   ; genuine timeout
        move.w  #$f0,(a5)               ; leave the device in read-array
        rts

ok:     moveq   #0,d0
        rts
stub_end:
