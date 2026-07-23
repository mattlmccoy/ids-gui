# Firmware Spec — NANO_SINGLE_R17_RELEASE (Milestone M1)

Reverse-engineered specification of the APS NANO 700 controller firmware ("R17"), recovered
statically from the unstripped ELF for a clean re-implementation.

- **Target ELF:** `../NANO_SINGLE_R17_RELEASE (1)/build/arduino.mbed_portenta.envie_m7/NANO_SINGLE_R17_RELEASE.ino.elf`
  (ARM 32-bit, ELF little-endian, unstripped, DWARF, 6.97 MB).
- **Companion:** `NANO_SINGLE_R17_RELEASE.ino.map` (linker map), `.ino.bin` (306 228 bytes, the rollback image).
- **Method:** `nm` / `objdump --syms`, `objdump -d` (LLVM objdump / Apple LLVM 21), `objdump -s`,
  `objdump --dwarf`, `objdump -h`, `strings`, and Python-assisted register tracing. **No Ghidra/IDA.**
- **Confidence key:** ✅ established from symbols/DWARF/disassembly/strings · ⚠️ recovered but verify ·
  ❓ UNKNOWN, needs a Ghidra decompile pass or hardware/schematic.

Every claim below cites a symbol+address, a disassembled instruction, a `.data` byte range, a string, or the `.map`.

---

## 0. Headline findings (read first)

1. **The R17 Flush timer defect asserted in `OPERATING_MODES_AUDIT.md` is not supported by the code.**
   `Do_Stop` **does** call `MyTimer::reset(flushModeTimer)` on the Flush-OFF path (`0x80412a0`), every
   stopped cycle while Flush is off, and `flushModeTimer`'s interval **is 5000 ms** (set in the global
   constructor, `0x804526a`). So a Flush requested while stopped starts a fresh 5 s window and should hold
   its outputs for ~5 s before auto-clearing. The audit's finding #6 (and the GUI
   `firmware-simulator.js` "immediate clear" reproduction) appear **incorrect**. See §4.4 — verify live before acting.
