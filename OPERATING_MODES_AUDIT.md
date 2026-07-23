# IDS Operating Modes Audit

Audit date: 2026-07-22

## Scope and confidence

This guide traces the current web UI through the serial protocol and the compiled,
unstripped `NANO_SINGLE_R17_RELEASE.ino.elf`. Function names, global symbols, object
layouts, timers, and output writes were recovered from the ELF's symbol and DWARF data.
The original Arduino source and a hydraulic schematic were not available.

The electronic behavior below is therefore substantially more reliable than the old UI
tooltips, but hose destinations and actual fluid-flow directions remain unverified. Do not
use the inferred fluid paths as a substitute for tracing the physical tubing.

## Executive findings

1. The UI sends the correct mode keys. The new R17 mode guide documents the compiled output
   sequence while keeping physical fluid destinations explicitly unverified.
2. `Stop` means `Run_MODE=0`; it is not an all-output-off or emergency-stop command.
   Purge, Flush, Drain, and Bypass can remain active after Stop. The UI now provides a separate
   verified **All Modes Off** control.
3. The web UI now interlocks Purge, Flush, and Drain against Run and one another and waits for
   controller acknowledgement before presenting a requested state as active.
4. Bypass is independent and can remain on during Run. It now requires confirmation and shows
   a persistent warning while its readback is active.
5. R17 turns on both manifold valves and the drain pump, not the drain valve. Commissioning now
   uses that compiled truth table; physical routing still requires lab validation.
6. R17's five-second flush timer is initialized at boot and has no compiled reference that
   resets it when Flush is requested. Flush requested more than five seconds after boot is
   therefore expected to clear immediately. This requires a firmware correction.
7. Physical float polarity and every hose destination remain lab-verification items.
8. The normal one-second telemetry poll can alias the 100 ms Purge pulse. A pump may be
   switching correctly while sampled state appears stuck or inconsistent.

## Mode summary

| Control | Firmware request | Outputs proven from R17 | Likely purpose | Important cautions |
|---|---|---|---|---|
| Run | `Run_MODE=1` | Manifold valves 1 and 2 on; vacuum control active; recirculation/input/drain pumps and drain valve controlled by Weir floats; heaters enabled after startup delay | Normal conditioned-fluid circulation through the Xaar 2002 path | Purge, Flush, Drain, and Service are cleared. Bypass is **not** cleared. Float polarity and hose direction need validation. |
| Stop | `Run_MODE=0` | Bulk supply pump/valve off; heater SSRs off; then executes any selected maintenance modes; vacuum shuts down after a delay | Leave normal run and permit maintenance modes | Not all-off. Bypass or a maintenance mode may continue. Not an E-stop. |
| Purge | `Purge_MODE=1` | Recirculation pump pulses; input pump pulses only under a Weir-overflow input condition; no flush pump/valve or drain pump command | Pulse the filled ink loop to prime, move bubbles, or disturb settled material | No code evidence that it routes to waste. Use only with a filled, correctly routed loop. Exact fluid path is not proven. |
| Flush | `Flush_MODE=1` | Flush pump on and flush valve open while the mode survives | Move connected cleaning fluid through the dedicated flush branch | Current R17 timer behavior likely clears Flush immediately after normal boot. Supply compatibility and waste routing must be confirmed. |
| Drain | `Drain_MODE=1` | Manifold valves 1 and 2 on; drain pump on at configured drain speed | Evacuate the manifold/printhead branch before service or fluid change | R17 does **not** command the drain valve on in this mode. Destination and flow direction must be traced before use. |
| Bypass | `Bypass_MODE=1` | Bypass valve mirrors the mode directly and indefinitely | Open the physical bypass branch, likely to circulate without the printhead or alter restriction | Exact branch is unknown. Can coexist with Run. No timeout or confirmation exists. |

## Detailed sequences

### Run

The UI sends only `{"Run_MODE":"1"}` after confirmation. R17 then:

1. Resets two shutdown timers.
2. Opens manifold valves 1 and 2.
3. Enables the vacuum pump. The vacuum regulator is driven from `Vacuum_SETPOINT` only
   when the Weir overflow input permits it; otherwise the regulator command is zero.
4. Sets the recirculation pump speed from `Flow_SETPOINT`.
5. Selects the input pump, drain pump, and drain valve from the raw Weir and Weir-overflow
   float inputs. Raw electrical polarity is not yet physically confirmed.
