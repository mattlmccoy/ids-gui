# Ink Switching Concept — Deferred

Status: concept only; intentionally deferred to a future design session.

## Goal

Add a separately controlled fluid selector that can switch the IDS between as many as four
reservoirs, such as pure IPA, 25 wt% ink, and intermediate formulations. The selector must
switch both the 1/4-inch supply line and the single 1/8-inch recirculation return without
allowing the supply and return to point at different reservoirs.

## Recommended architecture

- Keep the ink selector independent of the NANO 700 firmware.
- Connect a second Arduino-compatible controller to the IDS desktop over its own USB serial
  connection.
- Use two synchronized selector assemblies:
  - one sized for the 1/4-inch supply line;
  - one sized for the 1/8-inch return line.
- Require positive position feedback for both selectors. A commanded servo position is not
  sufficient proof of the selected fluid path.
- Give the selector a distinct protocol identity, for example:

```json
{"DeviceType":"INK_SELECTOR","SystemID":"SELECTOR_01","Channels":4}
```

## Candidate valve arrangements

### Two multiport selector valves

Use one multiport valve for supply and one for return. Each should provide the same four
reservoir positions and preferably an additional closed or waste position. This minimizes
the actuator count and makes the selected route conceptually clear.

### Paired normally closed valves

Use four supply valves and four return valves. Selecting a reservoir opens only its matched
pair. Chemical-compatible pinch valves are attractive because the fluid can remain inside
replaceable tubing, and normally closed actuation can provide a useful fail-safe state.

## Mechanical caution

Do not assume one hobby servo can reliably operate two unrelated manual valves. Unequal
torque, backlash, or a partial stroke could connect a supply reservoir to the wrong return.
A mechanically ganged mechanism is acceptable only if it has deliberate indexing and
independent position confirmation.

## Proposed switching sequence

1. Verify every IDS pump and operating mode is off.
2. Depressurize or safely route the current fluid.
3. Close the existing supply and return paths.
4. Move both selectors to the requested reservoir.
5. Verify both position sensors agree with the requested reservoir.
6. Prime or flush the shared tubing to a verified waste destination.
7. Require operator confirmation of the reservoir, fluid, and physical routing.
8. Permit IDS Run only after every gate passes.

Any mismatch, lost position signal, disconnect, or timeout should close all available paths
and block operation. The selector is not an emergency stop and must not replace local safety
controls.

## Controller choice

An Arduino Uno can handle two actuators and a small number of position switches. A Mega is
preferable if the system may add per-channel position sensing, reservoir-level inputs, leak
sensors, local controls, or fluid-identification instrumentation.

## Software implications

- The web app needs a second, independent serial transport rather than multiplexing selector
  messages through the NANO 700 connection.
- The selector should have its own simulator, command allowlist, connection state, firmware
  revision, event history, and commissioning checks.
- Remote selector control should remain disabled unless a local operator explicitly enables
  a temporary safety window.
- Fluid recipes should carry compatibility, flush-route, priming-volume, and contamination
  metadata; the GUI must not infer these values.

## Decisions required before implementation

- Actual reservoir count and formulations
- Whether intermediate concentrations are stored formulations or mixed on demand
- Approved wetted materials and candidate valve models
- Supply and return pressure requirements
- Waste and flushing topology
- Acceptable dead volume and cross-contamination
- Required local sensors, indicators, and manual override
- Physical confirmation that every reservoir can safely accept the recirculation return

