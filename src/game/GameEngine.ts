import {
  W, H, CAM_W, GAME_X, GAME_W,
  LANE_FLOOR_Y, PLATFORM_H, PLAYER_H, PLAYER_W,
  LANE_COLORS, SCROLL_SPEED_INIT, SCROLL_SPEED_MAX, SCROLL_ACCEL,
  GAP_MIN_W, GAP_MAX_W, SAFE_ZONE_MIN, SAFE_ZONE_MAX,
  INVINCIBLE_DUR, MAX_LIVES, MEAT_PER_LIFE, POSE_CONNECTIONS,
  LM_RIGHT_HIP, LM_RIGHT_KNEE, LM_RIGHT_ANKLE,
} from './constants';
import { Challenge } from './Challenge';
import { MeatItem } from './MeatItem';
import { PlayerState } from './PlayerState';
import { Boss, BOSS_W, BOSS_H } from './Boss';
import { JunkFood, JUNK_SIZE, JUNK_HIT_RADIUS } from './JunkFood';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

type State = 'calib' | 'ready' | 'play' | 'over';

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEventLike) => void;
  onerror: () => void;
  onend: () => void;
  start: () => void;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
}

const SPR_NAMES = [
  'background', 'player', 'meat',
  'platform_green', 'platform_cyan', 'platform_red',
  'hole', 'heart', 'logo',
  'boss_fatty_1', 'boss_fatty_2', 'boss_fatty_3',
  'junk_burger', 'junk_chicken', 'junk_donut', 'junk_fries', 'junk_soda',
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
  boss_fatty_1:   '/img/boss_fatty_1.png',
  boss_fatty_2:   '/img/boss_fatty_2.png',
  boss_fatty_3:   '/img/boss_fatty_3.png',
  junk_burger:    '/img/junk_burger.png',
  junk_chicken:   '/img/junk_chicken.png',
  junk_donut:     '/img/junk_donut.png',
  junk_fries:     '/img/junk_fries.png',
  junk_soda:      '/img/junk_soda.png',
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
  boss_fatty_1:   [BOSS_W, BOSS_H],
  boss_fatty_2:   [BOSS_W, BOSS_H],
  boss_fatty_3:   [BOSS_W, BOSS_H],
  junk_burger:    [JUNK_SIZE, JUNK_SIZE],
  junk_chicken:   [JUNK_SIZE, JUNK_SIZE],
  junk_donut:     [JUNK_SIZE, JUNK_SIZE],
  junk_fries:     [JUNK_SIZE, JUNK_SIZE],
  junk_soda:      [JUNK_SIZE, JUNK_SIZE],
};

