# Rotary Kiln Simulator

A browser app that calculates the one-dimensional, steady-state heat and mass balance of a direct-fired rotary kiln. It plots the axial profiles of solids, gas, wall and shell temperature, solids and gas composition, heat flux into the bed, cumulative heat transferred, and heat loss to the surroundings, and reports closed energy and mass balances.

Everything runs locally in the browser with no dependencies. The solver also runs under Node for scripting and testing.

## Running it

Open `index.html` in a modern browser. It works straight from the file system.

To get a single file you can email or archive:

```bash
node tools/build-standalone.js          # writes dist/rotary-kiln-simulator.html
```

The app opens on a worked example (a counter-current lime kiln). A second example is a co-current sand dryer fed with hot gas. With **Auto-run** on, each edit re-solves the kiln after a short pause; otherwise press **Run** (or Ctrl/⌘+Enter). Use **Case file** to copy, paste, load or download a case as JSON. The current case is also kept in the browser's local storage.

## What you can set

| Area | Inputs |
|---|---|
| Kiln | Length, internal diameter, slope, rotation speed, number of axial cells |
| Bed depth | Kramers equation (dynamic angle of repose, discharge dam height) or a fixed fill fraction |
| Wall | Any number of lining layers (thickness, conductivity), inner wall emissivity, shell emissivity, ambient temperature, shell convection (natural + wind correlation, or fixed) |
| Feed | Feed rate, temperature, bulk density, mass composition |
| Species | Any number of solid and gas species: molar mass and heat capacity coefficients (Shomate form). A library of common kiln species is included |
| Gas | Direction (co-current or counter-current), pressure, non-luminous gas emissivity, hot gas inlet (flow, temperature, composition) entering at the gas inlet end |
| Burner | Fuel (any gas species named by formula), LHV, firing rate, fuel and combustion air temperature, excess air, flame length, flame emissivity, heat release profile (uniform, bell, front-loaded) |
| Heat transfer | Convection correlation (Tscheng & Watkinson, Dittus–Boelter, or fixed), multiplier, covered-wall-to-bed contact (penetration theory or fixed), chains/lifters zone with a volumetric coefficient |
| Reactions | Any number of reactions written as equations (`CaCO3 -> CaO + CO2`), key reactant, zero or first order, Arrhenius A and Ea, heat of reaction |

## What you get

- Temperature profiles: gas, solids, inner wall, shell
- Shell (exterior surface) temperature
- Solids composition (wt %) and gas composition (mol %, wet)
- Heat flux into the bed by path: gas radiation, gas convection, wall radiation, covered-wall contact, chains/lifters
- Cumulative heat into the bed, lost through the shell and released by the burner
- Heat loss to the surroundings per metre, split into radiation and convection
- Reaction rates, bed fill, and convective coefficients along the kiln
- Energy balance (MW, referred to 25 °C, fuel on LHV), mass balance, inlet/outlet stream compositions
- A profile data table with CSV export

Charts follow the light/dark theme, show values on hover (or with the arrow keys), and let you hide series from the legend.

## The model

### Discretisation

The kiln of length *L* is split into *N* equal cells. Each cell holds a well-mixed slice of the bed and of the freeboard gas ("cells in series"). Solids always move from the feed end (*z* = 0) to the discharge end (*z* = *L*); gas moves the same way (co-current) or the opposite way (counter-current). Each cell has these unknowns:

- bed temperature *T*s, gas temperature *T*g, inner (hot-face) wall temperature *T*w, shell temperature *T*sh
- the molar flow of every solid species and every gas species

The balances are written in conservative form over each cell, so the discrete energy and mass balances close to round-off at convergence.

### Species balances

For a species *i* in cell *k*, with the upstream cell of its own phase *u*:

*F*i,k − *F*i,u = Δz · Σr νi,r ξ̇r + burner terms

where ξ̇r is the extent rate of reaction *r* per metre of kiln.

### Reaction kinetics

Each reaction has a key reactant. Its rate follows

dw/dt = −k · wⁿ,  k = A · exp(−Ea / R T),  n = 0 or 1

