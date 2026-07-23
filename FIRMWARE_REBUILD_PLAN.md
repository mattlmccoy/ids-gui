# Firmware Rebuild Plan — Own & Rebuild R17

Goal: replace our dependence on APS by rebuilding the NANO 700 controller firmware ("R17")
into **clean, editable, maintainable Arduino source we own** — so we can fix defects (the Flush
timer) and add features (inlet/return pressure telemetry) ourselves. This plan is the milestone
breakdown agreed in the design discussion.

## Established facts (the ground we build on)

- **Platform:** Arduino **Portenta H7** (STM32H747, Cortex-M7). FQBN `arduino:mbed_portenta:envie_m7`,
  target core `cm7`.
- **No source exists.** Only compiled artifacts in `../NANO_SINGLE_R17_RELEASE (1)/build/arduino.mbed_portenta.envie_m7/`:
  `.ino.bin`, `.ino.hex`, `.ino.with_bootloader.hex`, `.ino.elf` (**unstripped, 6.6 MB, with DWARF debug info**), `.ino.map`.
- **APS is unresponsive** → all work is DIY. Arduino IDE cannot decompile a binary to source.
- **Hardware:** the real **NANO 700 only** (no spare Portenta). Every flash/test is on live fluidics.
- **Dev/flash environment:** a separate **Windows lab PC** that already has the vendor `arduino-cli.exe`
  and installs the `arduino:mbed_portenta` core via `INSTALL.BAT`.
- **Behavior is already partly reverse-engineered** in `OPERATING_MODES_AUDIT.md` (mode→pump/valve
  truth tables, boot timers, named functions like `Do_Stop()`/`flushModeTimer`, the Flush defect) and
  mirrored in the GUI's `js/firmware-simulator.js`.

## Approach (chosen): clean-room behavioral re-authoring, executed incrementally

Write **new, clean Arduino source** that reproduces R17's *observable behavior*, using Ghidra's
decompilation of the unstripped ELF **plus** `OPERATING_MODES_AUDIT.md` as reference. Verify at the
**protocol level** (does our firmware emit the same telemetry keys/values and drive the same
pump/valve/heater readbacks as R17?) using the existing **GUI + firmware simulator as the test oracle**.
Rejected: mechanically recompiling Ghidra's C output — for a statically-linked mbed/RTOS binary it is
enormous, unreadable, and not realistically recompilable, and it wouldn't be maintainable.

## Safety model (non-negotiable, every milestone)

- The original `.ino.bin` is the **instant rollback** — a bad build is recoverable, not a brick.
  Keep a known-good copy; reflash it to return to stock R17 at any time.
- Test with the fluidics in a **safe state** wherever possible (pumps that can't run dry, drains routed,
  E-stop reachable, operator at the machine). Never trust controller readback as proof of physical safety.
- Flash **incrementally** — one subsystem per build — and command all modes OFF at test boundaries.

## Milestones

### M0 — Toolchain + rollback proof (foundation)
On the Windows lab PC: confirm `arduino-cli` + the `arduino:mbed_portenta` core, read the board's current
firmware, and **reflash the original `.ino.bin`** to prove the rollback path works.
- Deliverable: a written build → flash → rollback runbook.
- **Gate:** stock R17 reflashes cleanly; the GUI reconnects and behaves exactly as before.

### M1 — Decompile + document (understand)
Load the unstripped `.ino.elf` in **Ghidra**. Produce a firmware spec covering: the **pin map**
(GPIO → each pump/valve/heater-SSR/float/vacuum/thermocouple), the **serial JSON protocol** (exact keys,
framing, parser), the **mode state machines** (Run/Purge/Flush/Drain/Bypass) with their timers, **setpoint**
handling, **heater/thermocouple** logic (incl. the HTC 999 sentinel), **error/alarm bit** encoding, and the
**watchdog**. Cross-check against `OPERATING_MODES_AUDIT.md`, the GUI's consumed-field list, and the
simulator's truth tables.
- **Gate:** every telemetry key the GUI consumes maps to a firmware source; every mode's output set
  matches the documented truth table.

### M2 — Minimal sketch: protocol round-trip (prove the loop on OUR code)
Write a clean minimal Portenta sketch that implements only the **serial JSON protocol** — answers
`{"GET":"ALL"}` with a representative frame, accepts setpoint/mode commands, echoes state — with **no real
I/O**. Build it, flash it, and confirm the **GUI connects, polls, and displays it**.
- **Gate:** GUI shows Connected, telemetry populates, mode buttons reflect commanded state — actuators
  in a safe state. This proves build → flash → GUI end-to-end on code we wrote.

### M3 — Port core behavior (the rebuild)
Implement real behavior **subsystem by subsystem**, each verified against the machine before moving on:
1. Telemetry/sensor reads — vacuum, fluid/heater temps, floats.
2. **Run** mode — vacuum + recirculation + input pumps, manifold valves 1&2, startup/shutdown timers.
3. Setpoints (vacuum %, recirc drive, temperature) + **heater control** (SSR + thermocouple + HTC fault).
4. **Purge / Flush / Drain / Bypass** modes.
5. Error/alarm encoding + **watchdog**.
- Verification per subsystem: compare our firmware's readbacks/telemetry against the documented R17 truth
  tables and the real machine, using the **GUI as the oracle**; roll back to stock between risky tests.
- **Gate (per subsystem):** protocol-equivalent readbacks **and** operator-confirmed correct physical
  actuation in a safe state.

### M4 — Fix + extend (the payoff of owning it)
- Fix the **R17 Flush-timer defect** (documented: `flushModeTimer` initialized once at boot, never reset).
- Add **inlet/return pressure telemetry** (`InletPressure_STATE` / `ReturnPressure_STATE` in psi) once the
  sensors exist — which lights up the already-built (currently gated) GUI dual-pressure feature end-to-end.
- **Gate:** Flush holds its outputs correctly; pressure keys appear in the GUI when sensors are present.

### M5 — Harden + document
Full regression against the commissioning workflow; document the rebuilt firmware and finalize the
build/flash/rollback runbook.
- **Gate:** the guided commissioning workflow passes end-to-end on the rebuilt firmware.

## Toolchain
- **Build/flash:** `arduino-cli` + `arduino:mbed_portenta:envie_m7` core (target `cm7`); flash via the
  vendor's one-liner (from `INSTALL.BAT`): `arduino-cli upload --fqbn arduino:mbed_portenta:envie_m7
  --input-file <sketch>.ino.bin --board-options target_core=cm7 --port <PORT>`.
- **Decompile:** Ghidra (uses the ELF's symbols + DWARF).
- **Read the board (optional):** DFU via double-tap reset + `dfu-util`, or SWD via OpenOCD/STM32CubeProgrammer —
  only yields the same binary, not source; pursue only if the machine runs a newer build than the repo copy.

## Verification strategy
The existing **GUI + firmware simulator are the test oracle**. Acceptance is **protocol equivalence**
(same JSON keys/values), **mode→readback truth tables**, and the **commissioning workflow** as the
end-to-end gate. This is out of scope for the `ids-gui` repo itself; the reconstructed sketch lives in a
separate firmware project.

## Risks
- Undocumented firmware details → mitigated by protocol-diff testing against the real machine + the unstripped ELF.
- Live-hardware-only testing → mitigated by the `.bin` rollback, safe-state gating, and incremental flashing.
- Portenta mbed/RTOS + watchdog/timing nuances → surface early in M2/M3, verify against stock behavior.

## Immediate next action
Start **M0** on the Windows lab PC: confirm the toolchain and prove the reflash-to-stock rollback. Nothing
else is safe to attempt until rollback is proven.
