/*
 * cost-estimator.js — Area-based repair cost estimation with severity scoring
 *
 * Multi-factor regression considering damage area, aspect ratio,
 * type-specific labor rates, and severity tiers.
 * Outputs point estimates with confidence intervals.
 *
 * Input:  array of damage entries (dent/scratch/crack only)
 * Output: array of { ...entry, estimatedCost, costLow, costHigh,
 *                     currency, severity, breakdown }
 */

const CURRENCY = "USD";

/*
 * Severity tiers based on area (cm²).
 * Each tier scales the base cost.
 */
const SEVERITY_THRESHOLDS = {
  dent: [
    { maxAreaCm2: 25, label: "Minor", multiplier: 1.0 },
    { maxAreaCm2: 150, label: "Moderate", multiplier: 1.6 },
    { maxAreaCm2: 500, label: "Significant", multiplier: 2.4 },
    { maxAreaCm2: Infinity, label: "Severe", multiplier: 3.5 },
  ],
  scratch: [
    { maxAreaCm2: 20, label: "Minor", multiplier: 1.0 },
    { maxAreaCm2: 100, label: "Moderate", multiplier: 1.4 },
    { maxAreaCm2: 400, label: "Significant", multiplier: 2.0 },
    { maxAreaCm2: Infinity, label: "Severe", multiplier: 3.0 },
  ],
  crack: [
    { maxAreaCm2: 15, label: "Minor", multiplier: 1.0 },
    { maxAreaCm2: 80, label: "Moderate", multiplier: 1.8 },
    { maxAreaCm2: 300, label: "Significant", multiplier: 2.8 },
    { maxAreaCm2: Infinity, label: "Severe", multiplier: 4.0 },
  ],
};

/*
 * Base cost model coefficients.
 *
 * cost = baseFee + (areaCm2 × perCm2Rate) + (perimeterCm × perimeterRate)
 *
 * The perimeter term captures edge complexity — long narrow scratches
 * cost more per unit area than compact dents.
 */
const COST_MODEL = {
  dent: {
    baseFee: 65,
    perCm2Rate: 1.8,
    perimeterRate: 0.9,
    paintProbability: 0.4,
    paintAdder: 120,
  },
  scratch: {
    baseFee: 40,
    perCm2Rate: 1.2,
    perimeterRate: 1.5,
    paintProbability: 0.7,
    paintAdder: 90,
  },
  crack: {
    baseFee: 95,
    perCm2Rate: 2.5,
    perimeterRate: 1.1,
    paintProbability: 0.6,
    paintAdder: 150,
  },
};

/* Confidence band as fraction of estimate */
const CONFIDENCE_BAND = {
  manual: 0.2,
  estimate: 0.35,
};

function getSeverity(damageType, areaCm2) {
  const tiers = SEVERITY_THRESHOLDS[damageType];
  if (!tiers) return { label: "Unknown", multiplier: 1.0 };
  for (const tier of tiers) {
    if (areaCm2 <= tier.maxAreaCm2) return tier;
  }
  return tiers[tiers.length - 1];
}

function computeDimensions(entry) {
  const wCm = (entry.widthM ?? entry.distance) * 100;
  const hCm = (entry.heightM ?? entry.distance) * 100;
  return { wCm, hCm, areaCm2: wCm * hCm, perimeterCm: 2 * (wCm + hCm) };
}

export async function estimateRepairCosts(damageEntries) {
  const results = [];

  for (const entry of damageEntries) {
    const model = COST_MODEL[entry.damageType];
    if (!model) continue;

    const { wCm, hCm, areaCm2, perimeterCm } = computeDimensions(entry);
    const severity = getSeverity(entry.damageType, areaCm2);

    /* base regression */
    let laborCost =
      model.baseFee +
      areaCm2 * model.perCm2Rate +
      perimeterCm * model.perimeterRate;

    /* severity multiplier */
    laborCost *= severity.multiplier;

    /* expected paint cost (probability-weighted) */
    const expectedPaintCost = model.paintProbability * model.paintAdder;
    const rawCost = laborCost + expectedPaintCost;
    const estimatedCost = Math.round(rawCost);

    /* confidence interval */
    const band = entry.isEstimate
      ? CONFIDENCE_BAND.estimate
      : CONFIDENCE_BAND.manual;
    const costLow = Math.round(estimatedCost * (1 - band));
    const costHigh = Math.round(estimatedCost * (1 + band));

    results.push({
      ...entry,
      estimatedCost,
      costLow,
      costHigh,
      currency: CURRENCY,
      severity: severity.label,
      breakdown: {
        laborCost: Math.round(laborCost),
        paintCost: Math.round(expectedPaintCost),
        baseFee: model.baseFee,
        areaCm2: Math.round(areaCm2 * 10) / 10,
        perimeterCm: Math.round(perimeterCm * 10) / 10,
        severityMultiplier: severity.multiplier,
      },
    });
  }

  return results;
}
