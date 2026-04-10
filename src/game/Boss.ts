import { GAME_W, H } from './constants';

export const BOSS_W = 260;
export const BOSS_H = 320;

export class Boss {
  maxHp: number;
  hp: number;
  x: number;
  y: number;
  scale = 1;
  alive = true;
  defeatedT = 0;
  /** boss_fatty_1 / boss_fatty_2 / boss_fatty_3 */
  spriteKey: 'boss_fatty_1' | 'boss_fatty_2' | 'boss_fatty_3';

  constructor(level: number, hp: number) {
    this.maxHp = hp;
    this.hp = hp;
    this.spriteKey =
      level <= 1 ? 'boss_fatty_1' :
      level <= 3 ? 'boss_fatty_2' : 'boss_fatty_3';
    // 게임 영역 오른쪽 끝, 세로 중앙 flush
    this.x = GAME_W - BOSS_W;
    this.y = (H - BOSS_H) / 2;
  }

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) this.alive = false;
  }

  /** 보스 던지는 시작 위치 (x, y) - 보스 왼쪽 가슴 근처 */
  throwOrigin(): [number, number] {
    return [this.x + 20, this.y + BOSS_H * 0.4];
  }
}
