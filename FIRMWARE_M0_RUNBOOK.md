# M0 Runbook — Toolchain + prove reflash-to-stock rollback

Do this **on the Windows lab PC that's connected to the NANO 700**, before ever flashing a modified
build. Goal: confirm the flash toolchain works and **prove you can always reflash stock R17** — the
rollback that makes every later experiment recoverable. Gate to pass: stock R17 reflashes cleanly and
the GUI reconnects and behaves exactly as before.

## Where things are
- Vendor release folder: `NANO_SINGLE_R17_RELEASE (1)\` (sibling of the `ids-gui` repo). It contains:
  - `arduino-cli.exe` — the flasher
  - `INSTALL.BAT` — installs the core + uploads the stock `.bin` (auto-detects the port)
  - `FIND-PORT.BAT` — lists boards/ports
  - `build\arduino.mbed_portenta.envie_m7\NANO_SINGLE_R17_RELEASE.ino.bin` — **the golden stock image**
- Board: Arduino **Portenta H7**, FQBN `arduino:mbed_portenta:envie_m7`, target core `cm7`.
- Stock firmware self-reports `SoftwareRev = NANO_R17_RELEASE` (per the M1 spec).

## Step 0 — Back up the golden image (do FIRST)
Copy the whole `build\arduino.mbed_portenta.envie_m7\` folder somewhere safe (and ideally a second
location off this PC). `NANO_SINGLE_R17_RELEASE.ino.bin` is your rollback — never overwrite it.

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
