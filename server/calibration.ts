export type CalibrationPoint = {
  score: number;
  outcome: number;
};

export type CalibrationSegment = {
  minimumScore: number;
  maximumScore: number;
  calibratedScore: number;
  samples: number;
};

export type CalibrationProfile = {
  sampleCount: number;
  segments: CalibrationSegment[];
  brierBefore: number;
  brierAfter: number;
};

type Pool = {
  minimumScore: number;
  maximumScore: number;
  outcomes: number;
  samples: number;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function applyCalibration(profile: CalibrationProfile, rawScore: number): number {
  const score = clamp(rawScore);
  const segment = profile.segments.find((candidate) => score <= candidate.maximumScore)
    ?? profile.segments.at(-1);
  return segment ? segment.calibratedScore : score;
}

/**
 * Fits a monotonic reliability curve using the pool-adjacent-violators
 * algorithm. A profile is intentionally withheld until enough independently
 * reviewed outcomes exist; before then the UI and API report "uncalibrated".
 */
export function trainCalibrationProfile(points: CalibrationPoint[], minimumSamples = 20): CalibrationProfile | null {
  const clean = points
    .filter((point) => Number.isFinite(point.score) && Number.isFinite(point.outcome))
    .map((point) => ({ score: clamp(point.score), outcome: clamp(point.outcome) }))
    .sort((left, right) => left.score - right.score);
  if (clean.length < minimumSamples || new Set(clean.map((point) => point.outcome)).size < 2) return null;

  const pools: Pool[] = [];
  for (const point of clean) {
    pools.push({ minimumScore: point.score, maximumScore: point.score, outcomes: point.outcome, samples: 1 });
    while (pools.length >= 2) {
      const right = pools.at(-1)!;
      const left = pools.at(-2)!;
      if (left.outcomes / left.samples <= right.outcomes / right.samples) break;
      pools.splice(-2, 2, {
        minimumScore: left.minimumScore,
        maximumScore: right.maximumScore,
        outcomes: left.outcomes + right.outcomes,
        samples: left.samples + right.samples,
      });
    }
  }

  const segments = pools.map((pool) => ({
    minimumScore: pool.minimumScore,
    maximumScore: pool.maximumScore,
    calibratedScore: Math.round((pool.outcomes / pool.samples) * 10_000) / 10_000,
    samples: pool.samples,
  }));
  const brierBefore = clean.reduce((sum, point) => sum + (point.score - point.outcome) ** 2, 0) / clean.length;
  const draft: CalibrationProfile = { sampleCount: clean.length, segments, brierBefore, brierAfter: 0 };
  const brierAfter = clean.reduce((sum, point) => sum + (applyCalibration(draft, point.score) - point.outcome) ** 2, 0) / clean.length;
  return {
    ...draft,
    brierBefore: Math.round(brierBefore * 1_000_000) / 1_000_000,
    brierAfter: Math.round(brierAfter * 1_000_000) / 1_000_000,
  };
}
