import { LANE_FLOOR_Y, PLAYER_H } from './constants';

export const JUNK_TYPES = ['burger', 'chicken', 'donut', 'fries', 'soda'] as const;
export type JunkType = typeof JUNK_TYPES[number];

export const JUNK_SIZE = 56;
export const JUNK_HIT_RADIUS = 32;

export class JunkFood {
  x: number;
  y: number;
  vx: number;          // px/s, 음수 = 왼쪽
  type: JunkType;
  lane: number;
  hit = false;          // 플레이어 충돌 처리됨
  scored = false;       // 보스에게 데미지 줬음(회피 성공)
  rotation = 0;
  rotSpeed: number;

  constructor(lane: number, startX: number, speed: number) {
    this.lane = lane;
    this.x = startX;
    // 레인 위 머리 높이 정도에서 출발
    this.y = LANE_FLOOR_Y[lane] - PLAYER_H + 10;
    this.vx = -speed;
    this.type = JUNK_TYPES[Math.floor(Math.random() * JUNK_TYPES.length)];
    this.rotSpeed = (Math.random() - 0.5) * 6;
  }

  update(dt: number) {
    this.x += this.vx * dt;
    this.rotation += this.rotSpeed * dt;
  }

  get offScreen() {
    return this.x < -80;
  }
}
