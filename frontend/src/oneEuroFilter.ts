export type OneEuroConfig = {
  frequency: number;
  minCutoff: number;
  beta: number;
  dCutoff: number;
  derivativeScale: number;
};

/** Adaptive low-pass filter: steadier at rest and more responsive during fast motion. */
export class OneEuroFilter {
  private previousTimestamp: number | null = null;
  private previousRaw: number | null = null;
  private previousFiltered: number | null = null;
  private previousDerivative = 0;

  constructor(private readonly config: OneEuroConfig) {}

  reset() {
    this.previousTimestamp = null;
    this.previousRaw = null;
    this.previousFiltered = null;
    this.previousDerivative = 0;
  }

  filter(value: number, timestampMs: number): number {
    if (this.previousTimestamp === null || this.previousRaw === null || this.previousFiltered === null) {
      this.previousTimestamp = timestampMs;
      this.previousRaw = value;
      this.previousFiltered = value;
      return value;
    }

    const fallbackDt = 1 / this.config.frequency;
    const dt = Math.max(1 / 240, (timestampMs - this.previousTimestamp) / 1000 || fallbackDt);
    // MediaPipe coordinates are normalized. Scale their velocity to a roughly
    // 1000 px workspace so beta retains the usual One Euro Filter behavior.
    const derivative = (value - this.previousRaw) / dt * this.config.derivativeScale;
    const derivativeAlpha = this.alpha(this.config.dCutoff, dt);
    const filteredDerivative = derivativeAlpha * derivative + (1 - derivativeAlpha) * this.previousDerivative;
    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(filteredDerivative);
    const alpha = this.alpha(cutoff, dt);
    const filtered = alpha * value + (1 - alpha) * this.previousFiltered;

    this.previousTimestamp = timestampMs;
    this.previousRaw = value;
    this.previousDerivative = filteredDerivative;
    this.previousFiltered = filtered;
    return filtered;
  }

  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * Math.max(0.0001, cutoff));
    return 1 / (1 + tau / dt);
  }
}
