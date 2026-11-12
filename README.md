# CSTR Flow Lab

A browser app that runs a CFD simulation of a continuous stirred-tank reactor and reports
the flow field, residence time distribution (RTD) and solids suspension behaviour.
No install or build step: everything is plain JavaScript.

## Run it

Open `index.html` in a browser (double-click works), or serve the folder:

```
python3 -m http.server 8000    # then open http://localhost:8000
```

A default case solves on load in roughly 5–15 s. Change any input and press **Run simulation**.
Right-click a map to save it as an image.

Headless run (prints the metrics as JSON, used as a smoke test):

```
node test/smoke.js '{"rpm": 200, "impType": "rushton", "impAngle": 90, "impBlades": 6}'
```

## Inputs

| Group | Parameters |
|---|---|
| Tank | diameter, liquid height |
| Baffles | count (0 = unbaffled), width, wall gap |
| Agitator | impeller type, diameter, off-bottom clearance, blade count, blade width, blade angle, pumping direction, speed |
| Fluid | viscosity, density |
| Through-flow | flow rate, feed radius, outlet position |
| Solids | particle size, particle density, loading |
| Numerics | grid resolution |

## Outputs

- **Operating point**: Reynolds number, shaft power and power number, pumping flow and flow number,
  circulation time, blend time (Grenville correlation), residence time.
- **Static flow visuals**: streamlines over in-plane speed, velocity vectors, swirl velocity,
  local mean age, solids concentration. Hover for local values.
- **RTD**: E(θ) and F(t) against an ideal CSTR, mean and variance, tanks-in-series equivalent,
  breakthrough and t10/t50/t90, early bypass, well-mixed volume fraction.
- **Solids**: terminal and hindered settling velocity, Zwietering just-suspended speed and N/Njs,
  axial concentration profile, cloud height, uniformity, bottom build-up, outlet-to-tank concentration ratio.

## Model

| Part | Method |
|---|---|
| Flow (`js/solver.js`) | Incompressible Navier–Stokes with swirl on a 2-D axisymmetric (r, z) staggered grid. Van Leer advection, projection method, direct pressure solve (fast cosine transform in z, tridiagonal in r), mixing-length eddy viscosity, power-law wall function. Run to steady state, then time-averaged. |
| Impeller | Blade-element normal-force source in the swept volume. Radial or axial pumping follows from blade angle and rotation. |
| Baffles | Drag on swirl in the annulus the baffles occupy. |
| RTD and mean age (`js/analysis.js`) | Tracer step transported on the frozen mean flow (upwind finite volume, L-stable SDIRK2, banded direct solver). Mean age from a steady solve. |
| Solids | Not tracked as particles. Schiller–Naumann terminal velocity, Richardson–Zaki hindered settling, and a drift-flux balance (settling against turbulent dispersion) at fixed inventory. Zwietering correlation for the just-suspended speed. |

### Limits

- Axisymmetric: blade-to-blade and baffle-to-baffle detail, trailing vortices and surface vortexing
  are averaged out. The feed is a ring at the surface and a side outlet is a slot round the wall.
- Flat bottom, flat free surface, Newtonian liquid, no gas.
- Power and pumping numbers come from the solved field and typically land within about 30% of
  published values (for example Rushton Np ≈ 4.3 against 5; pitched blade Np ≈ 1.1 against 1.3).
- Solids do not feed back on the liquid flow. The Zwietering constant S is estimated from impeller
  type, D/T and clearance.
- Intended for screening and comparing options. Confirm critical designs with 3-D CFD or tests.
