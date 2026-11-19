/*
 * Species data and example cases for the rotary kiln model.
 * Heat capacities use the Shomate form cp = A + B t + C t^2 + D t^3 + E/t^2 (J/mol K), t = T/1000.
 * Gas coefficients are single-range least-squares fits (298-2500 K) to NIST-JANAF data;
 * solids use NIST Shomate or Maier-Kelley coefficients.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KilnPresets = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SPECIES_LIBRARY = [
    { name: 'CaCO3', phase: 'solid', mw: 100.086, cp: [104.52, 21.92, 0, 0, -2.594] },
    { name: 'CaO', phase: 'solid', mw: 56.077, cp: [49.95403, 4.887916, -0.352056, 0.046187, -0.825097] },
    { name: 'MgCO3', phase: 'solid', mw: 84.313, cp: [77.91, 57.74, 0, 0, -1.741] },
    { name: 'MgO', phase: 'solid', mw: 40.304, cp: [47.25995, 5.681621, -0.872665, 0.1043, -1.053955] },
    { name: 'SiO2', phase: 'solid', mw: 60.083, cp: [41.40126, 80.89923, -70.77099, 20.81127, -1.52442] },
    { name: 'Al2O3', phase: 'solid', mw: 101.961, cp: [102.429, 38.7498, -15.9109, 2.628181, -3.007551] },
    { name: 'C', phase: 'solid', mw: 12.011, cp: [17.15, 4.27, 0, 0, -0.879] },
    { name: 'H2O(l)', phase: 'solid', mw: 18.015, cp: [75.3, 0, 0, 0, 0] },
    { name: 'N2', phase: 'gas', mw: 28.014, cp: [22.18468, 15.06902, -5.60781, 0.75254, 0.28326] },
    { name: 'O2', phase: 'gas', mw: 31.998, cp: [24.47756, 16.88316, -8.01242, 1.43408, 0.02723] },
    { name: 'CO2', phase: 'gas', mw: 44.009, cp: [31.805, 36.65895, -16.44136, 2.62651, -0.40498] },
    { name: 'H2O', phase: 'gas', mw: 18.015, cp: [26.44489, 16.00586, -0.88685, -0.46275, 0.2397] },
    { name: 'CO', phase: 'gas', mw: 28.010, cp: [21.89419, 16.92337, -6.9387, 1.02082, 0.26013] },
    { name: 'CH4', phase: 'gas', mw: 16.043, cp: [0.78476, 105.41085, -40.79932, 5.72506, 0.60208] },
    { name: 'SO2', phase: 'gas', mw: 64.064, cp: [37.22789, 30.00706, -14.89348, 2.57107, -0.51162] }
  ];

  const lib = name => {
    const s = SPECIES_LIBRARY.find(x => x.name === name);
    return { name: s.name, phase: s.phase, mw: s.mw, cp: s.cp.slice() };
  };

  const limeKiln = {
    name: 'Lime kiln, counter-current, gas burner',
    notes: 'Long lime kiln with a chain section at the feed end. Burner fires natural gas with secondary air preheated in the cooler.',
    kiln: { length: 60, diameter: 3.0, slope: 2.5, rpm: 1.0, bedModel: 'kramers', repose: 35, damHeight: 0.25, fill: 8, cells: 200 },
    wall: {
      layers: [
        { name: 'Alumina brick', thickness: 0.2, k: 1.8 },
        { name: 'Insulating backup', thickness: 0.05, k: 0.3 },
        { name: 'Steel shell', thickness: 0.025, k: 45 }
      ],
      emissivity: 0.85, shellEmissivity: 0.8, ambientT: 25, extMode: 'correlation', hExt: 15, wind: 2
    },
    solids: {
      feedRate: 18, feedT: 25, bulkDensity: 1500, emissivity: 0.9, bedConductivity: 0.35,
      composition: { CaCO3: 88, MgCO3: 4, SiO2: 5, 'H2O(l)': 3 }
    },
    gas: {
      direction: 'counter', pressure: 101.325, emissivity: 0.25,
      inlet: { flow: 0, T: 25, composition: { N2: 79, O2: 21 } }
    },
    burner: {
      enabled: true, fuel: 'CH4', lhv: 50.0, firing: 11, excessAir: 10, airT: 600, fuelT: 25,
      flameLength: 15, flameEmissivity: 0.6, profile: 'bell'
    },
    heatTransfer: {
      convModel: 'tw', hgw: 15, hgs: 20, convMult: 1, wallSolidModel: 'penetration', hws: 150, hContact: 500,
      lifterUa: 250, lifterStart: 0, lifterEnd: 15
    },
    species: ['CaCO3', 'CaO', 'MgCO3', 'MgO', 'SiO2', 'H2O(l)', 'N2', 'O2', 'CO2', 'H2O', 'CH4'].map(lib),
    reactions: [
      { name: 'Drying', equation: 'H2O(l) -> H2O', key: 'H2O(l)', order: 1, A: 5.13e10, Ea: 88, dH: 44.0, enabled: true },
      { name: 'Magnesite calcination', equation: 'MgCO3 -> MgO + CO2', key: 'MgCO3', order: 1, A: 4e6, Ea: 150, dH: 117, enabled: true },
      { name: 'Calcination', equation: 'CaCO3 -> CaO + CO2', key: 'CaCO3', order: 1, A: 5e6, Ea: 180, dH: 178.3, enabled: true }
    ]
  };

  const sandDryer = {
    name: 'Sand dryer, co-current, hot gas',
    notes: 'Direct co-current dryer with flights along the whole length, fed by flue gas from a separate furnace.',
    kiln: { length: 15, diameter: 2.0, slope: 3, rpm: 4, bedModel: 'fill', repose: 35, damHeight: 0, fill: 12, cells: 150 },
    wall: {
      layers: [
        { name: 'Castable lining', thickness: 0.1, k: 1.2 },
        { name: 'Steel shell', thickness: 0.012, k: 45 }
      ],
      emissivity: 0.85, shellEmissivity: 0.8, ambientT: 15, extMode: 'correlation', hExt: 15, wind: 1
    },
    solids: {
      feedRate: 20, feedT: 15, bulkDensity: 1600, emissivity: 0.9, bedConductivity: 0.3,
      composition: { SiO2: 92, 'H2O(l)': 8 }
    },
    gas: {
      direction: 'co', pressure: 101.325, emissivity: 0.15,
      inlet: { flow: 6000, T: 800, composition: { N2: 75, O2: 12, CO2: 4, H2O: 9 } }
    },
    burner: {
      enabled: false, fuel: 'CH4', lhv: 50.0, firing: 2, excessAir: 20, airT: 25, fuelT: 25,
      flameLength: 4, flameEmissivity: 0.4, profile: 'uniform'
    },
    heatTransfer: {
      convModel: 'tw', hgw: 15, hgs: 20, convMult: 1, wallSolidModel: 'penetration', hws: 150, hContact: 500,
      lifterUa: 100, lifterStart: 0, lifterEnd: 15
    },
    species: ['SiO2', 'H2O(l)', 'N2', 'O2', 'CO2', 'H2O', 'CH4'].map(lib),
    reactions: [
      { name: 'Drying', equation: 'H2O(l) -> H2O', key: 'H2O(l)', order: 1, A: 5.13e10, Ea: 88, dH: 44.0, enabled: true }
    ]
  };

  const PRESETS = [
    { id: 'lime', label: 'Lime kiln (counter-current, burner)', data: limeKiln },
    { id: 'dryer', label: 'Sand dryer (co-current, hot gas)', data: sandDryer }
  ];

  return { SPECIES_LIBRARY, PRESETS, clone: o => JSON.parse(JSON.stringify(o)) };
}));
