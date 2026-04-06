import {
  W, H, CAM_W, GAME_X, GAME_W,
  LANE_FLOOR_Y, PLATFORM_H, PLAYER_H, PLAYER_W,
  LANE_COLORS, SCROLL_SPEED_INIT, SCROLL_SPEED_MAX, SCROLL_ACCEL,
  GAP_MIN_W, GAP_MAX_W, SAFE_ZONE_MIN, SAFE_ZONE_MAX,
  INVINCIBLE_DUR, POSE_CONNECTIONS,
  LM_RIGHT_HIP, LM_RIGHT_KNEE, LM_RIGHT_ANKLE,
} from './constants';
import { Challenge } from './Challenge';
import { MeatItem } from './MeatItem';
import { PlayerState } from './PlayerState';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

type State = 'calib' | 'ready' | 'play' | 'over';

const SPR_NAMES = [
  'background', 'player', 'meat',
  'platform_green', 'platform_cyan', 'platform_red',
  'hole', 'heart', 'logo',
] as const;
type SprName = typeof SPR_NAMES[number];

const ASSET_FILES: Record<SprName, string> = {
  background:     '/img/bg-sky.png',
  player:         '/img/runningman-removebg-preview.png',
  meat:           '/img/Bone-removebg-preview.png',
  platform_green: '/img/StandingLane.png',
  platform_cyan:  '/img/halfSquatlane.png',
  platform_red:   '/img/full_squat_lane.png',
  hole:           '/img/dangerzone.png',
  heart:          '/img/heart-removebg-preview.png',
  logo:           '/img/GameTitle.png',
};

const SPR_SIZES: Record<SprName, [number, number]> = {
  background:     [GAME_W, H],
  player:         [PLAYER_W * 2, PLAYER_H * 2],
  meat:           [54, 54],
  platform_green: [96, 22],
  platform_cyan:  [96, 22],
  platform_red:   [96, 22],
  hole:           [96, 28],
  heart:          [28, 26],
  logo:           [480, 100],
};