/** 레벨별 보스/정크푸드 난이도 */
function getLevelConfig(level: number) {
  return {
    /** 보스까지 달려가야 하는 거리 (px) */
    bossDistance: 7000 + (level - 1) * 2500,
    bossHP: 100 + (level - 1) * 50,
    junkFoodInterval: Math.max(0.4, 0.9 - (level - 1) * 0.08),
    junkFoodSpeed: 280 + (level - 1) * 25,
    /** 회피 한 번에 보스가 받는 데미지 */
    damagePerDodge: Math.max(8, 25 - (level - 1) * 2),
  };
}

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

  // 레벨 / 보스 시스템
  private level = 1;
  private phase: 'running' | 'boss' | 'victory' = 'running';
  private levelDistance = 0;
  private boss: Boss | null = null;
  private junkFoods: JunkFood[] = [];
  private nextJunkAt = 0;
  private victoryT = 0;
  private bossEntryT = 0;
  private junkLaneQueue: number[] = [];
  private audioUnlocked = false;

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

    this.startVoiceRecognition();
    this.setupAudioUnlock();
  }

  /** 브라우저 autoplay 정책 우회: 첫 사용자 제스처 시 오디오 해제 */
  private setupAudioUnlock() {
    const unlock = () => {
      if (this.audioUnlocked) return;
      if (!this.audio) return;
      this.audio.play().then(() => {
        this.audio!.pause();
        this.audio!.currentTime = 0;
        this.audioUnlocked = true;
        // 게임이 이미 진행 중이면 바로 재생
        if (this.state === 'play') this.playMusic();
      }).catch(() => {});
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'click'] as const;
    const handler = () => {
      unlock();
      events.forEach(ev => window.removeEventListener(ev, handler));
    };
    events.forEach(ev => window.addEventListener(ev, handler, { once: false }));
  }

  private startVoiceRecognition() {
    const SR = (window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).SpeechRecognition ?? (window as unknown as {
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).webkitSpeechRecognition;
    if (!SR) return;
    try {
      const recognition = new SR();
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript.toLowerCase() + ' ';
        }
        if (transcript.includes('start')) {
          this.triggerStart();
        }
      };
      recognition.onerror = () => {};
      recognition.onend = () => {
        try { recognition.start(); } catch {}
      };
      recognition.start();
    } catch {}
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
    this.audio?.play().then(() => { this.audioUnlocked = true; }).catch(() => {});
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
    this.junkFoods = [];
    this.boss = null;
    this.players.forEach(p => p.reset());
    this.startT = performance.now() / 1000;
    this.prevT  = this.startT;
    this.scrollSpd = SCROLL_SPEED_INIT;
    this.bobT = 0;
    this.level = 1;
    this.phase = 'running';
    this.levelDistance = 0;
    this.victoryT = 0;
    this.bossEntryT = 0;
    this.nextJunkAt = 0;
    this.junkLaneQueue = [];
    this.state = 'play';
    this.playMusic();
  }

  private startNextLevel() {
    this.level++;
    this.phase = 'running';
    this.levelDistance = 0;
    this.boss = null;
    this.junkFoods = [];
    this.victoryT = 0;
    this.bossEntryT = 0;
    this.scrollSpd = SCROLL_SPEED_INIT + (this.level - 1) * 20;
    this.challenges = [];
    this.meats = [];
  }

  private spawnBoss() {
    const cfg = getLevelConfig(this.level);
    this.boss = new Boss(this.level, cfg.bossHP);
    this.phase = 'boss';
    this.bossEntryT = performance.now() / 1000;
    this.nextJunkAt = this.bossEntryT + 1.5;  // 등장 후 1.5초 뒤 첫 발
    this.challenges = [];
    this.junkFoods = [];
    this.junkLaneQueue = [];
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
    this.bobT += dt;

    // ── Phase: Victory (보스 쓰러진 후 2.5초 → 다음 레벨) ──
    if (this.phase === 'victory') {
      if (now - this.victoryT > 2.5) this.startNextLevel();
      // 무적 / 죽음 처리만 계속 돌도록 짧게 리턴
      this.tickPlayersLight();
      return;
    }

    // ── Phase: Boss (스크롤 정지, 정크푸드 회피) ──
    if (this.phase === 'boss') {
      this.updateBossPhase(now, dt);
      return;
    }

    // ── Phase: Running (기존 로직) ──
    const baseSpd = SCROLL_SPEED_INIT + (this.level - 1) * 20;
    this.scrollSpd = Math.min(SCROLL_SPEED_MAX, baseSpd + elapsed * SCROLL_ACCEL);
    const dx = this.scrollSpd * dt;
    this.levelDistance += dx;

    this.challenges.forEach(c => c.scroll(dx));
    this.meats.forEach(m => m.scroll(dx));

    // 보스 거리 도달 전까지만 새 챌린지 생성
    const cfg = getLevelConfig(this.level);
    const remaining = cfg.bossDistance - this.levelDistance;
    if (remaining > 600) {
      this.generate(Math.min(1, elapsed / 90));
    }
    this.challenges = this.challenges.filter(c => !c.offScreen);
    this.meats      = this.meats.filter(m => !m.offScreen);

    // 보스 등장 트리거: 거리 도달 + 화면에 남은 장애물 없음
    if (this.levelDistance >= cfg.bossDistance && this.challenges.length === 0) {
      this.spawnBoss();
      return;
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      p.legPhase = (p.legPhase + dt * 9) % (Math.PI * 2);
      const lane = p.detector.lane;

      this.updateSquatCount(p, lane);

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

  private updateBossPhase(now: number, dt: number) {
    if (!this.boss) return;
    const cfg = getLevelConfig(this.level);

    // 정크푸드 스폰: 3레인 셔플 큐로 골고루 분배
    if (this.boss.alive && now >= this.nextJunkAt) {
      if (this.junkLaneQueue.length === 0) {
        const q = [0, 1, 2];
        // Fisher-Yates
        for (let i = q.length - 1; i > 0; i--) {
          const k = Math.floor(Math.random() * (i + 1));
          [q[i], q[k]] = [q[k], q[i]];
        }
        this.junkLaneQueue = q;
      }
      const lane = this.junkLaneQueue.shift()!;
      const [bx] = this.boss.throwOrigin();
      const jf = new JunkFood(lane, bx, cfg.junkFoodSpeed);
      this.junkFoods.push(jf);
      this.nextJunkAt = now + cfg.junkFoodInterval;
    }

    // 정크푸드 업데이트
    this.junkFoods.forEach(j => j.update(dt));

    // 충돌 / 회피 처리
    for (const j of this.junkFoods) {
      if (j.hit || j.scored) continue;
      for (const p of this.players) {
        if (!p.alive) continue;
        const dx = j.x - p.screenX;
        const sameLane = p.detector.lane === j.lane;
        // 플레이어 근접 시
        if (Math.abs(dx) < JUNK_HIT_RADIUS) {
          if (sameLane && now >= p.invincibleUntil && !p.falling) {
            // 충돌 → 데미지
            j.hit = true;
            p.lives--;
            p.hitT = now;
            p.invincibleUntil = now + INVINCIBLE_DUR;
            if (p.lives <= 0) p.alive = false;
          }
        }
      }
      // 플레이어 X를 지나치면 회피 성공 → 보스 데미지
      if (!j.hit && j.x < this.players[0].screenX - JUNK_HIT_RADIUS - 10) {
        j.scored = true;
        this.boss.takeDamage(cfg.damagePerDodge);
      }
    }
    this.junkFoods = this.junkFoods.filter(j => !j.offScreen && !j.hit);

    // 플레이어 다리 애니메이션 / 죽음 처리
    this.tickPlayersLight();

    // 보스 처치 → victory
    if (!this.boss.alive) {
      this.phase = 'victory';
      this.victoryT = now;
    }

    // 게임 오버 체크
    if (this.players.every(p => !p.alive)) {
      this.best = Math.max(this.best, Math.max(...this.players.map(p => Math.floor(p.score))));
      this.state = 'over';
      this.stopMusic();
    }
  }

  /** 무적 / 다리 phase / 점수만 가볍게 업데이트 */
  private tickPlayersLight() {
    for (const p of this.players) {
      if (!p.alive) continue;
      p.legPhase = (p.legPhase + 0.016 * 9) % (Math.PI * 2);
      this.updateSquatCount(p, p.detector.lane);
    }
  }

  /**
   * 스쿼트 rep 카운터 (반쪽 rep 지원 상태 머신).
   *
   * - 풀 rep (1.0): lane 2 도달 후 lane 0까지 복귀
   * - 반 rep (0.5): lane 2 도달 후 lane 1 까지만 복귀 (아직 lane 0 안 찍음)
   *   → 이후 lane 0 도달 시 추가 0.5 가산되어 누적 1.0 (풀 rep)
   *   → 이후 lane 2로 다시 내려가면 0.5는 확정, 새 rep 시작
   *
   * 예시:
   *   0→2→0         = 1.0
   *   1→2→1         = 0.5
   *   1→2→1→2→1     = 1.0 (half × 2)
   *   0→2→1→2→0     = 1.5 (half + full)
   */
  private updateSquatCount(p: PlayerState, lane: number) {
    if (!p.detector.calibrated) return;

    if (lane === 2) {
      // 바닥 도달: 이전 rep가 0.5만 가산된 상태였다면 거기서 확정, 새 rep 시작
      if (p.squatHalfCredited) p.squatHalfCredited = false;
      p.squatDescended = true;
      return;
    }

    if (!p.squatDescended) return;

    if (lane === 0) {
      // 완전히 섰다
      if (p.squatHalfCredited) {
        // 이미 0.5 가산됨 → 추가 0.5로 풀 rep 완성
        p.squatCount += 0.5;
      } else {
        // 바닥 → 곧바로 정상 = 풀 rep
        p.squatCount += 1;
      }
      p.calories = p.squatCount * 0.32;
      p.squatDescended = false;
      p.squatHalfCredited = false;
    } else if (lane === 1 && !p.squatHalfCredited) {
      // 바닥 → 중간 복귀: 일단 0.5 가산 (이후 lane 0 가면 추가 0.5, lane 2 가면 0.5 확정)
      p.squatCount += 0.5;
      p.calories = p.squatCount * 0.32;
      p.squatHalfCredited = true;
    }
  }

  private collectMeats(p: PlayerState, lane: number, now: number) {
    for (const m of this.meats) {
      if (!m.collected && m.lane === lane && Math.abs(m.x - p.screenX) < MeatItem.HIT_RADIUS) {
        m.collected = true;
        p.meatCount++;
        p.meatPopN = p.meatCount;
        p.meatPopT = now;

        // MEAT_PER_LIFE마다 목숨 +1 (최대 MAX_LIVES)
        p.meatLifeProgress++;
        if (p.meatLifeProgress >= MEAT_PER_LIFE) {
          p.meatLifeProgress = 0;
          if (p.lives < MAX_LIVES) {
            p.lives++;
            p.lifeAddedT = now;
          }
        }
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

    if (this.state === 'play') {
      this.drawTracks();
      this.drawMeats();
      if (this.boss) this.drawBoss();
      if (this.junkFoods.length) this.drawJunkFoods();
      this.players.forEach(p => this.drawPlayer(p));
      if (this.phase === 'running') this.drawFinishProgress();
      if (this.phase === 'victory') this.drawVictory();
    }

    this.drawHUD();
    this.drawLifeAddedToast();

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

  private drawBoss() {
    if (!this.boss) return;
    const { ctx } = this;
    const now = performance.now() / 1000;
    const sprKey = this.boss.spriteKey;
    const spr = this.sprites[sprKey];

    // 등장 슬라이드인 (0~0.6초) - 게임 영역 우측 밖에서 targetX로 슬라이드
    const since = now - this.bossEntryT;
    const slideT = Math.min(1, since / 0.6);
    const targetX = this.boss.x;
    // 게임 영역 우측 바깥(GAME_W)에서 시작해서 targetX로
    const startX = GAME_W + 20;
    const drawX = targetX + (1 - slideT) * (startX - targetX);

    // 데미지 받았을 때 살짝 흔들림
    const shake = this.boss.alive ? 0 : Math.sin(now * 30) * 6;

    if (spr) {
      ctx.save();
      ctx.translate(drawX + shake, this.boss.y);
      ctx.drawImage(spr, 0, 0, BOSS_W, BOSS_H);
      ctx.restore();
    } else {
      ctx.fillStyle = '#a02828';
      ctx.fillRect(drawX, this.boss.y, BOSS_W, BOSS_H);
    }

    // 보스 HP 바
    const barW = 220, barH = 16;
    const barX = this.boss.x + (BOSS_W - barW) / 2;
    const barY = this.boss.y - 28;
    ctx.fillStyle = '#1a1a22';
    ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
    ctx.fillStyle = '#3c1010';
    ctx.fillRect(barX, barY, barW, barH);
    const hpRatio = this.boss.hp / this.boss.maxHp;
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#ff4040');
    grad.addColorStop(1, '#ffb040');
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW * hpRatio, barH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`FATTY  ${Math.ceil(this.boss.hp)} / ${this.boss.maxHp}`, barX + barW / 2, barY + 13);
    ctx.textAlign = 'left';
  }

  private drawJunkFoods() {
    const { ctx } = this;
    for (const j of this.junkFoods) {
      const sprKey = ('junk_' + j.type) as SprName;
      const spr = this.sprites[sprKey];
      ctx.save();
      ctx.translate(j.x, j.y);
      ctx.rotate(j.rotation);
      if (spr) {
        ctx.drawImage(spr, -JUNK_SIZE / 2, -JUNK_SIZE / 2, JUNK_SIZE, JUNK_SIZE);
      } else {
        ctx.fillStyle = '#ffcc00';
        ctx.beginPath();
        ctx.arc(0, 0, JUNK_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawFinishProgress() {
    const { ctx } = this;
    const cfg = getLevelConfig(this.level);
    const ratio = Math.min(1, this.levelDistance / cfg.bossDistance);
    const barW = GAME_W * 0.6;
    const barX = (GAME_W - barW) / 2;
    const barY = 64;
    const barH = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
    ctx.fillStyle = '#1a3a1a';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = '#50dc50';
    ctx.fillRect(barX, barY, barW * ratio, barH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Level ${this.level} → Boss ${Math.floor(ratio * 100)}%`, GAME_W / 2, barY + 9);
    ctx.textAlign = 'left';
  }

  private drawLifeAddedToast() {
    const { ctx } = this;
    const now = performance.now() / 1000;
    const TOAST_DUR = 1.6;
    for (const p of this.players) {
      const t = now - p.lifeAddedT;
      if (t < 0 || t > TOAST_DUR) continue;
      // 페이드 + 위로 살짝 이동
      const k = t / TOAST_DUR;
      const alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      const yOff = -k * 30;
      const cx = GAME_W / 2;
      const cy = 120 + yOff;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
      ctx.fillRect(cx - 150, cy - 34, 300, 52);
      ctx.fillStyle = `rgba(255,80,120,${alpha})`;
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('❤ LIFE ADDED!', cx, cy);
      ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
      ctx.font = '15px sans-serif';
      ctx.fillText(`+1 life (every ${MEAT_PER_LIFE} bones)`, cx, cy + 18);
      ctx.restore();
    }
    ctx.textAlign = 'left';
  }

  private drawVictory() {
    const { ctx } = this;
    const now = performance.now() / 1000;
    const since = now - this.victoryT;
    const alpha = Math.max(0, 1 - since / 2.5);
    ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
    ctx.fillRect(0, 0, GAME_W, H);
    ctx.fillStyle = `rgba(255,215,0,${alpha})`;
    ctx.font = 'bold 64px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VICTORY!', GAME_W / 2, H / 2 - 30);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(`Level ${this.level} Cleared`, GAME_W / 2, H / 2 + 20);
    ctx.font = '20px sans-serif';
    ctx.fillText(`Get ready for Level ${this.level + 1}...`, GAME_W / 2, H / 2 + 56);
    ctx.textAlign = 'left';
  }

  private drawHUD() {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(18,20,28,0.85)';
    ctx.fillRect(0, 0, GAME_W, 58);

    const heartSpr = this.sprites.heart;
    const drawHearts = (startX: number, lives: number) => {
      for (let i = 0; i < MAX_LIVES; i++) {
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

      ctx.fillStyle = '#ffd23c';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(`LVL ${this.level}`, 10, 38);

      ctx.fillStyle = '#50dc50';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(`${String(Math.floor(p.score)).padStart(6, '0')}`, 80, 38);

      ctx.fillStyle = '#ff7d3c';
      ctx.font = 'bold 17px sans-serif';
      ctx.fillText(`🔥 ${p.calories.toFixed(2)} kcal`, 200, 38);

      ctx.fillStyle = '#a0e632';
      ctx.fillText(`🦵 ${p.squatCount.toFixed(1)}`, 340, 38);

      if (this.state === 'play') {
        const spd = Math.floor(this.scrollSpd / SCROLL_SPEED_INIT * 100);
        ctx.fillStyle = '#c8c864';
        ctx.font = '17px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`SPD ${spd}%`, GAME_W / 2 + 80, 38);
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = '#3c8cff';
      ctx.font = '17px sans-serif';
      ctx.fillText(`BONES ${p.meatCount}`, GAME_W - 220, 38);
      drawHearts(GAME_W - 22 - 2 * 30, p.lives);
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
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('🏋️ Do one squat to start  /  [ Space ]', GAME_W / 2, H / 2 + 100);

    ctx.fillStyle = '#64c8ff';
    ctx.font = '20px sans-serif';
    ctx.fillText("🎤 Or say 'Start'", GAME_W / 2, H / 2 + 132);

    if (this.best > 0) {
      ctx.fillStyle = '#b4b464';
      ctx.font = '22px sans-serif';
      ctx.fillText(`Best: ${this.best} pts`, GAME_W / 2, H / 2 + 168);
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
      ctx.fillStyle = '#ffd23c';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText(`Reached Level ${this.level}`, GAME_W / 2, H / 2 - 60);
      ctx.fillStyle = '#dcdcdc';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText(`Score: ${Math.floor(p.score)}`, GAME_W / 2, H / 2 - 18);
      ctx.fillStyle = '#3c8cff';
      ctx.font = '22px sans-serif';
      ctx.fillText(`Bones: x${p.meatCount}`, GAME_W / 2, H / 2 + 18);
      ctx.fillStyle = '#ff7d3c';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(
        `Squats: ${p.squatCount.toFixed(1)} reps  |  Calories: ${p.calories.toFixed(2)} kcal`,
        GAME_W / 2,
        H / 2 + 54,
      );
    } else {
      this.players.forEach((p, i) => {
        ctx.fillStyle = p.color;
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText(`P${i + 1}  Score: ${Math.floor(p.score)}   Meat: x${p.meatCount}`, GAME_W / 2, H / 2 - 28 + i * 44);
      });
    }

    ctx.fillStyle = '#b4b464';
    ctx.font = '22px sans-serif';
    ctx.fillText(`Best: ${this.best} pts`, GAME_W / 2, H / 2 + 92);
    ctx.fillStyle = '#a0a0a0';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('🏋️ Do one squat to play again  /  [ Space ]', GAME_W / 2, H / 2 + 130);
    ctx.fillStyle = '#64c8ff';
    ctx.font = '18px sans-serif';
    ctx.fillText("🎤 Or say 'Start'", GAME_W / 2, H / 2 + 158);
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