where *w* is the mass fraction of the key reactant in its own phase (bed or gas) and *T* is that phase's temperature. Per metre of kiln this is a molar rate of *k* · *M* · *w*ⁿ / *M*key, with *M* the phase hold-up per metre (ρbulk·*A*bed for the bed, ρgas·*A*gas for the gas). Zero-order rates switch off smoothly as the key reactant runs out (factor *w*/(*w* + 10⁻⁵)), and every other reactant applies the same switch so no species goes negative.

### Energy balances

Energy is carried as sensible enthalpy relative to 25 °C,

*H*phase = Σ *F*i Δ*h*i(*T*),  Δ*h*i(*T*) = ∫ *c*p,i d*T* from 298.15 K,

with *c*p in Shomate form *c*p = A + B·t + C·t² + D·t³ + E/t², t = *T*/1000 K (held constant outside 250–3000 K). Reaction heat Δ*H*r is applied at 25 °C in the phase of the key reactant. A species that crosses between phases (for example CO₂ released from the bed) carries its sensible enthalpy at the temperature of the phase it leaves, so the heat of reaction at the actual temperature follows automatically from Kirchhoff's law.

For each cell:

- **Bed**: *H*s,k − *H*s,k−1 = Δz [*q*gas→bed,conv + *q*rad→bed + *q*wall→bed,contact + *q*lifters − Σ ξ̇ Δ*H* + transfer terms]
- **Gas**: *H*g,k − *H*g,u = Δz [*q*burner − *q*gas→bed,conv − *q*gas→wall,conv + *q*rad→gas − *q*lifters + reaction and transfer terms]
- **Inner wall** (algebraic): *q*rad→wall + *q*gas→wall,conv − *q*wall→bed,contact − *q*conduction = 0
- **Shell** (algebraic): *q*conduction − *q*shell→air,conv − *q*shell→air,rad = 0

### Heat transfer

**Radiation.** The cross-section is treated as a grey-gas enclosure of three zones: the gas, the exposed wall (arc *R*(2π − θ)) and the flat bed surface (chord 2*R* sin θ/2), where θ is the bed's central angle. The bed sees only the wall. The radiosity network has surface resistances (1−ε)/(εA) for wall and bed, gas–surface conductances *A*·εg, and a wall–bed conductance *A*bed(1 − εg). Solving the two radiosity nodes gives the net radiation absorbed by the wall, the bed and the gas in every cell.

**Flame.** Inside the flame (from the burner tip to the flame length) the gas emissivity rises to the flame emissivity, so the flame radiates to the wall and bed. The burner's heat is released into the gas along the flame with the chosen profile (uniform, a sine bell peaking mid-flame, or exponentially front-loaded). Fuel and combustion air enter at the gas inlet end; fuel CₓHᵧOzSₛNₙ burns to CO₂, H₂O, SO₂ and N₂ on its lower heating value, with combustion air from the stoichiometric O₂ demand times (1 + excess air).

**Hot gas inlet.** A separate hot gas stream (flow, temperature, composition) enters at the gas inlet end: the discharge end for counter-current flow, the feed end for co-current flow.

**Convection.** Either Tscheng & Watkinson (1979):

