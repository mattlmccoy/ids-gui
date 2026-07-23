# M0 Runbook — Toolchain + prove reflash-to-stock rollback

Do this **on the Windows lab PC that's connected to the NANO 700**, before ever flashing a modified
build. Goal: confirm the flash toolchain works and **prove you can always reflash working firmware** —
the rollback that makes every later experiment recoverable. Gate to pass: working firmware reflashes
cleanly and the GUI reconnects and behaves exactly as before.

## Why this is safe (read first if you're nervous)

Two independent safety nets mean a bad flash is **recoverable, not a brick**:

1. **You (almost certainly) cannot brick a Portenta H7 with `arduino-cli upload`.** It writes only the
   *application* region (`0x08040000`+). The factory **DFU bootloader** in the low 256 KB is never
   touched and is always reachable by **double-tapping the board's reset button**. So even a completely
   broken app image → double-tap reset → reflash a good one. (The build folder even ships a separate
   `*.with_bootloader.hex`, confirming the plain `.ino.bin` is app-only.)

2. **You make your own guaranteed rollback before flashing anything** — see Step 0. Rather than trusting
   that the repo `.bin` byte-matches whatever is on the board today, you first **dump the currently-
   running firmware to a file**. That dump *is* the machine's exact working image; reflashing it restores
   precisely what works now.

So: the board can be re-entered via DFU no matter what, and you'll have a byte-exact copy of the current
working firmware in hand before you take any risk. If the dump is blocked (see Step 0), the repo `.bin`
plus the behavior check in Step 6 is the fallback rollback.

