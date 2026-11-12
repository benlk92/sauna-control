// Preheat model: t_preheat = a + b * (T_target - T_start), in minutes.

export interface PreheatRun {
  startF: number;
  targetF: number;
  minutes: number;
}

export interface Prediction {
  minutes: number;
  method: 'default' | 'ratio' | 'fit';
  runs: number;
  a?: number;
  b?: number;
}

export const DEFAULT_PREHEAT_MIN = 60;
export const MAX_FIT_RUNS = 20;
/** Runs that started above this are not "clean". */
export const CLEAN_START_MAX_F = 120;

const MIN_PREDICTION = 5;
const MAX_PREDICTION = 180;

const clamp = (x: number) => Math.min(MAX_PREDICTION, Math.max(MIN_PREDICTION, x));

/**
 * Predict preheat minutes for a given climb.
 * @param runs clean runs, most recent first (only the first 20 are used for the fit)
 */
export function predictPreheat(runs: PreheatRun[], startF: number, targetF: number): Prediction {
  const climb = Math.max(0, targetF - startF);
  const usable = runs.filter((r) => r.targetF - r.startF > 0 && r.minutes > 0);

  if (usable.length === 0) {
    return { minutes: DEFAULT_PREHEAT_MIN, method: 'default', runs: 0 };
  }

  if (usable.length < 3) {
    const perF = usable.reduce((s, r) => s + r.minutes / (r.targetF - r.startF), 0) / usable.length;
    return { minutes: clamp(perF * climb), method: 'ratio', runs: usable.length, b: perF };
  }

  const recent = usable.slice(0, MAX_FIT_RUNS);
  const fit = leastSquares(recent.map((r) => [r.targetF - r.startF, r.minutes]));
  if (!fit || fit.b <= 0) {
    // All runs had the same climb (or the fit came out nonsensical): fall back to the ratio.
    const perF = recent.reduce((s, r) => s + r.minutes / (r.targetF - r.startF), 0) / recent.length;
    return { minutes: clamp(perF * climb), method: 'ratio', runs: recent.length, b: perF };
  }
  return { minutes: clamp(fit.a + fit.b * climb), method: 'fit', runs: recent.length, a: fit.a, b: fit.b };
}

function leastSquares(points: [number, number][]): { a: number; b: number } | null {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx < 1e-9) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** Margin: 10% of the prediction or 5 minutes, whichever is larger. */
export function marginMinutes(predictedMin: number): number {
  return Math.max(predictedMin * 0.1, 5);
}

/** When to turn the heater on to be hot by `hotBy` (epoch ms). */
export function scheduledStart(hotBy: number, predictedMin: number): number {
  return hotBy - (predictedMin + marginMinutes(predictedMin)) * 60_000;
}

/**
 * Minutes left until hot during a live preheat. Scales the prediction for the whole climb
 * by the fraction of the climb still remaining.
 */
export function etaMinutes(
  runs: PreheatRun[],
  startF: number,
  currentF: number,
  targetF: number,
): number {
  if (currentF >= targetF) return 0;
  const total = predictPreheat(runs, startF, targetF).minutes;
  const climb = targetF - startF;
  const remainingFrac = climb > 0 ? Math.min(1, (targetF - currentF) / climb) : 1;
  return Math.max(1, Math.round(total * remainingFrac));
}