export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private sprites: Partial<Record<SprName, HTMLImageElement>> = {};
  private audio: HTMLAudioElement | null = null;

  state: State = 'calib';
  numPlayers: number;
  private players: PlayerState[];
  private challenges: Challenge[] = [];
  private meats: MeatItem[] = [];
  private best = 0;

  private startT = 0;
  private prevT = 0;
  private scrollSpd = SCROLL_SPEED_INIT;
  private bobT = 0;
  private poseDetected = false;
  private _squatDown = false;   // 스쿼트 내려갔는지 추적

  // 키 입력
  private spacePressed = false;

  constructor(private canvas: HTMLCanvasElement, numPlayers = 1) {
    this.ctx = canvas.getContext('2d')!;
    this.numPlayers = numPlayers;
    this.players = Array.from({ length: numPlayers }, (_, i) => new PlayerState(i));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.spacePressed = true;
      }
    });
  }

  async loadAssets() {
    await Promise.all(
      SPR_NAMES.map(name => new Promise<void>(resolve => {
        const img = new Image();
        const [w, h] = SPR_SIZES[name];
        img.onload = () => {
          // offscreen canvas로 미리 원하는 크기로 렌더링
          const oc = document.createElement('canvas');
          oc.width = w; oc.height = h;
          oc.getContext('2d')!.drawImage(img, 0, 0, w, h);
          const resized = new Image();
          resized.src = oc.toDataURL();
          resized.onload = () => { this.sprites[name] = resized; resolve(); };
        };
        img.onerror = () => resolve();
        img.src = ASSET_FILES[name];
      }))
    );

    // 배경음악
    this.audio = new Audio('/sound/pixel_sprinter_loop.ogg');
    this.audio.loop = true;
    this.audio.volume = 0.55;
  }

  private playMusic() {
    this.audio?.play().catch(() => {});
  }
  private stopMusic() {
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
  }

  triggerStart() {
    if (this.state === 'ready' || this.state === 'over') this.reset();
  }

  reset() {
    this.challenges = [];
    this.meats = [];
    this.players.forEach(p => p.reset());
    this.startT = performance.now() / 1000;
    this.prevT  = this.startT;
    this.scrollSpd = SCROLL_SPEED_INIT;
    this.bobT = 0;
    this.state = 'play';
    this.playMusic();
  }

  // ── 외부에서 매 프레임 호출 ──────────────────────────────
  tick(allLandmarks: (NormalizedLandmark[] | null)[], video: HTMLVideoElement) {
    // 포즈 → 각 플레이어 감지기
    this.poseDetected = allLandmarks.some(lms => lms !== null);
    allLandmarks.forEach((lms, i) => {
      if (!lms || i >= this.players.length) return;
      const angle = kneeAngle(lms);
      if (angle !== null) this.players[i].detector.update(angle);
    });

    // Space 키 처리
    if (this.spacePressed) {
      this.spacePressed = false;
      if (this.state === 'ready' || this.state === 'over') this.reset();
    }

    this.update();
    this.draw(video, allLandmarks);
  }

  // ── 게임 로직 ────────────────────────────────────────────
  private update() {
    if (this.state === 'calib') {
      if (this.players.every(p => p.detector.calibrated)) this.state = 'ready';
      return;
    }

    // ready / over 상태: 스쿼트 한 번 하면 시작
    if (this.state === 'ready' || this.state === 'over') {
      for (const p of this.players) {
        if (!p.detector.calibrated) continue;
        const norm = p.detector.smoothNorm;
        if (norm < 0.45) this._squatDown = true;                   // 내려감
        if (this._squatDown && norm > 0.72) {                       // 다시 올라옴
          this._squatDown = false;
          this.reset();
          return;
        }
      }
      return;
    }

    if (this.state !== 'play') return;

    const now = performance.now() / 1000;
    const dt  = Math.min(now - this.prevT, 0.05);
    this.prevT = now;
    const elapsed = now - this.startT;

    this.scrollSpd = Math.min(SCROLL_SPEED_MAX, SCROLL_SPEED_INIT + elapsed * SCROLL_ACCEL);
    const dx = this.scrollSpd * dt;
    this.bobT += dt;

    this.challenges.forEach(c => c.scroll(dx));
    this.meats.forEach(m => m.scroll(dx));
    this.generate(Math.min(1, elapsed / 90));
    this.challenges = this.challenges.filter(c => !c.offScreen);
    this.meats      = this.meats.filter(m => !m.offScreen);

    for (const p of this.players) {
      if (!p.alive) continue;
      p.legPhase = (p.legPhase + dt * 9) % (Math.PI * 2);
      const lane = p.detector.lane;

      if (p.falling) {
        const fe = now - p.fallT;
        p.fallY = Math.min(fe * 500, 440);
        if (fe > 0.65) {
          p.lives--;
          p.hitT = now;
          p.falling = false;
          p.fallY = 0;
          p.invincibleUntil = now + INVINCIBLE_DUR;
          if (p.lives <= 0) p.alive = false;
        }
        continue;
      }

      if (now < p.invincibleUntil) {
        this.collectMeats(p, lane, now);
        p.score = elapsed * 10 + p.meatCount * 50;
        continue;
      }

      if (this.isDanger(lane, p.screenX)) {
        p.falling = true;
        p.fallT   = now;
        p.fallY   = 0;
        continue;
      }

      this.collectMeats(p, lane, now);
      p.score = elapsed * 10 + p.meatCount * 50;
    }

    if (this.players.every(p => !p.alive)) {
      this.best = Math.max(this.best, Math.max(...this.players.map(p => Math.floor(p.score))));
      this.state = 'over';
      this.stopMusic();
    }
  }

  private collectMeats(p: PlayerState, lane: number, now: number) {
    for (const m of this.meats) {
      if (!m.collected && m.lane === lane && Math.abs(m.x - p.screenX) < MeatItem.HIT_RADIUS) {
        m.collected = true;
        p.meatCount++;
        p.meatPopN = p.meatCount;
        p.meatPopT = now;
      }
    }
  }

  private isDanger(lane: number, px: number) {
    return this.challenges.some(c => c.blocks(lane, px));
  }

  private generate(difficulty: number) {
    const right = this.challenges.length
      ? Math.max(...this.challenges.map(c => c.xEnd))
      : GAME_W + 300;

    let r = right;
    while (r < GAME_W + 800) {
      const safeW = randInt(
        Math.max(300, SAFE_ZONE_MIN - difficulty * 100),
        Math.max(350, SAFE_ZONE_MAX - difficulty * 150),
      );
      for (let i = 0; i < randInt(2, 4); i++) {
        this.meats.push(new MeatItem(randInt(0, 2), r + Math.random() * (safeW - 80) + 40));
      }
      r += safeW;

      const gapW  = (GAP_MIN_W + Math.random() * (GAP_MAX_W - GAP_MIN_W)) * (1 + difficulty * 0.6) | 0;
      const cLane = randInt(0, 2);
      this.challenges.push(new Challenge(cLane, r, gapW));
      for (let sl = 0; sl < 3; sl++) {
        if (sl !== cLane && Math.random() < 0.55) {
          this.meats.push(new MeatItem(sl, r + gapW * (0.15 + Math.random() * 0.7)));
        }
      }
      r += gapW;
    }
  }

  // ── 렌더링 ────────────────────────────────────────────────
  private draw(video: HTMLVideoElement, allLms: (NormalizedLandmark[] | null)[]) {
    const { ctx } = this;
    ctx.clearRect(0, 0, W, H);

    this.drawCamera(video, allLms);
    ctx.strokeStyle = '#3c463c';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(CAM_W, 0); ctx.lineTo(CAM_W, H); ctx.stroke();

    this.drawGame();
  }

  private drawCamera(video: HTMLVideoElement, allLms: (NormalizedLandmark[] | null)[]) {
    const { ctx } = this;

    // 카메라 피드 (좌우 반전)
    ctx.save();
    ctx.translate(CAM_W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, CAM_W, H);
    ctx.restore();

    // 상단 어둠 오버레이
    ctx.fillStyle = 'rgba(20,22,30,0.82)';
    ctx.fillRect(0, 0, CAM_W, 50);
    ctx.fillStyle = '#50dc50';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('SQUAT RUNNER', 10, 34);

    // 포즈 스켈레톤
    const skelColors = ['#00aaff', '#ff8c00'];
    const dotColors  = ['#00e682', '#00dcff'];
    allLms.forEach((lms, pi) => {
      if (!lms) return;
      ctx.strokeStyle = skelColors[pi % 2];
      ctx.lineWidth = 2;
      for (const [a, b] of POSE_CONNECTIONS) {
        const la = lms[a], lb = lms[b];
        if (!la || !lb || la.visibility < 0.5 || lb.visibility < 0.5) continue;
        ctx.beginPath();
        ctx.moveTo((1 - la.x) * CAM_W, la.y * H);
        ctx.lineTo((1 - lb.x) * CAM_W, lb.y * H);
        ctx.stroke();
      }
      ctx.fillStyle = dotColors[pi % 2];
      for (const lm of lms) {
        if (lm.visibility < 0.5) continue;
        ctx.beginPath();
        ctx.arc((1 - lm.x) * CAM_W, lm.y * H, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    this.drawLaneIndicator();

    // 보정 진행바
    if (this.state === 'calib') {
      const prog = this.players.reduce((s, p) => s + p.detector.calibProgress, 0) / this.numPlayers;
      const bx = 20, bw = CAM_W - 40, by = H - 80, bh = 14;
      ctx.fillStyle = '#282a37';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#50d3eb';
      ctx.fillRect(bx, by, bw * prog, bh);
      ctx.fillStyle = '#96c8ff';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      const calibMsg = this.poseDetected
        ? 'Calibrating... try squatting'
        : 'Step back so your full body is visible';
      ctx.fillText(calibMsg, CAM_W / 2, H - 110);
      ctx.fillStyle = '#dcdcdc';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(`${Math.floor(prog * 100)}%`, CAM_W / 2, H - 55);
      ctx.textAlign = 'left';
    }
  }

  private drawLaneIndicator() {
    const { ctx } = this;
    const bx = CAM_W - 30;
    const segH = (H - 120) / 3;
    const indColors = ['#50dc50', '#32d2ff', '#ff8c32'];
    const ballColors = ['#e6e6e6', '#3cb4ff'];

    for (let i = 0; i < 3; i++) {
      const y0 = 60 + i * segH;
      const y1 = y0 + segH - 4;
      const active = this.players.some(p => p.detector.calibrated && p.detector.lane === i);
      ctx.globalAlpha = active ? 0.85 : 0.6;
      ctx.fillStyle = active ? indColors[i] : '#282a37';
      ctx.fillRect(bx, y0, 28, y1 - y0);
      if (active) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = indColors[i];
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, y0, 28, y1 - y0);
      }
    }
    ctx.globalAlpha = 1;

    const offsets = [7, 21];
    this.players.forEach((p, pi) => {
      if (!p.detector.calibrated) return;
      const hy = 60 + (1 - p.detector.smoothNorm) * (H - 180);
      ctx.fillStyle = ballColors[pi % 2];
      ctx.beginPath();
      ctx.arc(bx + offsets[pi % 2], hy, 8, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  private drawGame() {
    const { ctx } = this;
    ctx.save();
    ctx.translate(GAME_X, 0);

    // 배경
    const bg = this.sprites.background;
    if (bg) ctx.drawImage(bg, 0, 0, GAME_W, H);
    else { ctx.fillStyle = '#0a0c14'; ctx.fillRect(0, 0, GAME_W, H); }

    if (this.state === 'play' || this.state === 'over') {
      this.drawTracks();
      this.drawMeats();
      this.players.forEach(p => this.drawPlayer(p));
    }

    this.drawHUD();

    if (this.state === 'calib') {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(0, 0, GAME_W, H);
      ctx.fillStyle = '#50dc50';
      ctx.font = 'bold 46px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SQUAT RUNNER', GAME_W / 2, H / 2 - 50);
      ctx.fillStyle = '#b4d4b4';
      ctx.font = '26px sans-serif';
      ctx.fillText('Calibrating...', GAME_W / 2, H / 2 + 14);
      ctx.textAlign = 'left';
    } else if (this.state === 'ready') {
      this.drawReady();
    } else if (this.state === 'over') {
      this.drawGameOver();
    }

    // 충돌 플래시
    const now = performance.now() / 1000;
    if (this.players.some(p => now - p.hitT < 0.3)) {
      ctx.fillStyle = 'rgba(160,0,0,0.35)';
      ctx.fillRect(0, 0, GAME_W, H);
    }

    ctx.restore();
  }

  private drawTracks() {
    const { ctx } = this;
    const now = performance.now() / 1000;

    const dangerLanes = new Set<number>();
    for (const p of this.players) {
      if (p.alive && !p.falling && now >= p.invincibleUntil && this.isDanger(p.detector.lane, p.screenX)) {
        dangerLanes.add(p.detector.lane);
      }
    }

    const sprNames: SprName[] = ['platform_green', 'platform_cyan', 'platform_red'];

    for (let lane = 0; lane < 3; lane++) {
      const fy  = LANE_FLOOR_Y[lane];
      const col = LANE_COLORS[lane];

      // 배경 밴드
      ctx.fillStyle = col + '26'; // 15% 투명
      ctx.fillRect(0, fy - PLAYER_H - 50, GAME_W, PLAYER_H + 50 + PLATFORM_H + 12);

      // 플랫폼 타일
      const plSpr = this.sprites[sprNames[lane]];
      if (plSpr) {
        const tw = SPR_SIZES[sprNames[lane]][0];
        for (let x = 0; x < GAME_W; x += tw) {
          ctx.drawImage(plSpr, x, fy, tw, SPR_SIZES[sprNames[lane]][1]);
        }
      } else {
        ctx.fillStyle = col;
        ctx.fillRect(0, fy, GAME_W, PLATFORM_H);
      }

      // 챌린지 구멍
      for (const ch of this.challenges) {
        if (ch.lane !== lane) continue;
        const x0 = Math.max(0, ch.x | 0);
        const x1 = Math.min(GAME_W, ch.xEnd | 0);
        if (x0 >= x1) continue;

        ctx.fillStyle = '#030306';
        ctx.fillRect(x0, fy - 3, x1 - x0, PLATFORM_H + 9);

        const holeSpr = this.sprites.hole;
        if (holeSpr) {
          const hw = SPR_SIZES.hole[0];
          for (let x = x0; x < x1; x += hw) ctx.drawImage(holeSpr, x, fy - 3, hw, SPR_SIZES.hole[1]);
        } else {
          ctx.strokeStyle = '#142832';
          for (let x = x0; x < x1; x += 18) {
            ctx.beginPath(); ctx.moveTo(x, fy - 2); ctx.lineTo(Math.min(x + 12, x1), fy + PLATFORM_H + 4); ctx.stroke();
          }
        }
        ctx.strokeStyle = '#322850';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, fy - 3, x1 - x0, PLATFORM_H + 8);
      }

      // 위험 경고 테두리 (깜빡임)
      if (dangerLanes.has(lane) && Math.sin(now * 12) > 0) {
        ctx.strokeStyle = '#dc0000';
        ctx.lineWidth = 3;
        ctx.strokeRect(0, fy - 5, GAME_W, PLATFORM_H + 12);
      }

      // 레인 레이블
      const labels = ['Standing', 'Half squat', 'Full squat'];
      ctx.fillStyle = col + '55';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(labels[lane], GAME_W - 8, fy + PLATFORM_H + 16);
      ctx.textAlign = 'left';
    }
  }

  private drawMeats() {
    const { ctx } = this;
    const t = this.bobT;
    for (const m of this.meats) {
      if (m.collected) continue;
      const cx = m.x | 0;
      const cy = m.screenCY(t) | 0;
      const spr = this.sprites.meat;
      if (spr) {
        const [sw, sh] = SPR_SIZES.meat;
        ctx.drawImage(spr, cx - sw / 2, cy - sh / 2, sw, sh);
      } else {
        ctx.strokeStyle = '#d7dbe1';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx - 22, cy); ctx.lineTo(cx + 22, cy); ctx.stroke();
        ctx.fillStyle = '#dddfe8';
        for (const ex of [cx - 22, cx + 22]) {
          ctx.beginPath(); ctx.arc(ex, cy, 9, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#2837d7';
        ctx.beginPath(); ctx.ellipse(cx, cy, 15, 9, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  private drawPlayer(p: PlayerState) {
    const { ctx } = this;
    const now = performance.now() / 1000;
    if (!p.alive) return;

    if (now < p.invincibleUntil && Math.sin(now * 16) < 0) return;

    const lane = p.detector.lane;
    const cx   = p.screenX;
    const fy   = LANE_FLOOR_Y[lane];
    const foot = fy - 2 + p.fallY;
    const ph   = SPR_SIZES.player[1];
    const pw   = SPR_SIZES.player[0];

    // 그림자
    ctx.fillStyle = 'rgba(5,5,18,0.5)';
    ctx.beginPath();
    ctx.ellipse(cx, fy + 3, 22, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    const spr = this.sprites.player;
    if (spr) {
      if (p.idx === 1) {
        // P2 파란 색조 (globalCompositeOperation으로 틴팅)
        ctx.save();
        ctx.drawImage(spr, cx - pw / 2, foot - ph, pw, ph);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = '#3cb4ff';
        ctx.fillRect(cx - pw / 2, foot - ph, pw, ph);
        ctx.restore();
      } else {
        ctx.drawImage(spr, cx - pw / 2, foot - ph, pw, ph);
      }
    } else {
      // 폴백: 스틱 캐릭터
      const head = foot - PLAYER_H;
      const swing = Math.sin(p.legPhase) * 10;
      ctx.fillStyle = p.color;
      ctx.fillRect(cx - 12, head + 20, 24, foot - 14 - (head + 20));
      ctx.beginPath(); ctx.arc(cx, head + 13, 13, 0, Math.PI * 2);
      ctx.fillStyle = '#78b9e4'; ctx.fill();
      ctx.strokeStyle = p.color; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(cx - 5, foot - 14); ctx.lineTo(cx - 11 + swing, foot); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 5, foot - 14); ctx.lineTo(cx + 11 - swing, foot); ctx.stroke();
    }

    // 2P 레이블
    if (this.numPlayers > 1) {
      ctx.fillStyle = p.color;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`P${p.idx + 1}`, cx, foot + 18);
      ctx.textAlign = 'left';
    }

    // 낙하 오버레이
    if (p.falling) {
      ctx.fillStyle = 'rgba(200,0,0,0.28)';
      ctx.beginPath();
      ctx.arc(cx, foot - PLAYER_H / 2, 38, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawHUD() {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(18,20,28,0.85)';
    ctx.fillRect(0, 0, GAME_W, 58);

    const heartSpr = this.sprites.heart;
    const drawHearts = (startX: number, lives: number) => {
      for (let i = 0; i < 3; i++) {
        const hx = startX + i * 30;
        if (heartSpr) {
          const [hw, hh] = SPR_SIZES.heart;
          if (i < lives) {
            ctx.drawImage(heartSpr, hx - hw / 2, 16, hw, hh);
          } else {
            ctx.globalAlpha = 0.25;
            ctx.drawImage(heartSpr, hx - hw / 2, 16, hw, hh);
            ctx.globalAlpha = 1;
          }
        } else {
          ctx.fillStyle = i < lives ? '#dc3cdc' : '#333';
          ctx.font = '24px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('♥', hx, 38);
          ctx.textAlign = 'left';
        }
      }
    };

    if (this.numPlayers === 1) {
      const p = this.players[0];
      ctx.fillStyle = '#50dc50';
      ctx.font = 'bold 26px monospace';
      ctx.fillText(`SCORE  ${String(Math.floor(p.score)).padStart(6, '0')}`, 14, 40);
      if (this.state === 'play') {
        const spd = Math.floor(this.scrollSpd / SCROLL_SPEED_INIT * 100);
        ctx.fillStyle = '#c8c864';
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`SPD ${spd}%`, GAME_W / 2, 38);
        ctx.textAlign = 'left';
      }
      drawHearts(GAME_W - 22 - 2 * 30, p.lives);
      ctx.fillStyle = '#3c8cff';
      ctx.font = '20px sans-serif';
      ctx.fillText(`Meat x${p.meatCount}`, GAME_W / 2 + 110, 38);
    } else {
      const [p1, p2] = this.players;
      ctx.fillStyle = p1.color;
      ctx.font = 'bold 20px monospace';
      ctx.fillText(`P1 ${String(Math.floor(p1.score)).padStart(5, '0')}`, 10, 22);
      drawHearts(14, p1.lives);
      ctx.fillStyle = p2.color;
      ctx.textAlign = 'right';
      ctx.fillText(`P2 ${String(Math.floor(p2.score)).padStart(5, '0')}`, GAME_W - 10, 22);
      ctx.textAlign = 'left';
      drawHearts(GAME_W - 14 - 2 * 30, p2.lives);
      if (this.state === 'play') {
        const spd = Math.floor(this.scrollSpd / SCROLL_SPEED_INIT * 100);
        ctx.fillStyle = '#c8c864';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`SPD ${spd}%`, GAME_W / 2, 38);
        ctx.textAlign = 'left';
      }
    }

    // 무적 / 고기 팝업
    const now = performance.now() / 1000;
    this.players.forEach((p, pi) => {
      if (now < p.invincibleUntil) {
        const rem = (p.invincibleUntil - now).toFixed(1);
        const label = this.numPlayers > 1 ? `P${pi + 1} Invincible` : 'Invincible';
        ctx.fillStyle = '#50ffc8';
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${label} ${rem}s`, GAME_W / 2, H - 40 - pi * 28);
        ctx.textAlign = 'left';
      }
      if (now - p.meatPopT < 1.2) {
        const a = Math.max(0, 1 - (now - p.meatPopT) / 1.2);
        ctx.fillStyle = `rgba(60,160,255,${a})`;
        ctx.font = 'bold 34px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`+50pts! (x${p.meatPopN})`, GAME_W / 2, H / 2 - 60 - pi * 42);
        ctx.textAlign = 'left';
      }
    });
  }

  private drawReady() {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, GAME_W, H);

    const logo = this.sprites.logo;
    if (logo) {
      const [lw, lh] = SPR_SIZES.logo;
      ctx.drawImage(logo, GAME_W / 2 - lw / 2, H / 2 - 170, lw, lh);
    } else {
      ctx.fillStyle = '#50dc50';
      ctx.font = 'bold 52px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Ready!', GAME_W / 2, H / 2 - 100);
    }

    ctx.textAlign = 'center';
    const lines = [
      [22, '#a0c8a0', 'Squat to switch tracks and collect meat!'],
      [20, '#b49664', 'Dark gaps will make you fall — avoid them!'],
      [18, '#64c8c8', '2 sec invincibility after each fall'],
    ] as const;
    lines.forEach(([size, color, text], i) => {
      ctx.fillStyle = color;
      ctx.font = `${size}px sans-serif`;
      ctx.fillText(text, GAME_W / 2, H / 2 - 34 + i * 34);
    });

    if (this.numPlayers > 1) {
      ctx.fillStyle = '#ffc83c';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(`★ ${this.numPlayers} Players ★`, GAME_W / 2, H / 2 + 68);
    }

    ctx.fillStyle = '#c8c8c8';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('Do one squat to start  /  [ Space ]', GAME_W / 2, H / 2 + 100);

    if (this.best > 0) {
      ctx.fillStyle = '#b4b464';
      ctx.font = '22px sans-serif';
      ctx.fillText(`Best: ${this.best} pts`, GAME_W / 2, H / 2 + 148);
    }
    ctx.textAlign = 'left';
  }

  private drawGameOver() {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, GAME_W, H);
    ctx.textAlign = 'center';

    ctx.fillStyle = '#3c3ce1';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText('GAME OVER', GAME_W / 2, H / 2 - 110);

    if (this.numPlayers === 1) {
      const p = this.players[0];
      ctx.fillStyle = '#dcdcdc';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText(`Score: ${Math.floor(p.score)}`, GAME_W / 2, H / 2 - 28);
      ctx.fillStyle = '#3c8cff';
      ctx.font = '28px sans-serif';
      ctx.fillText(`Meat: x${p.meatCount}`, GAME_W / 2, H / 2 + 30);
    } else {
      this.players.forEach((p, i) => {
        ctx.fillStyle = p.color;
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText(`P${i + 1}  Score: ${Math.floor(p.score)}   Meat: x${p.meatCount}`, GAME_W / 2, H / 2 - 28 + i * 44);
      });
    }

    ctx.fillStyle = '#b4b464';
    ctx.font = '24px sans-serif';
    ctx.fillText(`Best: ${this.best} pts`, GAME_W / 2, H / 2 + 80);
    ctx.fillStyle = '#a0a0a0';
    ctx.font = '24px sans-serif';
    ctx.fillText('Do one squat to play again  /  [ Space ]', GAME_W / 2, H / 2 + 118);
    ctx.textAlign = 'left';
  }
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function kneeAngle(lms: NormalizedLandmark[]): number | null {
  const hip   = lms[LM_RIGHT_HIP];
  const knee  = lms[LM_RIGHT_KNEE];
  const ankle = lms[LM_RIGHT_ANKLE];
  if (!hip || !knee || !ankle) return null;
  if (hip.visibility < 0.5 || knee.visibility < 0.5 || ankle.visibility < 0.5) return null;
  const ax = hip.x - knee.x,   ay = hip.y - knee.y;
  const bx = ankle.x - knee.x, by = ankle.y - knee.y;
  const dot = ax * bx + ay * by;
  const mag = Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by);
  if (mag < 1e-9) return null;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
}
