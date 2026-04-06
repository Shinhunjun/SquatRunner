import { LANE_FLOOR_Y, PLAYER_H } from './constants';

export class MeatItem {
  static HIT_RADIUS = 36;
  collected = false;
  private _phase = Math.random() * Math.PI * 2;

  constructor(public lane: number, public x: number) {}

  scroll(dx: number) { this.x -= dx; }

  get offScreen() { return this.x < -60; }

  screenCY(t: number) {
    return LANE_FLOOR_Y[this.lane] - PLAYER_H - 18 + Math.sin(t * 3.5 + this._phase) * 5;
  }
}
