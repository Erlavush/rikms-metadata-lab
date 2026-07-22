import assert from "node:assert/strict";
import test from "node:test";
import { applyCalibration, trainCalibrationProfile } from "./calibration.js";

test("does not claim calibration before enough reviewed outcomes exist", () => {
  const profile = trainCalibrationProfile(Array.from({ length: 19 }, (_, index) => ({
    score: index / 20,
    outcome: index > 9 ? 1 : 0,
  })));
  assert.equal(profile, null);
});

test("fits a bounded monotonic reliability profile", () => {
  const points = Array.from({ length: 40 }, (_, index) => ({
    score: (index + 1) / 42,
    outcome: index % 7 === 0 ? 1 : index > 21 ? 1 : 0,
  }));
  const profile = trainCalibrationProfile(points);
  assert.ok(profile);
  assert.equal(profile.sampleCount, 40);
  assert.ok(profile.brierAfter <= profile.brierBefore);
  for (let index = 1; index < profile.segments.length; index += 1) {
    assert.ok(profile.segments[index].calibratedScore >= profile.segments[index - 1].calibratedScore);
  }
  assert.ok(applyCalibration(profile, -1) >= 0);
  assert.ok(applyCalibration(profile, 2) <= 1);
});
