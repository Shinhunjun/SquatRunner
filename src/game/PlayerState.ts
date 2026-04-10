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

  /** 풀 rep = 1.0, 반 rep = 0.5 로 누적 */
  squatCount = 0;
  calories = 0;
  /** 이번 rep 내에서 lane 2(풀스쿼트)까지 내려갔는지 */
  squatDescended = false;
  /** 이번 rep를 0.5로 이미 가산했는지 (lane 0 도달 시 추가 0.5로 1.0 완성 가능) */
  squatHalfCredited = false;

  /** 보너스 생명 진행도 (고기 30개 시 +1 life) */
  meatLifeProgress = 0;
  /** "Life added!" 토스트 표시 타임스탬프 (초) */
  lifeAddedT = 0;

  /** 원격 플레이어 표시 이름 (undefined이면 로컬 플레이어) */
  remoteName?: string;

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
    this.squatCount = 0;
    this.calories = 0;
    this.squatDescended = false;
    this.squatHalfCredited = false;
    this.meatLifeProgress = 0;
    this.lifeAddedT = 0;
  }
}
