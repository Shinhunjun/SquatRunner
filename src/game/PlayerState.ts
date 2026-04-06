import { SquatDetector } from './SquatDetector';
import { PLAYER_SCREEN_X } from './constants';

export const PLAYER_COLORS = ['#32d250', '#3cb4ff'] as const; // P1 초록, P2 파랑

export class PlayerState {
  detector = new SquatDetector();
  screenX: number;
  color: string;

  lives = 3;
  score = 0;
  meatCount = 0;

  falling = false;
  fallT = 0;
  fallY = 0;
  invincibleUntil = 0;
  hitT = 0;

  meatPopT = 0;
  meatPopN = 0;

  legPhase = 0;
  alive = true;

  constructor(public idx: number) {
    this.screenX = PLAYER_SCREEN_X[idx] ?? 130;
    this.color   = PLAYER_COLORS[idx] ?? '#ffffff';
  }

  reset() {
    this.lives = 3;
    this.score = 0;
    this.meatCount = 0;
    this.falling = false;
    this.fallY = 0;
    this.invincibleUntil = 0;
    this.legPhase = 0;
    this.alive = true;
  }
}
