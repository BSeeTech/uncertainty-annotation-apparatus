import { buildTransferFunctions } from '../utils/transferFunctions';

describe('buildTransferFunctions', () => {
  it('produces 5 colour stops spanning [0, maxEntropy]', () => {
    const tf = buildTransferFunctions({ maxEntropy: Math.log(2) });
    expect(tf.color).toHaveLength(5);
    expect(tf.color[0].x).toBe(0);
    expect(tf.color[tf.color.length - 1].x).toBeCloseTo(Math.log(2), 6);
    // Monotonically increasing x
    for (let i = 1; i < tf.color.length; i++) {
      expect(tf.color[i].x).toBeGreaterThan(tf.color[i - 1].x);
    }
  });

  it('produces an opacity ramp that is 0 at x=0 and at the suppress knee', () => {
    const tf = buildTransferFunctions({
      maxEntropy: 1.0,
      baseOpacity: 0.5,
      suppressBelow: 0.1,
    });
    expect(tf.opacity[0]).toEqual({ x: 0, alpha: 0 });
    // Knee at 10% of max
    const knee = tf.opacity[1];
    expect(knee.x).toBeCloseTo(0.1, 6);
    expect(knee.alpha).toBe(0);
    // Top of ramp == baseOpacity
    const top = tf.opacity[tf.opacity.length - 1];
    expect(top.x).toBeCloseTo(1.0, 6);
    expect(top.alpha).toBe(0.5);
  });

  it('honours baseOpacity scaling at the earlyPeak', () => {
    const tf = buildTransferFunctions({ maxEntropy: 1.0, baseOpacity: 1.0 });
    // Step function: opacity jumps to baseOpacity at knee+1e-8
    const opaqueStops = tf.opacity.filter(p => p.x > 0.1);
    for (const stop of opaqueStops) {
      expect(stop.alpha).toBeCloseTo(1.0, 6);
    }
    expect(tf.opacity[tf.opacity.length - 1].alpha).toBe(1.0);

    const tf2 = buildTransferFunctions({ maxEntropy: 1.0, baseOpacity: 0.5 });
    const opaqueStops2 = tf2.opacity.filter(p => p.x > 0.1);
    for (const stop of opaqueStops2) {
      expect(stop.alpha).toBeCloseTo(0.5, 6);
    }
    expect(tf2.opacity[tf2.opacity.length - 1].alpha).toBe(0.5);
  });

  it('clamps baseOpacity into [0, 1]', () => {
    const tf = buildTransferFunctions({ maxEntropy: 1.0, baseOpacity: 5 });
    expect(tf.opacity[tf.opacity.length - 1].alpha).toBe(1);
    const tf2 = buildTransferFunctions({ maxEntropy: 1.0, baseOpacity: -2 });
    expect(tf2.opacity[tf2.opacity.length - 1].alpha).toBe(0);
  });

  it('throws on non-positive maxEntropy', () => {
    expect(() => buildTransferFunctions({ maxEntropy: 0 })).toThrow();
    expect(() => buildTransferFunctions({ maxEntropy: -1 })).toThrow();
  });

  it('uses ln(2) as the default maxEntropy (binary case)', () => {
    const tf = buildTransferFunctions();
    expect(tf.meta.maxEntropy).toBeCloseTo(Math.log(2), 6);
  });
});
