import { EMA_ALPHA, CALIB_FRAMES, LANE_THRESHOLDS } from './constants';

export class SquatDetector {
  private _ema: number | null = null;
  private _obsMin = Infinity;
  private _obsMax = -Infinity;
  private _frames = 0;

  calibrated = false;
  lane: 0 | 1 | 2 = 0;
  smoothNorm = 1.0;

  update(rawAngle: number) {
    this._ema = this._ema === null
      ? rawAngle
      : EMA_ALPHA * rawAngle + (1 - EMA_ALPHA) * this._ema;

    this._obsMin = Math.min(this._obsMin, this._ema);
    this._obsMax = Math.max(this._obsMax, this._ema);
    this._frames++;

    const range = this._obsMax - this._obsMin;
    if (range >= 20 && this._frames >= CALIB_FRAMES) this.calibrated = true;
    if (!this.calibrated) return;

    const norm = Math.max(0, Math.min(1,
      (this._ema - this._obsMin) / Math.max(range, 1)
    ));
    this.smoothNorm = 0.12 * norm + 0.88 * this.smoothNorm;

    const [lo, hi] = LANE_THRESHOLDS;
    this.lane = norm < lo ? 2 : norm < hi ? 1 : 0;
  }

  get calibProgress() {
    return Math.min(1, this._frames / CALIB_FRAMES);
  }
}