2. **The I/O is not raw STM32 GPIO.** Pumps are PWM `speedPump` objects, the vacuum regulator is an
   Adafruit **MCP4728** quad-DAC (I2C 0x60), analog sensing is an Adafruit **ADS1115** (I2C 0x48),
   thermocouples are **MAX31855**/**MAX31865**, and every valve / float / SSR is a channel on **two
   ArduinoIOExpander** chips (I2C 0x23 and 0x22 — Portenta Machine Control I/O). Physical terminal numbers
   are behind the expanders and need the schematic. §3.
3. **Two comms watchdogs, not documented before:** `WatchdogTrigger_MODE` gates the 5 s mbed hardware
   watchdog (commanded reboot), and `LAN_HANDSHAKE`/`HANDSHAKE_Timer` force `Run_MODE=0` after 45 s of
   client silence. §8.
4. **GUI/firmware key mismatches:** the GUI reads `Vacuum_STATE` and `RecirculationPump_STATE`, but
   **neither exists as a string literal in R17.** §2.4.

---

## 1. Build / identity

| Item | Value | Evidence |
|---|---|---|
| Product string | `NANO_R17_RELEASE` (value of global `SoftwareRev`) | string `NANO_R17_RELEASE`; global `SoftwareRev` @ `0x240019b0` |
| Source tree | `C:\Users\jaren\Documents\GitHub\NanoIDS-Arduino\PRODUCTION\RELEASE\NANO_SINGLE_R17_RELEASE\NANO_SINGLE_R17_RELEASE.ino` | string table |
| Secondary version tag | `R15f` (a component/library rev) | string `R15f` |
| Toolchain | arm-none-eabi-gcc **7.2.1** (arduino `7-2017q4`), thumb `v7e-m` `fpv5` softfp | `.map` LOAD paths |
| JSON library | ArduinoJson **7.4.1** (`ArduinoJson::V741PB2`) | mangled symbols |
| RTOS/HAL | mbed-os, lwIP, Portenta Machine Control (`machinecontrol`) | symbols, `.map` |
| Start address | `0x08070e99` | `objdump -f` |

### Memory configuration (`.map` "Memory Configuration" + `objdump -h`)

| Region | Origin | Length | Use |
|---|---|---|---|
| FLASH | `0x08040000` | `0xC0000` (768 KB) | app image; **0x40000 (256 KB) below is the bootloader** |
| `.text` | `0x08040000` | `0x478B0` (~292 KB) | code + rodata (rodata merged into text) |
| `.data` | `0x24000000` (LMA `0x0808933C`) | `0x18F8` | initialized globals (setpoint defaults, error masks) |
| `.bss` | `0x24001900` | `0x10BD0` | zero-init globals (mode flags, pin objects, timers) |
| `.heap` | `0x240124D0` | `0x6D730` | heap |
| RAM (AXI/D1) | `0x24000000` | `0x80000` (512 KB) | app RAM |
| RAM_D2 | `0x30000000` | `0x48000` | `.lwip_sec` (Ethernet) |
| DTCMRAM | `0x20000298` | `0x1FD68` | stacks/fast RAM |

FQBN `arduino:mbed_portenta:envie_m7`, core `cm7` (STM32H747, Cortex-M7). Matches `FIRMWARE_REBUILD_PLAN.md`.

---

## 2. Serial JSON protocol

### 2.1 Transport & framing
- **USB serial** to the GUI at **115200 baud** (GUI `serial.js` `BAUD_RATE`, Arduino VID `0x2341`).
  Firmware port object `_UART_USB_` @ `0x24003654`.
- **Also an Ethernet server** path (lwIP `MbedServer`, default IP **192.168.1.26**, §5) handled in
  `Do_StateMachine` (`0x8045914`) with the same `Do_JSON` handler.
- **Inbound framing:** `serialEvent` (`0x8045860`) appends received chars to `inputString` (`0x24001ab4`)
  until newline, then sets `stringComplete` (`0x24001c30`). One JSON object per line.
- **Request → response, not streaming.** `Do_SerialLoop` (`0x80458c4`): when `stringComplete`, it calls
  `Do_JSON` (`0x8043668`), then `Print::println(outputString)` back to `_UART_USB_`, `flush()`, and clears
  `inputString`/`outputString`. So **every inbound line yields exactly one full telemetry frame.** This
  matches the GUI's 1 Hz poll model.
- `sendDataTimer` (1000 ms) and `statusTimer` (2000 ms) are constructed but **not referenced in the main
  loop** (only in the constructor). R17 telemetry is request-driven, not timer-streamed. ⚠️ (a Ghidra pass
  could confirm they are truly dead vs. referenced through a shared base register.)

### 2.2 The `{"GET":"ALL"}` handler
- **No `"GET"` or `"ALL"` string literal exists anywhere in the binary** (only 24 occurrences of `null`).
  Therefore R17 does not special-case that key. `Do_JSON` parses the inbound object (ArduinoJson) — any key
  matching a known setpoint/mode updates that global (`Do_kv_get`, `0x8041348`) — and then **always builds
  the complete telemetry frame** into `outputString` and returns it. `{"GET":"ALL"}` works because the
  response is unconditional, not because "GET"/"ALL" is understood. ✅

### 2.3 Command keys accepted (inbound)
All are string literals present in the binary and dispatched through `Do_kv_get` / global writes:
`Run_MODE`, `Purge_MODE`, `Flush_MODE`, `Drain_MODE`, `Bypass_MODE`, `Service_MODE`,
`WatchdogTrigger_MODE`, plus setpoints `Vacuum_SETPOINT`, `Flow_SETPOINT`, `Temperature_SETPOINT`,
`HeaterTemperature_SETPOINT`, `TemperatureMAX_SETPOINT`, `PressureMAX_SETPOINT`, `BulkSupplyTimeout_SETPOINT`,
`DrainPumpSpeed_SETPOINT`, `FlushPumpSpeed_SETPOINT`, `InputPumpSpeed_SETPOINT`,
`RecirculationPumpSpeed_SETPOINT`, `ServiceRecirculationPumpSpeed_SETPOINT`, and setups
`Heater_SETUP`, `FluidThermistor_SETUP`, `FluidThermocouple_SETUP`, `WeirFloatInvert_SETUP`,
`IP1_SETUP`…`IP4_SETUP`, `ADC_I2C_SETUP`, `DAC_I2C_SETUP`. (`LAN_HANDSHAKE` @ `0x24001970` is also settable — §8.)

### 2.4 Telemetry keys emitted (outbound) — exhaustive from the string table
Single-token JSON keys present in the binary (grouped):

- **Identity/status:** `SystemID`, `SoftwareRev`, `AlarmStatus`, `ErrorCode_STATE`, `RunButton_STATE`.
- **Modes echoed:** `Run_MODE`, `Purge_MODE`, `Flush_MODE`, `Drain_MODE`, `Bypass_MODE`, `Service_MODE`, `WatchdogTrigger_MODE`.
- **Analog readings:** `Pressure` / `Pressure_STATE`, `Vacuum` (bare — see mismatch below), `ServiceVacuum_STATE`.
- **Temperatures:** `FluidTemperature_STATE`, `MainHeaterTemperature_STATE`, `AUXHeaterTemperature_STATE`,
  `ServiceHeaterTemperature_STATE`, `ServiceTemperature_STATE`.
- **Pumps:** `InputPump_STATE`, `DrainPump_STATE`, `BulkSupplyPump_STATE`, `VacuumPump_STATE`,
  `ServiceRecirculationPump_STATE`, `flushPump_STATE` (lowercase leading f).
- **Valves:** `ManifoldValve1_STATE`, `ManifoldValve2_STATE`, `BypassValve_STATE`, `DrainValve_STATE`,
  `BulkSupplyValve_STATE`, `flushValve_STATE` (lowercase), `ServiceInputValve_STATE`,
  `serviceRecirculationValve_STATE` (lowercase leading s).
- **SSRs:** `MainHeaterSSR_STATE`, `AUXHeaterSSR_STATE`, `ServiceHeaterSSR_STATE`.
- **Floats:** `SupplyFloat_STATE`, `WeirFloat_STATE`, `WasteFloat_STATE`, `SupplyOverflowFloat_STATE`,
  `WeirOverflowFloat_STATE`, `FlushFloat_STATE`, `ServiceFloat_STATE`.
- **Setpoints/setups** are echoed back under the same names as §2.3.

**GUI ↔ firmware key gaps (data-contract issues — confirm on a live `GET ALL` capture):**
| GUI reads | In R17 binary? | Note |
|---|---|---|
| `Vacuum_STATE` | ❌ no literal | R17 has bare `Vacuum` + `Pressure`. GUI's vacuum key likely never populates; confirm real key. |
| `RecirculationPump_STATE` | ❌ no literal | Already flagged in `SYSTEM_AUDIT.md`. `recirculationPump` object exists but no `_STATE` key is emitted. |
| `InletPressure_STATE`, `ReturnPressure_STATE` | ❌ no literal | Not implemented in R17; these are the M4 dual-pressure feature (still gated in the GUI). |
| `flushPump_STATE`, `flushValve_STATE`, `serviceRecirculationValve_STATE` | ✅ lowercase | Casing matters; GUI already corrected per `SYSTEM_AUDIT.md`. |

### 2.5 AlarmStatus format
`AlarmStatus` (global `0x24001928`, an Arduino `String`) is composed as an **op-status prefix + `-` + error
name**, e.g. `RUN-NO_ERROR`, `STOP-HEATER_TC_ERROR`. The GUI decoder (`errors.js` `decodeAlarmStatus`)
splits on the first `-`; prefixes are `RUN`, `STOP`, `PURGE`, `FLUSH`, `DRAIN`. The numeric bitmask is
carried separately as `ErrorCode_STATE` (§7). ✅ (string composition confirmed structurally; the exact
concatenation site is inside `Do_Status`/`Do_JSON` and would benefit from a Ghidra pass.)

---

## 3. I/O map (channel-level; physical terminals behind expanders)

**Architecture (from `Do_init_Hardware` `0x80454e0`, `Do_init_I2C` `0x804543c`, and `setup` `0x80455f4`):**
The Portenta drives no fluidic actuator directly. It uses:
- **Adafruit MCP4728 quad-DAC** at I2C **0x60** (`Adafruit_MCP4728::begin(0x60,…)` `0x80454a2`) → `vacuumRegulator`.
- **Adafruit ADS1115 ADC** at I2C **0x48** (`Adafruit_ADS1X15::begin(0x48,…)` `0x80454ba`) → `sensorQADC` (vacuum/pressure sense).
- **MAX31855** SPI thermocouple ICs (`MAX31855Class::begin` `0x8045518`) and MAX31865 RTD (`temp_probes`).
- **Two ArduinoIOExpander** chips: `begin(0x23)` (`0x8045546`) and `begin(0x22)` (`0x804554e`) → all valves/floats/SSRs.
- PWM pump outputs via `mbed::PwmOut::period_ms(4)` (250 Hz) set on 4 channels (`0x80454f0`–`0x8045508`),
  `analogWriteResolution(12)`, `analogReadResolution(16)`.

**Channel assignments** (recovered by register-tracing the object-field stores in `setup`; each object stores
a small channel index, not a PinName). ✅ for the channel indices; ❓ for which physical expander/terminal:

| Object (symbol@addr) | Subsystem | Channel | Evidence (setup store) |
|---|---|---|---|
| `vacuumRegulator` @`0x24001e28` | MCP4728 DAC | **0** | `adafruitQDACOutput::initHardware(0)` `0x8045606` |
| `inputPump` @`0x24001a98` | speedPump PWM | **0** | `speedPump::initHardware` |
| `recirculationPump` @`0x24001b2c` | speedPump PWM | **1** | `speedPump::initHardware` |
| `flushPump` @`0x24001a78` | speedPump PWM | **2** | `speedPump::initHardware` |
| `serviceRecirculationPump` @`0x24001bac` | speedPump PWM | **3** | `speedPump::initHardware` |
| `drainPump` @`0x24001a30` | speedPump PWM | **2** ⚠️ | `speedPump::initHardware` — same index as flushPump; likely a different PWM bank/expander, **verify** |
| `vacuumSensor` @`0x24001e30` | ADS1115 ADC | **0** | field[+0]=0 |
| `fluidThermistor` @`0x24001a58` | ADS1115 ADC | **1** | field[+0]=1 |
| `mainHeaterThermocouple` @`0x24001ae8` | MAX31855 | **0** | field[+0]=0 |
| `fluidThermocouple` @`0x24001a5c` | MAX31855 | **1** | field[+0]=1 |
| `auxHeaterThermocouple` @`0x240019ec` | MAX31855 | **2** | field[+0]=2 |
| `i2cHeaterThermocouple` @`0x24001a90` | I2C TC | **0** | field[+4]=0 |

**Expander digital outputs** (channel written to object field[+4]):

| Output | Ch | | Output | Ch |
|---|---|---|---|---|
| `drainValve` | 0 | | `serviceHeaterSSR` | 4 |
| `bypassValve` | 1 | | `auxHeaterSSR` | 5 |
| `bulkSupplyValve` | 2 | | `mainHeaterSSR` | 6 |
| `vacuumPump` | 3 | | `manifoldValve1` | 5 |
| `serviceInputValve` | 3 | | `manifoldValve2` | 6 |
| `bulkSupplyPump` | 4 | | `flushValve` | 7 |
| `serviceRecirculationValve` | 7 | | `serviceVacuumSSR` | 8 |

**Expander digital inputs** (channel written to object field[+0]):

| Input | Ch | | Input | Ch |
|---|---|---|---|---|
| `wasteFloat` | 0 | | `weirOverflowFloat` | 5 |
| `flushFloat` | 1 | | `runButton` | 6 (field[+4]=1) |
| `supplyOverflowFloat` | 2 | | `serviceFloat` | 7 |
| `supplyFloat` | 4 | | `weirFloat` | 8 |

❓ **Two expanders (0x23, 0x22) exist and channel indices repeat across outputs and inputs, so a channel
number alone is ambiguous** — the object almost certainly also encodes which expander (the `runButton`
object carries *both* field[+0]=6 and field[+4]=1, suggesting a {channel, expander/mode} pair). Resolving
channel→physical-terminal requires the DWARF class layout of `digitalOutput`/`digitalInput`/
`digitalProgrammableOutput`/`speedPump` **and** the hydraulic schematic. Do not wire from these indices alone.

Two raw Portenta pins are toggled in `Do_init_Hardware`: `digitalWrite(PinName 0x80, LOW)` (`0x804552c`) and
`digitalWrite(PinName 6, HIGH)` (`0x8045534`) — likely peripheral enable/reset lines. ❓ purpose.

---

## 4. Mode state machines

**Main loop:** `Do_StateMachine` (`0x8045914`) each pass runs `Do_SerialLoop` → (kick HW watchdog unless
`WatchdogTrigger_MODE`≠0) → `Do_Handshake` → `Do_Float_Watchdog` → `Do_Heater_Watchdog` → **`Do_MODES`** →
`Do_Read_Sensors` → `Do_Status`.

### 4.1 Dispatch — `Do_MODES` (`0x8041840`)
- If not running, `bulkSupplyPump` and `bulkSupplyValve` are driven **off** (pre-dispatch writes `0x804184c`/`0x8041854`). ⚠️
- `if (Run_MODE != 0) Do_Run(); else Do_Stop();` (`cbz` on `Run_MODE` `0x240019a2`, `0x804185a`). ✅
- **Epilogue (always):** `bypassValve = Bypass_MODE` — Bypass mirrors its mode bit directly, every cycle,
  with no timeout/interlock (`Bypass_MODE` `0x24001938`, `bypassValve` `0x24001a1c` in the `Do_MODES` literal pool). ✅ (matches audit)

### 4.2 Run — `Do_Run` (`0x80417c4`) ✅
1. `MyTimer::reset(shutdownTimer1)`, `MyTimer::reset(shutdownTimer2)`.
2. `manifoldValve1 = 1`, `manifoldValve2 = 1`.
3. `Do_Vacuum_Control()` — see §5. `Do_Pump_Control()` — recirc from `Flow_SETPOINT`; input/drain/drainValve from floats.
4. When `startupTimer1` (**10 s**) ready → `Do_Pump_Control()` again.
5. When `startupTimer2` (**15 s**) ready → `Do_Heater_Control()` and `isRunning = 1`.
6. Before `startupTimer1`: `ErrorCode_STATE &= ~HEATER_ERROR` (clears the heater bit during warm-up, `0x8041812`).
7. Purge/Flush/Drain/Service bits are handled only in the stopped path, so entering Run leaves them latched
   until `Do_Stop` runs; Bypass is untouched. (Matches audit: Run does not clear Bypass.)

### 4.3 Stop — `Do_Stop` (`0x8041168`) ✅
1. `MyTimer::reset(startupTimer1)`, `MyTimer::reset(startupTimer2)`.
2. `mainHeaterSSR = 0`, `auxHeaterSSR = 0` (both heater SSRs off, `0x804117c`/`0x8041184`).
3. **Drain** (`Drain_MODE` `0x2400193c`): if set → `manifoldValve1=1`, `manifoldValve2=1`, `drainPump` enabled;
   else all three off (`0x8041192` ON path / `0x8041278` OFF path). **No `drainValve` in Drain** — confirms audit item #5.
4. `recirculationPump` speed = 0, `inputPump` speed = 0.
5. If `isRunning`: vacuum wind-down — QDAC ramp computed from `Vacuum_SETPOINT`/`Flow_SETPOINT` (FP math + `adafruitQDACOutput::write`, `0x80411f0`). Then `isRunning = 0`; `HeaterTemperature_SETPOINT = Temperature_SETPOINT`.
6. **Flush** — see §4.4.
7. **Purge** (`Purge_MODE` `0x240019a0`): recirculation pump pulsed by `PurgeBlinker::isHIGH()` (writes speed
   `100` into `recirculationPump` field[+8], enable = blinker, `0x8041240`); `inputPump` pulsed by the same
   blinker **only if `weirOverflowFloat` reads non-zero** (`0x804124c`). Matches audit's Purge description.
8. **Shutdown ramp (Purge/Flush off path):** `drainValve = 0`; after `shutdownTimer1` (**5 s**) →
   `vacuumRegulator = 0` and `vacuumPump` off (`0x8041262`→`0x8041266`); `shutdownTimer2` (**14 s**) gates the
   remaining drain-pump wind-down. Matches audit "~5 s and ~14 s."

### 4.4 Flush — the audit correction ⚠️→ needs live confirmation
Inside `Do_Stop`:
- **Flush ON** (`Flush_MODE`≠0, `0x8041220`): if `MyTimer::isReady(flushModeTimer)` → `Flush_MODE = 0`
  (auto-clear, `0x804128c`); else `flushValve = 1`, `flushPump` enabled (`0x804122a`).
- **Flush OFF** (`Flush_MODE`==0, `0x8041292`): `flushValve = 0`, `flushPump = 0`, **and
  `MyTimer::reset(flushModeTimer)` (`0x80412a0`).**
- `flushModeTimer` interval = **5000 ms**, set once in the global constructor (`strd` at `0x804526a`, value
  saved from `movw #0x1388` at `0x80451ce`). `MyTimer::isReady` = `millis() ≥ start + interval` (`0x8040b40`).

**Consequence:** while stopped with Flush off, the timer is reset every cycle (kept fresh). The instant Flush
is commanded, it counts a full 5 s, then clears — i.e. **Flush should hold ~5 s of pump/valve dwell.** This
**contradicts `OPERATING_MODES_AUDIT.md` finding #6 and §"Flush"** ("initialized once at boot, never reset →
clears immediately"). The reset call in the OFF branch is unambiguous in the disassembly (literal
`flushModeTimer @0x24001a68` loaded into r0 immediately before `bl MyTimer::reset`). The GUI
`firmware-simulator.js` currently reproduces an "immediate clear" that the firmware code does not exhibit.
**Recommendation:** capture live `Flush_MODE`/`flushPump_STATE`/`flushValve_STATE` readbacks on the machine
before trusting either the old audit or this correction; the code says ~5 s.

### 4.5 Bypass ✅
`bypassValve = Bypass_MODE` in the `Do_MODES` epilogue (§4.1). No timer, no interlock, coexists with Run.
`Do_Status` has no Bypass op-status prefix (§2.5). Matches audit.

---

## 5. Setpoints & vacuum/flow

- **Default values** (`.data`, 16-bit little-endian, LMA `0x0808933C`):

  | Setpoint (symbol@addr) | Default | | Setpoint | Default |
  |---|---|---|---|---|
  | `BulkSupplyTimeout_SETPOINT` @`0x24000008` | 20 | | `RecirculationPumpSpeed_SETPOINT` @`0x24000026` | 100 |
  | `DrainPumpSpeed_SETPOINT` @`0x2400000a` | 100 | | `ServiceRecirculationPumpSpeed_SETPOINT` @`0x24000028` | 30 |
  | `Flow_SETPOINT` @`0x24000010` | 100 | | `PressureMAX_SETPOINT` @`0x24000024` | 3 |
  | `FlushPumpSpeed_SETPOINT` @`0x24000012` | 100 | | `WeirFloatInvert_SETUP` @`0x2400002a` | 1 (inverted by default) |
  | `InputPumpSpeed_SETPOINT` @`0x24000022` | 100 | | IP `192.168.1.26` | `IP1..IP4_SETUP` @`0x2400001a..0x24000020` = 192,168,1,26 |

  `Vacuum_SETPOINT`, `Temperature_SETPOINT`, `HeaterTemperature_SETPOINT`, `TemperatureMAX_SETPOINT` live in
  `.bss` (default 0) and are populated at boot by `Do_kv_get` (`0x8041348`, called from `setup`) — R17 has
  non-volatile config restore. ✅
- **Vacuum:** `Do_Vacuum_Control` (`0x8040dc4`) drives `vacuumRegulator` (MCP4728) from `Vacuum_SETPOINT`,
  **gated by the Weir-overflow float** (regulator commanded to 0 unless the overflow input permits), and
  enables `vacuumPump`. ✅ (matches audit Run step 3).
- **Flow:** `Flow_SETPOINT` is a **recirculation-pump PWM drive**, not a measured flow (`recirculationPump`
  speed set from it in `Do_Pump_Control`). The R17 rename recommendation in the audit stands. ✅
- `Do_BoundsCheck` (`0x804150c`) is called before heater control / heater watchdog to clamp setpoints
  (e.g. `HeaterTemperature_SETPOINT` clamped between `Temperature_SETPOINT` and `TemperatureMAX_SETPOINT`,
  seen in `Do_Heater_Control` `0x8041762`–`0x8041776`). ✅

---

## 6. Heater / thermocouple logic

- **Read** — `Do_Read_Sensors` (`0x8040ba0`) writes the **999 (0x3e7) sentinel** on a thermocouple read
  fault (`movw #0x3e7` at `0x8040c16`, `0x8040c5a`, `0x8040cce`, `0x8040d24`, `0x8040d42`). ✅
- **On/off control** — `Do_Heater_Control` (`0x8041694`), only reached ≥15 s after Run (§4.2). If `Run_MODE==0`
  it forces `mainHeaterSSR=0`, `auxHeaterSSR=0` and returns. Otherwise it commands `mainHeaterSSR` from
  `MainHeaterTemperature` vs `HeaterTemperature_SETPOINT` (bang-bang, `0x80416cc`). ✅
- **Safety** — `Do_Heater_Watchdog` (`0x80415b0`):
  - **Over-temp cutoff:** if `MainHeaterTemperature > TemperatureMAX_SETPOINT` → `mainHeaterSSR=0`; same test
    on `AUXHeaterTemperature` → `auxHeaterSSR=0` (`0x80415be`, `0x80415d0`). ✅
  - **Heater-fault trip:** if a heater is on AND `mainHeaterTimer` (10 s) ready AND `MainHeaterTemperature != 999`
    AND `Heater_SETUP==1` → `Run_MODE=0` and `ErrorCode_STATE |= HEATER_ERROR (0x1000)` (`0x8041616`–`0x8041622`).
    (Interpretable as a "heater failed to reach temperature within 10 s" runaway guard.) ✅
  - **HTC sentinel → error bit:** `if (MainHeaterTemperature == 999) ErrorCode_STATE |= HEATER_TC_ERROR
    (0x2000 = 8192); else clear` (`0x8041638`–`0x804164a`). **This is the HTC / `999 °C` / error-bit-8192
    fault** the GUI documents. ✅
  - **Fluid TC sentinel:** `if (FluidTemperature == 999) ErrorCode_STATE |= FLUID_TC_ERROR (0x4000); else
    clear` (`0x804164e`–`0x804165a`). ✅

---

## 7. Error / alarm encoding

`ErrorCode_STATE` (`0x2400193e`) is a **16-bit bitmask**. The masks are constants in `.data`; values read
directly from the section bytes (LMA `0x0808933C`):

| Symbol (addr) | Mask | Decimal | GUI name |
|---|---|---|---|
| `FLOAT_ERROR` @`0x2400000c` | `0x8000` | 32768 | `FLOAT_ERROR` (warning) |
| `FLUID_TC_ERROR` @`0x2400000e` | `0x4000` | 16384 | `FLUID_TC_ERROR` |
| `HEATER_TC_ERROR` @`0x24000016` | `0x2000` | **8192** | `HTC` / error bit 8192 (heater TC) |
| `HEATER_ERROR` @`0x24000014` | `0x1000` | 4096 | `HEATER_ERROR` |
| `I2C_ERROR` @`0x24000018` | `0x0800` | 2048 | `I2C_ERROR` |

These are the string names too (`NO_ERROR`, `HEATER_ERROR`, `HEATER_TC_ERROR`, `FLUID_TC_ERROR`,
`FLOAT_ERROR`, `I2C_ERROR` all present as literals and as `.data` globals). `AlarmStatus` string = op-status
prefix + `-` + one of these names (§2.5). The GUI's `OPEN1..OPEN11_ERROR` reserved codes correspond to the
unused low bits (0..10) of the same 16-bit word. ✅ Float faults are set by `Do_Float_Watchdog` (`0x8040ed0`)
(logic present; per-float polarity is `WeirFloatInvert_SETUP`-dependent and needs bench confirmation ❓).

---

## 8. Watchdogs

1. **Hardware watchdog (mbed):** `mbed::Watchdog::start(0x1388)` = **5000 ms** in `setup` (`0x8045788`).
   `Do_StateMachine` kicks it (`Watchdog::kick`, `0x8045924`) **only when `WatchdogTrigger_MODE == 0`**
   (`cbnz` on `0x240019d8` at `0x804591e`). Setting `WatchdogTrigger_MODE` non-zero therefore starves the
   watchdog → **hardware reset after ~5 s** = the GUI's commanded-reboot mechanism. ✅
2. **LAN/comms handshake watchdog:** `Do_Handshake` (`0x8040e3c`): if `LAN_HANDSHAKE` (`0x24001970`) is set by
   a client, it is cleared and `HANDSHAKE_Timer` is reset; if `HANDSHAKE_Timer` (interval **45000 ms**,
   `0x804527e`) expires, **`Run_MODE` is forced to 0** (`0x8040e5a`). A client must periodically set
   `LAN_HANDSHAKE` to keep the machine running over the network. ✅ (not previously documented)

### Timer inventory (all intervals confirmed from the global constructor, §evidence `0x80451bc`–`0x804529e`)
| Timer | Interval | Timer | Interval |
|---|---|---|---|
| `startupTimer1` | 10000 ms | `stateMachineTimer` | 500 ms |
| `startupTimer2` | 15000 ms | `updateVariablesTimer` | 3000 ms |
| `shutdownTimer1` | 5000 ms | `temperatureSampleTimer` | 15000 ms |
| `shutdownTimer2` | 14000 ms | `thermocoupleTimer` | 500 ms |
| `flushModeTimer` | 5000 ms | `HeaterBlinker` | 500 ms |
| `HANDSHAKE_Timer` | 45000 ms | `PurgeBlinker` | 2000 ms (default) ⚠️ |
| `mainHeaterTimer` | 10000 ms | `sendDataTimer` | 1000 ms (constructed, not in loop) |
| `bulkSupplyPumpTimer` | 10000 ms | `statusTimer` | 2000 ms (constructed, not in loop) |

⚠️ **Purge cadence vs audit:** the audit says the Purge blinker is set to **100 ms**. In `Do_Stop` the value
`100` (`0x64`) is written into `recirculationPump` field[+8] (a PWM **speed**, not the blinker interval), and
`PurgeBlinker`'s constructed interval is **2000 ms**. So the Purge pump-pulse period is most likely governed
by the 2000 ms blinker, not 100 ms. Flagged for confirmation — the audit's "100 ms pulse" may be a misread of
the `0x64` speed constant.

---

## 9. Application function map (entry points for the rebuild)

| Symbol | Addr | Role |
|---|---|---|
| `setup` | `0x80455f4` | constructs pin objects (channels §3), IP, Ethernet, `Watchdog::start(5000)` |
| `_GLOBAL__sub_I__ZN20Portenta_H7_ISRTimer…` | `0x8045050` | static init: sets all timer/blinker intervals (§8) |
| `Do_init_Hardware` | `0x80454e0` | UART, PWM periods, MAX31855, ADS1115/MCP4728, IO-expanders 0x23/0x22 |
| `Do_init_I2C` | `0x804543c` | probes I2C 0x64/0x60/0x48; `MCP4728::begin(0x60)`, `ADS1X15::begin(0x48)` |
| `Do_StateMachine` | `0x8045914` | main loop orchestrator (§4) |
| `Do_SerialLoop` | `0x80458c4` | inbound line → `Do_JSON` → echo `outputString` (§2.1) |
| `serialEvent` | `0x8045860` | char accumulator into `inputString` |
| `Do_JSON` | `0x8043668` | parse command, build full telemetry frame |
| `Do_kv_get` | `0x8041348` | key/value → setpoint/mode globals; boot config restore |
| `Do_MODES` | `0x8041840` | Run/Stop dispatch + Bypass epilogue (§4.1) |
| `Do_Run` | `0x80417c4` | Run sequence (§4.2) |
| `Do_Stop` | `0x8041168` | Stop + Drain + Flush + Purge + shutdown ramp (§4.3–4.4) |
| `Do_Vacuum_Control` | `0x8040dc4` | vacuum regulator/pump from `Vacuum_SETPOINT` gated by Weir OVF |
| `Do_Pump_Control` | `0x8040e6c` | recirc/input/drain pumps + drainValve from `Flow_SETPOINT`+floats |
| `Do_Read_Sensors` | `0x8040ba0` | temps/pressure/vacuum reads; 999 sentinel on TC fault |
| `Do_Heater_Control` | `0x8041694` | SSR bang-bang vs `HeaterTemperature_SETPOINT` |
| `Do_Heater_Watchdog` | `0x80415b0` | over-temp cutoff, heater-fault trip, HTC/Fluid 999 → error bits (§6) |
| `Do_Float_Watchdog` | `0x8040ed0` | float-state error logic |
| `Do_BoundsCheck` | `0x804150c` | setpoint clamps |
| `Do_Handshake` | `0x8040e3c` | 45 s LAN watchdog → `Run_MODE=0` (§8) |
| `Do_Status` | `0x8040f38` | compose `AlarmStatus` op-status prefix + error |
| `Pump_ISR` | `0x8040960` | hardware-timer ISR (pump PWM / blink servicing) |

---

## 10. What remains for Ghidra / hardware (honest limits)

Recovered by hand from symbols + DWARF + disassembly + strings + `.map`: the full global/pin-object layout,
the I/O channel indices, every timer interval, the error bitmask values, the 999/HTC logic, the mode
sequences, the two watchdogs, the protocol shape, and the setpoint defaults. **Not fully established by
objdump alone:**
1. **Physical terminal map** (expander 0x22/0x23 channel → actual pump/valve wire; hose routing; float
   polarity) — needs the DWARF struct layout of the `digitalOutput`/`speedPump` classes **and** the
   hydraulic schematic / bench probing.
2. **Exact JSON assembly order and number formatting** in `Do_JSON`/`Do_Status` — a Ghidra decompile would
   read cleaner than hand-tracing ArduinoJson calls; and a **live `GET ALL` capture** is the ground truth for
   the real vacuum key (`Vacuum` vs `Vacuum_STATE`) and whether `RecirculationPump_STATE` is ever sent.
3. **Flush dwell** (§4.4) and **Purge pulse period** (§8) — the code says 5 s / 2 s; verify against the
   machine before changing firmware, since both contradict the prior audit.
4. `drainPump` PWM channel (2) colliding with `flushPump` (2) — confirm the pump-bank/expander disambiguation.
