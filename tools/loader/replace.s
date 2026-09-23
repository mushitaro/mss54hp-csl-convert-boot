; ============================================================================
;  BOOTLOADER REPLACEMENT LOADER  -  MSS54HP
; ============================================================================
;
;  Runs from the calibration sector (SA3) and rewrites the bootloader sector
;  (SA0) with an image staged alongside it. This is the only code in the
;  project that can permanently destroy an ECU, so every decision below is
;  written down with its reason.
;
;  ## Staged sector layout (see blLoader.ts, which builds it)
;
;      CPU $8000   this code
;      CPU $9000   the 16 KiB replacement bootloader image
;      CPU $FFFC   the magic 5AA556C9 that made the reset handler come here
;
;  ## Entry state, from 0x1BDE
;
;  Interrupts masked, all on-chip modules freshly RESET, SRAM and TPURAM
;  disabled, ports all inputs, chip selects at reset values, A7 unreliable,
;  VBR = 0.
;
;  ## Order of operations, and why it is this order
;
;      1  set up the machine          (proven separately by probe.s)
;      2  move VBR to a RAM table     - SA0 is about to stop existing
;      3  copy the flash routines to RAM
;      4  CLEAR THE MAGIC             - disarm before anything destructive
;      5  sanity-check the staged image
;      6  erase SA0
;      7  program 16 KiB into SA0
;      8  verify, and retry from 6 on mismatch
;      9  spin; the watchdog resets us into the new bootloader
;
;  Step 4 comes before step 5 deliberately. If the staged image were bad and
;  the magic were still set, the ECU would re-enter this loader on every
;  power-up forever - a brick with an intact bootloader, recoverable only by
;  BDM. Clearing the magic first means a refusal at step 5 leaves an ECU that
;  boots normally.
;
;  From step 6 the ECU is committed: SA0 holds no reset vector until step 7
;  finishes, and the magic can no longer help because the magic check itself
;  lives in SA0. That window is irreducible. It is also short, needs no
;  communication, and is the only part of the operation that a power failure
;  can turn into a brick - which is why the operator requirement is a bench
;  supply, not a battery.
;
;  ## Why VBR must move (step 2)
;
;  The 68k exception vectors live at address 0, inside SA0. Once SA0 is
;  erased, ANY exception - bus error, address error, a level 7 interrupt,
;  which SR = $2700 does not mask - would fetch its vector from erased flash,
;  get $FFFFFFFF, and take a double bus fault. The CPU halts and the ECU is
;  gone. So before the erase, VBR points at a RAM table whose every entry is a
;  halt loop in RAM. An exception then parks the CPU harmlessly and the
;  watchdog resets it.
; ============================================================================

; ---- RAM layout ------------------------------------------------------------
RAMBASE     equ     $00ffe000       ; SRAM array base, as the firmware sets it
VECTORS     equ     $00ffe000       ; 256 vectors x 4 bytes
VECTOREND   equ     $00ffe400
HALTADDR    equ     $00ffe400       ; where every vector points
ERASEADDR   equ     $00ffe420       ; erase routine, copied from flash
PROGADDR    equ     $00ffe4a0       ; program-block routine, copied from flash
STACKTOP    equ     $00ffef00

; ---- flash layout ----------------------------------------------------------
SA0BASE     equ     $00000000       ; bootloader sector, 16 KiB
IMAGESRC    equ     $00009000       ; staged replacement image, in SA3
IMAGEWORDS  equ     $00002000       ; 16 KiB / 2
MAGICHI     equ     $0000fffc
MAGICLO     equ     $0000fffe
RESETVEC    equ     $00009004       ; the image's initial PC longword
EXPECTPC    equ     $00000200       ; every MSS54 bootloader starts here

WDOG        equ     $00fffa27
RETRIES     equ     3

; ============================================================================
start:
        move.w  #$2700,sr               ; first byte $46 - the gate at $8000
        move.b  #$bd,$00fffa21          ; longest watchdog timeout, if still ours

; ---- 1. enable the SRAM array ---------------------------------------------
        move.l  #RAMBASE,$00fffb44      ; RAMBAH:RAMBAL
        clr.w   $00fffb40               ; RAMMCR: leave low-power stop
        lea     STACKTOP,a7

; ---- 2. build a RAM vector table and point VBR at it -----------------------
; Every vector goes to a halt loop in RAM. After SA0 is erased this is the
; only thing standing between an unexpected exception and a dead ECU.
        lea     HALTADDR,a0
        move.w  #$60fe,(a0)             ; BRA.B to itself - a two-byte halt

        lea     VECTORS,a0
        move.l  #HALTADDR,d0
        move.w  #255,d1
vecfill:
        move.b  #$55,WDOG
        move.b  #$aa,WDOG
        move.l  d0,(a0)+
        dbra    d1,vecfill

        lea     VECTORS,a0
        movec   a0,vbr

; ---- 3. copy the flash routines into RAM -----------------------------------
; They must run from RAM: Am29F400B has no read-while-write, so during an
; erase or program an instruction fetch from flash returns status bits.
        lea     erase_stub(pc),a0
        lea     ERASEADDR,a1
        move.w  #(erase_end-erase_stub)/2-1,d0
copy1:  move.b  #$55,WDOG
        move.b  #$aa,WDOG
        move.w  (a0)+,(a1)+
        dbra    d0,copy1

        lea     prog_stub(pc),a0
        lea     PROGADDR,a1
        move.w  #(prog_end-prog_stub)/2-1,d0
copy2:  move.b  #$55,WDOG
        move.b  #$aa,WDOG
        move.w  (a0)+,(a1)+
        dbra    d0,copy2