## Where things are
- Vendor release folder: `NANO_SINGLE_R17_RELEASE (1)\` (sibling of the `ids-gui` repo). It contains:
  - `arduino-cli.exe` — the flasher
  - `INSTALL.BAT` — installs the core + uploads the stock `.bin` (auto-detects the port)
  - `FIND-PORT.BAT` — lists boards/ports
  - `build\arduino.mbed_portenta.envie_m7\NANO_SINGLE_R17_RELEASE.ino.bin` — **the golden stock image**
- Board: Arduino **Portenta H7**, FQBN `arduino:mbed_portenta:envie_m7`, target core `cm7`.
- Stock firmware self-reports `SoftwareRev = NANO_R17_RELEASE` (per the M1 spec).

## Step 0 — Make your rollback images (do FIRST, before anything else)

**(a) Keep the vendor image.** Copy the whole `build\arduino.mbed_portenta.envie_m7\` folder somewhere
safe (and a second location off this PC). `NANO_SINGLE_R17_RELEASE.ino.bin` is a rollback — never
overwrite it. `SoftwareRev` for it is `NANO_R17_RELEASE`.

**(b) Dump the firmware that's running RIGHT NOW (the better rollback).** This captures the machine's
exact current working image, independent of whether the repo `.bin` matches it.
- Install `dfu-util` (e.g. `winget install dfu-util`, or the STM32 tools) — or STM32CubeProgrammer if you
  have an ST-LINK probe.
- Put the Portenta in DFU: **double-tap its reset button** (the built-in green LED fades in/out = DFU mode).
- List it: `dfu-util -l` (look for the Portenta / STM32 device, note its alt settings).
- Read the internal flash to a file:
  `dfu-util -a 0 -s 0x08000000:0x200000 -U board_current_R17.bin`
  (0x08000000 = flash base incl. bootloader; 0x200000 = 2 MB, the H747 internal flash. Adjust the alt
  `-a` / size to what `-l` reports.)
- **Save `board_current_R17.bin` in two places.** This is your byte-exact rollback of the working machine.

**If the dump fails / is refused:** the production firmware likely has **readout protection (RDP)**
enabled — reading is blocked *by design* (you'd see an error, not a brick). That's fine: fall back to the
vendor `.bin` from (a), and treat the Step 5→6 reflash-and-behavior-check as the proof that it's a valid
rollback. Do **not** try to clear RDP — a full RDP regression can mass-erase the chip.

## Step 1 — Confirm the toolchain
Open **cmd** in the `NANO_SINGLE_R17_RELEASE (1)` folder and run:
```
arduino-cli.exe version
arduino-cli.exe core install arduino:mbed_portenta
arduino-cli.exe core list
```
Expect `arduino:mbed_portenta` to appear in `core list`. (This install is exactly what `INSTALL.BAT` does.)

## Step 2 — Find the board / COM port
With the NANO 700 controller plugged in via USB:
```
arduino-cli.exe board list
```
Look for a row **"Arduino Portenta H7"** and note its port (e.g. `COM5`). (`FIND-PORT.BAT` runs this.)
- Not listed? Check the USB cable/power, then **double-tap the Portenta's reset button** to re-enumerate,
  and re-run.

## Step 3 — Capture the known-good baseline (before touching firmware)
1. Open the IDS GUI (desktop Chrome/Edge → the app), **Connect** to the controller.
2. Note current behavior: modes, Vacuum reading, temps, `SoftwareRev` on the Debug tab.
3. **While you're here, grab the two M1 "verify live" items:**
   - **Flush timing** — request **Flush** and time how long its outputs stay on. (M1 code analysis says
     ~5 s auto-clear; the old audit said it clears immediately. This settles the "Flush defect" question.)
   - **`GET ALL` capture** — Debug tab → export the diagnostic bundle (or copy the raw telemetry) so we
     can see the exact JSON keys the firmware emits (confirms `Vacuum_STATE` / `RecirculationPump_STATE`).
4. **Disconnect** the GUI (frees the COM port for flashing).

## Step 4 — (Optional) read the board's current flash
Only if you want to confirm the on-board image matches the repo `.bin`. Needs `dfu-util` or
STM32CubeProgrammer: double-tap reset → DFU, then read. **Skip if not needed** — the repo `.bin` is the
golden image regardless.

## Step 5 — Reflash stock R17 (the rollback proof)
Make sure the GUI (and any serial monitor) is closed so the COM port is free. Then run (replace `COMx`):
```
arduino-cli.exe upload --fqbn arduino:mbed_portenta:envie_m7 --input-file build\arduino.mbed_portenta.envie_m7\NANO_SINGLE_R17_RELEASE.ino.bin --board-options target_core=cm7 --port COMx
```
(Equivalently, just run `INSTALL.BAT` — it auto-detects the port and runs this same command.) Watch for a
successful upload / verify message.

## Step 6 — Verify the rollback (the M0 gate)
Reconnect the IDS GUI and confirm:
- It connects at 115200 baud.
- `SoftwareRev` reads **`NANO_R17_RELEASE`** (Debug tab / SW-rev badge).
- Telemetry populates and behavior matches your Step 3 baseline.

✅ If all three hold, **rollback is proven** — any future bad build is recoverable by repeating Step 5.
M0 gate passed; M1 (spec) is already done, so the next hands-on step after this is M2 (a minimal sketch
that speaks the serial protocol).

## Safety
- Flashing **reboots the controller**. Only flash with fluidics in a safe state — pumps/heaters off,
  nothing mid-cycle, E-stop reachable. The controller runs its own logic while the GUI is disconnected.
- Flash only with the COM port free (GUI disconnected).

## Troubleshooting
- **Port busy / access denied** → close the GUI and any serial monitor, retry.
- **Board not listed** → double-tap reset, replug, confirm `core install` succeeded.
- **Upload fails / hangs** → double-tap reset to force the bootloader, then retry; or run `INSTALL.BAT`.

## Report back after M0
Tell me: the `arduino-cli` version, whether the reflash + GUI reconnect passed, and the two live findings
(Flush hold time, and the `GET ALL` key list). That unblocks M2 and resolves the Flush-defect question.