*h*gw = 1.54 (*k*g/*D*e) Re⁰·⁵⁷⁵ Reω⁻⁰·²⁹²,  *h*gs = 0.46 (*k*g/*D*e) Re⁰·⁵³⁵ Reω⁰·¹⁰⁴ η⁻⁰·³⁴¹

with *D*e the hydraulic diameter of the freeboard, Reω = ρω*D*e²/μ and η the fill fraction; or Dittus–Boelter pipe flow (Nu = 0.023 Re⁰·⁸ Pr⁰·⁴); or fixed coefficients. Gas transport properties are air-like (Sutherland viscosity, power-law conductivity).

**Covered wall to bed.** Penetration theory over the contact time θ/ω, *h* = 2√(*k*ρ*c*ω / πθ), in series with a wall contact coefficient; or a fixed coefficient.

**Chains or lifters.** Optional extra gas–bed exchange *U*a·π*R*²·(*T*g − *T*s) per metre over a chosen zone.

**Wall conduction.** Radial conduction through each lining layer, *R*′ = Σ ln(*r*o/*r*i)/(2π*k*).

**Losses to the surroundings.** Shell radiation ε σ (*T*sh⁴ − *T*a⁴) plus convection from Churchill–Chu natural convection combined with Churchill–Bernstein cross-flow for wind (Nu³ = Nunat³ + Nuforced³), or a fixed coefficient.

### Bed depth and residence time

With the Kramers & Croockewit (1952) equation

d*h*/d*z* = tan β [ tan α / sin β − 3*Q* / (4π*n**R*³) · (2*h*/*R* − *h*²/*R*²)^(−3/2) ]

integrated from the discharge dam back to the feed end, using the local volumetric flow from the solved solids mass flow (so the bed thins as the solids lose CO₂ or water). The model iterates between the bed profile and the heat and mass balance until the profile stops changing. Alternatively a fixed fill fraction can be used. The solids residence time is ∫ ρbulk *A*bed / ṁs d*z*.

### Numerical method

The full block-tridiagonal system is solved at once. Starting from cold, the solver marches a backward-Euler start-up transient that uses physical hold-ups (bed, gas, lining) as capacitances, with Newton–chord iterations inside each step and an adaptive step size. As the steps grow the method becomes Newton's method on the steady equations and converges quadratically. This copes with sharp reaction fronts (such as the calcination front) that defeat a plain Newton iteration. Co-current kilns are first solved by marching cell by cell, which is exact for that flow arrangement. In the browser the solver runs in a Web Worker so the page stays responsive.

### Verification

`node tests/run-tests.js` runs 60+ checks, including:

- energy and mass balance closure for every option combination
- an isothermal kiln with a zero-heat reaction, matching the exact cell-in-series conversion for zero- and first-order kinetics
- the Kramers normal depth against its closed form
- grid independence of outlet temperatures
- the second law for co-current flow (gas leaves no colder than the solids)

### Limitations

- One-dimensional: no radial temperature gradients in the bed, no separate flame core, no axial conduction in the wall or bed.
- Grey-gas radiation with user-set emissivities; no spectral gas model or dust loading.
- Reactions are kinetic only: no equilibrium limits (for example, no CO₂ back-pressure on calcination) and no melting or sintering.
- Counter-current kilns fired well beyond what the reactions need can develop a runaway hot zone, where hot product preheats the incoming air and the flame becomes super-adiabatic. That is the model's honest answer for those inputs; reduce the firing rate.

## Using the solver from Node

```js
const KilnModel = require('./js/kiln-model.js');
const { PRESETS, clone } = require('./js/presets.js');

const input = clone(PRESETS[0].data);   // lime kiln example
input.burner.firing = 10.5;             // MW
const r = KilnModel.solve(input);
console.log(r.outlet.solids.T - 273.15, r.summary.conversions, r.energy.closure);
```

The input object has the same shape as a saved case file. Temperatures are entered in °C, feed rate in t/h, gas flow in Nm³/h, firing rate in MW, activation energy and heat of reaction in kJ/mol. Results use SI units (K, W, mol/s).

## Files

| Path | Contents |
|---|---|
| `index.html` | Page layout and styles |
| `js/kiln-model.js` | Physical model and solver (browser and Node) |
| `js/presets.js` | Species library and example cases |
| `js/charts.js` | SVG line charts |
| `js/app.js` | User interface |
| `tests/run-tests.js` | Verification and regression tests |
| `tools/build-standalone.js` | Bundles everything into one HTML file |

## References

- Tscheng, S. H. & Watkinson, A. P. (1979). Convective heat transfer in a rotary kiln. *Can. J. Chem. Eng.* 57, 433–443.
- Kramers, H. & Croockewit, P. (1952). The passage of granular solids through inclined rotary kilns. *Chem. Eng. Sci.* 1, 259–265.
- Gorog, J. P., Adams, T. N. & Brimacombe, J. K. (1982). Regenerative heat transfer in rotary kilns. *Metall. Trans. B* 13, 153–163.
- Churchill, S. W. & Chu, H. H. S. (1975). Correlating equations for laminar and turbulent free convection from a horizontal cylinder. *Int. J. Heat Mass Transfer* 18, 1049–1053.
- Churchill, S. W. & Bernstein, M. (1977). A correlating equation for forced convection from gases and liquids to a circular cylinder in crossflow. *J. Heat Transfer* 99, 300–306.
- NIST Chemistry WebBook, Shomate heat capacity data.
