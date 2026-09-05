import { computeBackoffDelayMs } from './retry';

describe('computeBackoffDelayMs', () => {
  it('supports fixed and capped exponential policies', () => {
    expect(computeBackoffDelayMs({ type: 'fixed', delayMs: 250 }, 3)).toBe(250);
    expect(() => computeBackoffDelayMs({ type: 'fixed', delayMs: -1 }, 1)).toThrow(
      'jobs_invalid_input',
    );
    expect(computeBackoffDelayMs({ type: 'exponential', delayMs: 100, maxDelayMs: 250 }, 1)).toBe(
      100,
    );
    expect(computeBackoffDelayMs({ type: 'exponential', delayMs: 100, maxDelayMs: 250 }, 2)).toBe(
      200,
    );
    expect(computeBackoffDelayMs({ type: 'exponential', delayMs: 100, maxDelayMs: 250 }, 3)).toBe(
      250,
    );
    expect(() =>
      computeBackoffDelayMs({ type: 'exponential', delayMs: 100, maxDelayMs: -1 }, 1),
    ).toThrow('jobs_invalid_input');
    expect(() =>
      computeBackoffDelayMs({ type: 'exponential', delayMs: Number.NaN, maxDelayMs: 250 }, 1),
    ).toThrow('jobs_invalid_input');
    expect(() =>
      computeBackoffDelayMs({ type: 'exponential', delayMs: Number.MAX_VALUE }, 2),
    ).toThrow('jobs_invalid_input');
    expect(computeBackoffDelayMs({ type: 'exponential', delayMs: 100 }, 2000)).toBe(2147483647);
    expect(computeBackoffDelayMs({ type: 'exponential', delayMs: 0 }, 2000)).toBe(0);
  });

  it('bounds jitter to the documented symmetric range', () => {
    const random = jest.spyOn(Math, 'random');
    random.mockReturnValueOnce(0).mockReturnValueOnce(1);

    expect(computeBackoffDelayMs({ type: 'fixed', delayMs: 100, jitter: 0.25 }, 1)).toBe(75);
    expect(computeBackoffDelayMs({ type: 'fixed', delayMs: 100, jitter: 0.25 }, 1)).toBe(125);

    random.mockReturnValueOnce(1);
    expect(() =>
      computeBackoffDelayMs({ type: 'fixed', delayMs: Number.MAX_VALUE, jitter: 1 }, 1),
    ).toThrow('jobs_invalid_input');

    random.mockRestore();
  });
});