; ---- 4. disarm: clear the magic -------------------------------------------
; 5AA556C9 -> 00000000 only clears bits, so no erase is needed. From here a
; failure leaves an ECU that boots normally.
        lea     MAGICHI,a1
        moveq   #0,d1
        jsr     PROGADDR_ONE
        tst.b   d0
        bne.w   giveup

        lea     MAGICLO,a1
        moveq   #0,d1
        jsr     PROGADDR_ONE
        tst.b   d0
        bne.w   giveup

; ---- 5. sanity-check the staged image --------------------------------------
; The cheapest check that means something: a real MSS54 bootloader's reset
; vector has initial PC = $00000200. If the sector was not staged, or was
; staged wrong, this is $FFFFFFFF and we must not erase anything.
        move.l  RESETVEC,d0
        cmpi.l  #EXPECTPC,d0
        bne.w   giveup

; ---- 6-8. erase, program, verify, retry ------------------------------------
        moveq   #RETRIES,d6

attempt:
        move.b  #$55,WDOG
        move.b  #$aa,WDOG

        lea     SA0BASE,a5
        jsr     ERASEADDR
        tst.b   d0
        bne.w   nextattempt

        lea     IMAGESRC,a0
        lea     SA0BASE,a1
        move.l  #IMAGEWORDS,d7
        jsr     PROGADDR
        tst.b   d0
        bne.w   nextattempt

; ---- verify: every word of SA0 must equal the staged image -----------------
; Both operands are flash reads with the device idle, so this is a real
; comparison and not a status read.
        lea     IMAGESRC,a0
        lea     SA0BASE,a1
        move.l  #IMAGEWORDS,d7
vloop:  move.b  #$55,WDOG
        move.b  #$aa,WDOG
        move.w  (a0)+,d1
        move.w  (a1)+,d2
        cmp.w   d2,d1
        bne.b   nextattempt
        subq.l  #1,d7
        bne.b   vloop

; ---- 9. success ------------------------------------------------------------
; Stop servicing the watchdog. It resets the CPU; the reset handler now runs
; the NEW bootloader, finds no magic, and boots normally. Leaving by watchdog
; rather than by RESET+JMP means we depend on nothing else being correct.
done:   bra.b   done

nextattempt:
        subq.l  #1,d6
        bne.w   attempt

; Out of retries, or refused before touching anything. If we got here before
; step 6 the ECU is fine; if after, it needs BDM either way, and spinning is
; no worse than resetting into an invalid SA0.
giveup: bra.b   giveup

; ============================================================================
;  RAM-resident routines. Everything below is copied to RAM before use.
; ============================================================================

; ---- erase one sector ------------------------------------------------------
; Entry: A5 = an address inside the sector.  Exit: D0 = 0 on success.
; Mirrors BMW's flash_erase_sector (master $35DA), including the DQ7 re-read
; after DQ5 and servicing the watchdog inside the poll loop.
erase_stub:
        move.w  #$f0,(a5)
        moveq   #4,d0
        move.w  #$aa,$0000aaaa
        move.w  #$55,$5554.w
        move.w  #$80,$0000aaaa
        move.w  #$aa,$0000aaaa
        move.w  #$55,$5554.w
        move.w  #$30,(a5)
epoll:  move.b  #$55,WDOG
        move.b  #$aa,WDOG
        move.w  (a5),d2
        tst.b   d2
        bmi.b   edone
        andi.w  #$20,d2
        beq.b   epoll
        move.w  (a5),d2
        tst.b   d2
        bmi.b   edone
        moveq   #6,d0
        move.w  #$f0,(a5)
        rts
edone:  moveq   #0,d0
        rts
erase_end:

; ---- program a block -------------------------------------------------------
; Entry: A0 = source (flash), A1 = destination (flash), D7 = word count.
; Exit:  D0 = 0 on success.
;
; The whole loop lives in RAM. The source is read from flash between program
; pulses, when the device is back in read-array mode - never while it is busy.
prog_stub:
pnext:  move.w  (a0)+,d1                ; source word; device idle here
ponew:  move.w  #$f0,(a1)               ; read-array
        move.w  #$aa,$0000aaaa
        move.w  #$55,$5554.w
        move.w  #$a0,$0000aaaa
        move.w  d1,(a1)                 ; data cycle; device now busy
ppoll:  move.b  #$55,WDOG
        move.b  #$aa,WDOG
        move.w  (a1),d2
        move.w  d2,d3
        eor.w   d1,d2
        andi.w  #$80,d2                 ; DQ7 matches?
        beq.b   pok
        andi.w  #$20,d3                 ; DQ5 timeout?
        beq.b   ppoll
        move.w  (a1),d2                 ; DQ7 must be re-read after DQ5
        eor.w   d1,d2
        andi.w  #$80,d2
        beq.b   pok
        moveq   #6,d0
        move.w  #$f0,(a1)
        rts
pok:    addq.l  #2,a1
        subq.l  #1,d7
        bne.b   pnext
        moveq   #0,d0
        rts

; ---- program a single word -------------------------------------------------
; A second entry point into the same loop, for clearing the magic.
; Entry: A1 = address, D1 = data. It sits INSIDE the copied block so that the
; one copy loop carries both entry points, and its branch is PC-relative so it
; works unchanged at its RAM address.
prog_one:
        moveq   #1,d7
        bra.b   ponew
prog_end:

; Resolved after the labels above exist. equ is evaluated where it appears, so
; this line has to follow prog_one rather than precede it.
PROGADDR_ONE equ PROGADDR+prog_one-prog_stub