6. Re-evaluates pump control after the 10-second startup timer.
7. Enables heater control and marks the internal system running after the 15-second startup
   timer.
8. Clears Purge, Flush, Drain, and Service mode requests. It leaves Bypass unchanged.

For a Xaar 2002, this should ultimately establish two independent hydraulic quantities:
slightly negative nozzle meniscus pressure and differential pressure/flow through the head.
The current IDS exposes vacuum and a pump-speed-like `Flow_SETPOINT`; it does not expose
measured inlet and return pressure, calculated differential pressure, or actual flow.

### Stop

The UI sends only `{"Run_MODE":"0"}`. R17 turns off the bulk supply pump and valve, turns
off both heater SSRs, and enters its stopped-mode logic. If no maintenance modes are active,
the recirculation path winds down and the vacuum regulator/pump are turned off after the
compiled shutdown delays (approximately 5 and 14 seconds).

Stop does not clear Purge, Flush, Drain, or Bypass. Both Operation and the commissioning
runner now provide a separate five-command "All Modes Off" software safe-baseline sequence.

### Purge

Purge is not a generic "everything to waste" routine in R17. While stopped, it changes a
blinker interval to 100 ms and uses that signal to pulse the recirculation pump. The same
pulse is applied to the input pump only when the raw Weir-overflow input is nonzero. It does
not independently open the flush valve, flush pump, drain pump, or manifold valves.

Until tubing and float polarity are confirmed, the defensible use case is: pulse a filled
ink loop to help prime it or move bubbles/settled binder. It should not be described as a
drain or solvent flush.

### Flush

The intended electronic path is simple: open `flushValve` and enable `flushPump` at
`FlushPumpSpeed_SETPOINT`, then clear the mode after five seconds.

The compiled firmware initializes `flushModeTimer` once at controller startup. No other
reference resets it. Since `Do_Stop()` clears `Flush_MODE` whenever that timer is ready,
the practical R17 behavior after five seconds of controller uptime is expected to be an
immediate clear with little or no pump/valve dwell. This should be fixed in firmware by
resetting the timer on the OFF-to-ON transition, then verified with live readbacks.

### Drain

While stopped, R17 checks `Drain_MODE` and:

- opens `manifoldValve1`;
- opens `manifoldValve2`; and
- enables `drainPump` at `DrainPumpSpeed_SETPOINT`.

With Purge off, the same stopped-mode function commands `drainValve` off. Commissioning now
waits for `DrainPump_STATE`, `ManifoldValve1_STATE`, and `ManifoldValve2_STATE`. This matches
the compiled firmware, but physical flow must still be confirmed before certification.

### Bypass

At the end of every mode cycle, R17 writes `Bypass_MODE` directly to `bypassValve`. There is
no timeout, no automatic clear on Run, and no interaction with the other maintenance-mode
bits. The likely purpose is to provide a lower-restriction route around some portion of the
printhead circuit, but only the plumbing schematic can establish what is bypassed and where
fluid returns. The main operational-status decoder also has no Bypass state, so the dashboard
now supplies its own persistent Bypass warning based on the direct mode readback.

## Xaar 2002 implications

The Xaar 2002 uses TF Technology to circulate fluid past the backs of the nozzles. Xaar
identifies meniscus pressure, differential pressure/flow, and temperature as the central
fluid-system quantities. Slightly negative meniscus pressure prevents weeping; excessively
negative pressure risks pulling air into the nozzles. For a particle-bearing binder, steady
recirculation also helps carry bubbles and particles away and limits settling and thermal or
viscosity gradients.

This means an IDS mode should never be judged only by "pump on." A useful acceptance test
must show the expected inlet/return pressure response, stable meniscus pressure, temperature
settling, float behavior, and absence of leaks or unintended waste flow.

## Lab verification plan

Before changing any mode logic, trace and label every hose and record the normal flow arrow.
Then run one mode at a time with compatible test fluid and a receiving container in place.

For every mode capture:

- all five mode readbacks before, during, and after the command;
- every pump and valve state;
- all float states in raw and interpreted form;
- vacuum, pressure, and temperature;
- elapsed time to first output, stable response, and complete shutdown;
- observed inlet, outlet, bypass, reservoir, and waste flow;
- leaks, bubbles, cavitation, nozzle-plate wetting, or unexpected pressure excursions.

Specific questions to resolve:

1. Which physical printhead port is fed by each manifold valve?
2. Where do the drain pump and drain valve each discharge?
3. What component/path does the bypass valve bypass?
4. Does raw float state `1` mean float up or down for every input?
5. Is Purge intended to pulse through the Xaar head, only the local reservoir loop, or both?
6. Which reservoir supplies the flush pump, and where does flushed liquid exit?
7. What are the approved binder, cleaning-fluid, vacuum, flow, and temperature limits?

## Recommended product work

Implementation status in the web tool: the R17 Drain truth table, All Modes Off, maintenance
interlock, Bypass confirmation/warning, requested-versus-acknowledged states, operating-mode
cards, compact timers, recirculation-drive labeling, Flush-defect detection, and a secret-free
diagnostic bundle are implemented. The firmware Flush correction, instrument additions,
physical plumbing animation, recipes, maintenance counters, and simulator still require
firmware source, hardware knowledge, or additional product work.

### P0 — safety and correctness

1. Obtain the R17 Arduino source and hydraulic schematic; version them with the GUI.
2. Fix/reset the firmware flush timer on a real Flush OFF-to-ON edge.
3. Replace the Drain commissioning expectation with the physically verified truth table.
4. Add a true **All modes off** control that sends Run, Purge, Flush, Drain, and Bypass off,
   verifies all five readbacks, and clearly remains distinct from the hardware E-stop.
5. Make Purge, Flush, and Drain mutually exclusive. Require confirmation for Bypass and show
   a persistent warning if Bypass is active during Run.

### P1 — mode clarity

1. Replace small `?` tooltips with mode cards showing purpose, prerequisites, commanded
   outputs, expected sensor response, duration, fluid destination, and exit state.
2. Add an animated, machine-specific plumbing schematic. Animate only paths that have been
   physically verified; visually mark inferred or uninstrumented segments.
3. Show a live mode timeline: command requested, firmware acknowledged, outputs moving,
   hydraulic response achieved, stable, and stopped.
4. Turn Flush into a deliberate timed cycle with countdown, completion result, and optional
   repeat count after firmware behavior is corrected.
5. Distinguish **requested** from **firmware acknowledged** state. Do not color a control active
   from the optimistic UI cache before the controller echoes it.

### P1 — Xaar-focused instrumentation and diagnostics

1. Add supply- and return-pressure sensing at the printhead. Derive and trend meniscus
   pressure and differential pressure alongside temperature and pump commands.
2. Rename `Flow_SETPOINT` in the UI to make clear that R17 uses it as recirculation-pump
   drive, not measured flow, unless a real flow sensor is added.
3. Detect "commanded but no hydraulic response," excessive float/pump cycling, vacuum decay,
   slow startup, temperature instability, and unexpected valve combinations. Add firmware-side
   pulse counters/duty-cycle telemetry so Purge can be assessed without aliasing its 100 ms
   switching through the one-second browser poll.
4. Add a one-click diagnostic bundle containing the configuration, firmware/UI revisions,
   raw telemetry, mode transition log, alert history, and a short pre/post-event trend window.
5. Add a firmware simulator/digital twin with the verified mode/output truth table so the GUI
   and commissioning workflow can be tested without wet hardware.

### P2 — operations and maintenance

1. Add guided startup, binder change, shutdown, and long-idle recipes tied to approved fluids.
2. Store binder-specific profiles for viscosity/density calibration, temperature, vacuum,
   recirculation drive, compatible flush fluid, and maximum allowable dwell.
3. Add maintenance counters for pump runtime, heater cycles, flush volume/cycles, filter age,
   and printhead wet hours.
4. Integrate nozzle-health observations or Xaar/XPM reporting where available; do not confuse
   the IDS Purge mode with Xaar Sure Flow or printhead firing/cleaning commands.

## Source references

- Local UI: `js/ui-operation.js`, `js/ui-dialogs.js`, and
  `js/commissioning-automation.js`.
- Local R17 artifacts: `../NANO_SINGLE_R17_RELEASE (1)/build/arduino.mbed_portenta.envie_m7/`
  (`.elf` and `.map`).
- Xaar 2002 product information and datasheet.
- Xaar TF Technology explanation and recirculation white paper.
- Xaar Hydra and X-IST material describing meniscus pressure, differential pressure/flow,
  temperature, and diagnostic time histories.
