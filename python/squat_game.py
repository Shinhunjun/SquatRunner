"""
Squat Runner - 스쿼트로 조종하는 고기 수집 달리기 게임

스쿼트 깊이로 3개의 트랙 중 하나를 선택합니다.
  서있기    → 위쪽 트랙
  반스쿼트  → 가운데 트랙
  풀스쿼트  → 아래쪽 트랙

위험 구간(어두운 구멍)에서 다른 트랙으로 이동하세요!
안전한 트랙의 고기를 먹으면 보너스 점수!

조작법:
  Space  : 시작 / 재시작
  Q      : 종료
"""
import cv2
import mediapipe as mp
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import time
import os
import random
import math
import urllib.request
import subprocess
import threading

try:
    import whisper as _whisper
    import sounddevice as _sd
    _VOICE_AVAILABLE = True
except ImportError:
    _VOICE_AVAILABLE = False

try:
    import pygame as _pygame
    _pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=1024)
    _MUSIC_AVAILABLE = True
except Exception:
    _MUSIC_AVAILABLE = False

MUSIC_PATH = os.path.join(os.path.dirname(__file__), 'asset', 'sound', 'pixel_sprinter_loop.ogg')

def _music_play():
    if not _MUSIC_AVAILABLE or not os.path.exists(MUSIC_PATH):
        return
    try:
        _pygame.mixer.music.load(MUSIC_PATH)
        _pygame.mixer.music.set_volume(0.55)
        _pygame.mixer.music.play(-1)   # -1 = 무한 반복
    except Exception as e:
        print(f'음악 오류: {e}')

def _music_stop():
    if _MUSIC_AVAILABLE:
        try:
            _pygame.mixer.music.stop()
        except Exception:
            pass

# ═══════════════════════════════════════════════════════════
# MediaPipe
# ═══════════════════════════════════════════════════════════
_PoseLandmarker        = mp.tasks.vision.PoseLandmarker
_PoseLandmarkerOptions = mp.tasks.vision.PoseLandmarkerOptions
_RunningMode           = mp.tasks.vision.RunningMode
_BaseOptions           = mp.tasks.BaseOptions
LM                     = mp.tasks.vision.PoseLandmark
_CONNECTIONS           = mp.tasks.vision.PoseLandmarksConnections.POSE_LANDMARKS

MODEL_PATH = os.path.join(os.path.dirname(__file__), "pose_landmarker_lite.task")
MODEL_URL  = (
    "https://storage.googleapis.com/mediapipe-models/"
    "pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
)

def _ensure_model():
    if not os.path.exists(MODEL_PATH):
        print("포즈 모델 다운로드 중...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)

# ═══════════════════════════════════════════════════════════
# 스프라이트
# ═══════════════════════════════════════════════════════════
ASSET_DIR = os.path.join(os.path.dirname(__file__), 'asset', 'img')
_SPRITES: dict = {}

def _load_sprites():
    # 상수 정의 후 호출되므로 여기서 크기 참조
    asset_map = [
        ('bg-sky.png',                     'background',      (GAME_W, H)),
        ('runningman-removebg-preview.png', 'player',         (PLAYER_W * 2, PLAYER_H * 2)),
        ('Bone-removebg-preview.png',       'meat',           (54, 54)),
        ('StandingLane.png',                'platform_green',  (96, 22)),
        ('halfSquatlane.png',               'platform_cyan',   (96, 22)),
        ('full_squat_lane.png',             'platform_red',    (96, 22)),
        ('dangerzone.png',                  'hole',            (96, 28)),
        ('heart-removebg-preview.png',      'heart',           (28, 26)),
        ('GameTitle.png',                   'logo',            (480, 100)),
    ]
    if not os.path.isdir(ASSET_DIR):
        print(f'asset 폴더 없음: {ASSET_DIR}')
        return
    for fname, name, size in asset_map:
        path = os.path.join(ASSET_DIR, fname)
        if not os.path.exists(path):
            print(f'sprite 없음: {fname}')
            continue
        try:
            img = Image.open(path).convert('RGBA').resize(size, Image.LANCZOS)
            arr = np.array(img)
            _SPRITES[name] = arr[:, :, [2, 1, 0, 3]].copy()  # RGBA→BGRA
            print(f'sprite 로드: {name} {size}')
        except Exception as e:
            print(f'sprite 로드 오류 ({name}): {e}')
    # P2용 파란 색조 플레이어 스프라이트 미리 생성
    if 'player' in _SPRITES:
        p2 = _SPRITES['player'].astype(np.float32).copy()
        p2[:, :, 0] = np.clip(p2[:, :, 0] * 0.5, 0, 255)
        p2[:, :, 1] = np.clip(p2[:, :, 1] * 0.7, 0, 255)
        _SPRITES['player_p2'] = p2.astype(np.uint8)

def _blit(canvas, name_or_arr, x: int, y: int):
    """BGRA 스프라이트를 캔버스 (x, y) 위치에 알파블렌딩"""
    spr = _SPRITES.get(name_or_arr) if isinstance(name_or_arr, str) else name_or_arr
    if spr is None:
        return False
    h, w = spr.shape[:2]
    x0c = max(0, x);  y0c = max(0, y)
    x1c = min(canvas.shape[1], x + w); y1c = min(canvas.shape[0], y + h)
    if x0c >= x1c or y0c >= y1c:
        return True
    sx0, sy0 = x0c - x, y0c - y
    src  = spr[sy0:sy0+(y1c-y0c), sx0:sx0+(x1c-x0c)]
    alp  = src[:, :, 3:4].astype(np.float32) / 255.0
    dst  = canvas[y0c:y1c, x0c:x1c].astype(np.float32)
    canvas[y0c:y1c, x0c:x1c] = (alp * src[:, :, :3] + (1 - alp) * dst).astype(np.uint8)
    return True

def _blit_c(canvas, name, cx: int, cy: int):
    """중심 좌표 기준으로 스프라이트 그리기"""
    spr = _SPRITES.get(name)
    if spr is None:
        return False
    h, w = spr.shape[:2]
    return _blit(canvas, spr, cx - w // 2, cy - h // 2)

def _tile_h(canvas, name, y: int, x0: int, x1: int):
    """스프라이트를 x0-x1 구간에 수평 타일링"""
    spr = _SPRITES.get(name)
    if spr is None:
        return False
    w = spr.shape[1]
    for x in range(x0, x1, w):
        _blit(canvas, spr, x, y)
    return True

# ═══════════════════════════════════════════════════════════
# 한국어 폰트
# ═══════════════════════════════════════════════════════════
_FONT_CACHE: dict = {}
FONT_PATH = next((p for p in [
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
] if os.path.exists(p)), None)

def get_font(size: int):
    if size not in _FONT_CACHE:
        try:
            _FONT_CACHE[size] = ImageFont.truetype(FONT_PATH, size) if FONT_PATH else ImageFont.load_default()
        except Exception:
            _FONT_CACHE[size] = ImageFont.load_default()
    return _FONT_CACHE[size]

def draw_text(frame, text: str, x: int, y: int, size: int, color_bgr, anchor: str = 'left'):
    img  = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img)
    f    = get_font(size)
    rgb  = (color_bgr[2], color_bgr[1], color_bgr[0])
    if anchor == 'center':
        bbox = draw.textbbox((0, 0), text, font=f)
        x -= (bbox[2] - bbox[0]) // 2
    elif anchor == 'right':
        bbox = draw.textbbox((0, 0), text, font=f)
        x -= (bbox[2] - bbox[0])
    draw.text((x, y), text, font=f, fill=rgb)
    frame[:] = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

def speak(text: str):
    threading.Thread(
        target=lambda: subprocess.run(['say', '-v', 'Yuna', text], capture_output=True),
        daemon=True
    ).start()

# ═══════════════════════════════════════════════════════════
# 상수
# ═══════════════════════════════════════════════════════════
W, H    = 1280, 720
CAM_W   = 400
GAME_X  = CAM_W
GAME_W  = W - CAM_W               # 880

LANE_FLOOR_Y  = [175, 375, 565]   # 각 트랙 바닥 Y (게임 영역 내)
PLATFORM_H    = 20
LANE_COLORS   = [                  # BGR
    (50,  210,  80),   # 초록 (서있기)
    (200, 165,  50),   # 시안 (반스쿼트)
    (60,   90, 235),   # 빨강 (풀스쿼트)
]

PLAYER_SCREEN_X = 155
PLAYER_H        = 60
PLAYER_W        = 40

SCROLL_SPEED_INIT = 160.0    # px/s (처음엔 느리게)
SCROLL_SPEED_MAX  = 420.0
SCROLL_ACCEL      = 8.0      # px/s per second

GAP_MIN_W      = 130         # 구멍 폭
GAP_MAX_W      = 230
SAFE_ZONE_MIN  = 420         # 챌린지 사이 안전 구간 (px)
SAFE_ZONE_MAX  = 680

INVINCIBLE_DUR = 2.0         # 낙하 후 무적 시간(초)

BG_COLOR = (10, 12, 20)


# ═══════════════════════════════════════════════════════════
# 스쿼트 감지기
# ═══════════════════════════════════════════════════════════
class SquatDetector:
    EMA_ALPHA       = 0.45
    CALIB_FRAMES    = 70
    LANE_THRESHOLDS = (0.55, 0.88)

    def __init__(self):
        self._ema        = None
        self._obs_min    = float('inf')
        self._obs_max    = float('-inf')
        self._frames     = 0
        self.calibrated  = False
        self.lane        = 0
        self.smooth_norm = 1.0

    def update(self, raw_angle: float):
        self._ema = (raw_angle if self._ema is None
                     else self.EMA_ALPHA * raw_angle + (1 - self.EMA_ALPHA) * self._ema)
        self._obs_min = min(self._obs_min, self._ema)
        self._obs_max = max(self._obs_max, self._ema)
        self._frames += 1
        if (self._obs_max - self._obs_min) >= 20 and self._frames >= self.CALIB_FRAMES:
            self.calibrated = True
        if not self.calibrated:
            return
        norm = float(np.clip(
            (self._ema - self._obs_min) / max(self._obs_max - self._obs_min, 1),
            0, 1
        ))
        self.smooth_norm = 0.12 * norm + 0.88 * self.smooth_norm
        lo, hi = self.LANE_THRESHOLDS
        self.lane = 2 if norm < lo else (1 if norm < hi else 0)

    @property
    def calib_progress(self) -> float:
        return min(1.0, self._frames / self.CALIB_FRAMES)


# ═══════════════════════════════════════════════════════════
# 챌린지 (단일 레인 구멍)
#
# 핵심 설계: 한 번에 1개 레인만 막힘 → 항상 2개 이상 안전
# ═══════════════════════════════════════════════════════════
class Challenge:
    def __init__(self, lane: int, x: float, width: float):
        self.lane  = lane
        self.x     = float(x)
        self.width = float(width)

    def scroll(self, dx: float):
        self.x -= dx

    @property
    def x_end(self) -> float:
        return self.x + self.width

    @property
    def off_screen(self) -> bool:
        return self.x_end < -60

    def blocks(self, lane: int, px: float) -> bool:
        """해당 레인이 이 위치에서 막혀있는가"""
        return lane == self.lane and (self.x - 4 <= px <= self.x_end + 4)


# ═══════════════════════════════════════════════════════════
# 플레이어 상태 (1P / 2P 공통)
# ═══════════════════════════════════════════════════════════
class PlayerState:
    COLORS   = [(80, 220, 80), (60, 180, 255)]   # P1: 초록, P2: 파랑
    SCREEN_X = [130, 185]                         # 플레이어별 화면 x

    def __init__(self, idx: int):
        self.idx        = idx
        self.screen_x   = self.SCREEN_X[idx]
        self.color      = self.COLORS[idx]
        self.detector   = SquatDetector()
        self.lives      = 3
        self.score      = 0.0
        self.meat_count = 0
        self._falling   = False
        self._fall_t    = 0.0
        self._fall_y    = 0.0
        self._invincible_until = 0.0
        self._hit_t     = 0.0
        self._meat_pop_t = 0.0
        self._meat_pop_n = 0
        self._leg_phase = 0.0
        self.alive      = True


# ═══════════════════════════════════════════════════════════
# 고기 아이템
# ═══════════════════════════════════════════════════════════
class MeatItem:
    HIT_RADIUS = 36

    def __init__(self, lane: int, x: float):
        self.lane      = lane
        self.x         = float(x)
        self.collected = False
        self._phase    = random.uniform(0, math.pi * 2)

    def scroll(self, dx: float):
        self.x -= dx

    @property
    def off_screen(self) -> bool:
        return self.x < -60

    def screen_cy(self, t: float) -> int:
        return LANE_FLOOR_Y[self.lane] - PLAYER_H - 18 + int(math.sin(t * 3.5 + self._phase) * 5)

    def draw(self, area, t: float):
        if self.collected:
            return
        cx = int(self.x)
        cy = self.screen_cy(t)
        spr = _SPRITES.get('meat')
        if spr is not None:
            _blit(area, spr, cx - spr.shape[1] // 2, cy - spr.shape[0] // 2)
        else:
            cv2.line(area, (cx - 22, cy), (cx + 22, cy), (210, 215, 225), 3)
            for ex in (cx - 22, cx + 22):
                cv2.circle(area, (ex, cy), 9, (222, 226, 235), -1)
            cv2.ellipse(area, (cx, cy), (15, 9), 0, 0, 360, (40, 55, 215), -1)


# ═══════════════════════════════════════════════════════════
# 메인 게임
# ═══════════════════════════════════════════════════════════
class SideRunner:
    S_CALIB = 'calib'
    S_READY = 'ready'
    S_PLAY  = 'play'
    S_OVER  = 'over'

    def __init__(self, num_players: int = 1):
        self.num_players   = max(1, min(num_players, 2))
        self.state         = self.S_CALIB
        self._players      = [PlayerState(i) for i in range(self.num_players)]
        self._challenges: list[Challenge] = []
        self._meats:      list[MeatItem]  = []
        self.best          = 0
        self._start_t      = 0.0
        self._prev_t       = 0.0
        self._scroll_spd   = SCROLL_SPEED_INIT
        self._bob_t        = 0.0
        self._voice_trig   = False

    # ── 리셋 ──────────────────────────────────────────────
    def reset(self):
        self._challenges = []
        self._meats      = []
        for p in self._players:
            p.lives      = 3
            p.score      = 0.0
            p.meat_count = 0
            p._falling   = False
            p._fall_y    = 0.0
            p._invincible_until = 0.0
            p._leg_phase = 0.0
            p.alive      = True
        self._start_t    = time.time()
        self._prev_t     = time.time()
        self._scroll_spd = SCROLL_SPEED_INIT
        self._bob_t      = 0.0
        self.state       = self.S_PLAY
        _music_play()
        speak('시작!')

    # ── 컨텐츠 생성 ───────────────────────────────────────
    def _generate(self, difficulty: float):
        """
        챌린지와 고기를 생성합니다.
        설계 원칙: 챌린지 간 충분한 안전 구간 + 1번에 1개 레인만 막힘
        """
        # 현재 가장 오른쪽 챌린지 끝 위치
        right = max((c.x_end for c in self._challenges), default=float(GAME_W + 300))

        while right < GAME_W + 800:
            # ① 안전 구간 (고기 등장)
            safe_w = random.randint(
                max(300, int(SAFE_ZONE_MIN - difficulty * 100)),
                max(350, int(SAFE_ZONE_MAX - difficulty * 150))
            )
            # 안전 구간에 고기 2~4개 무작위 레인에
            for _ in range(random.randint(2, 4)):
                mx = right + random.uniform(40, safe_w - 40)
                self._meats.append(MeatItem(random.randint(0, 2), mx))

            right += safe_w

            # ② 챌린지 (구멍): 1개 레인만 막음
            gap_w  = int(random.uniform(GAP_MIN_W, GAP_MAX_W) * (1 + difficulty * 0.6))
            c_lane = random.randint(0, 2)
            self._challenges.append(Challenge(c_lane, right, float(gap_w)))

            # 구멍 구간: 안전한 레인에 보너스 고기
            for safe_lane in range(3):
                if safe_lane != c_lane and random.random() < 0.55:
                    mx = right + gap_w * random.uniform(0.15, 0.85)
                    self._meats.append(MeatItem(safe_lane, mx))

            right += gap_w

    # ── 업데이트 ──────────────────────────────────────────
    def update(self):
        if self.state == self.S_CALIB:
            if all(p.detector.calibrated for p in self._players):
                self.state = self.S_READY
            return
        if self.state != self.S_PLAY:
            return

        now     = time.time()
        dt      = min(now - self._prev_t, 0.05)
        self._prev_t = now
        elapsed = now - self._start_t

        # 속도 계산
        self._scroll_spd = min(SCROLL_SPEED_MAX, SCROLL_SPEED_INIT + elapsed * SCROLL_ACCEL)
        dx = self._scroll_spd * dt
        self._bob_t    += dt

        # 스크롤
        for c in self._challenges: c.scroll(dx)
        for m in self._meats:      m.scroll(dx)

        # 컨텐츠 생성
        self._generate(min(1.0, elapsed / 90.0))

        # 화면 밖 제거
        self._challenges = [c for c in self._challenges if not c.off_screen]
        self._meats      = [m for m in self._meats if not m.off_screen]

        # ── 플레이어별 업데이트 ───────────────────────────
        for p in self._players:
            if not p.alive:
                continue
            p._leg_phase = (p._leg_phase + dt * 9) % (math.pi * 2)
            player_lane  = p.detector.lane

            if p._falling:
                fe = now - p._fall_t
                p._fall_y = min(fe * 500, 440.0)
                if fe > 0.65:
                    p.lives            -= 1
                    p._hit_t            = now
                    p._falling          = False
                    p._fall_y           = 0.0
                    p._invincible_until = now + INVINCIBLE_DUR
                    if p.lives <= 0:
                        p.alive = False
                        speak(f'P{p.idx + 1} 게임오버!' if self.num_players > 1 else '게임오버!')
                    else:
                        speak('아야!')
                continue

            if now < p._invincible_until:
                for m in self._meats:
                    if not m.collected and m.lane == player_lane:
                        if abs(m.x - p.screen_x) < m.HIT_RADIUS:
                            m.collected      = True
                            p.meat_count    += 1
                            p._meat_pop_n    = p.meat_count
                            p._meat_pop_t    = now
                p.score = elapsed * 10 + p.meat_count * 50
                continue

            if self._is_danger(player_lane, float(p.screen_x)):
                p._falling = True
                p._fall_t  = now
                p._fall_y  = 0.0
                continue

            for m in self._meats:
                if not m.collected and m.lane == player_lane:
                    if abs(m.x - p.screen_x) < m.HIT_RADIUS:
                        m.collected      = True
                        p.meat_count    += 1
                        p._meat_pop_n    = p.meat_count
                        p._meat_pop_t    = now

            p.score = elapsed * 10 + p.meat_count * 50

        # ── 전체 게임오버 판정 ─────────────────────────────
        if all(not p.alive for p in self._players):
            self.best  = max(self.best, max(int(p.score) for p in self._players))
            self.state = self.S_OVER
            _music_stop()

    def _is_danger(self, lane: int, px: float = None) -> bool:
        """해당 레인·위치에서 구멍이 있는가"""
        if px is None:
            px = float(PLAYER_SCREEN_X)
        return any(c.blocks(lane, px) for c in self._challenges)

    # ── 렌더링 ────────────────────────────────────────────
    def draw(self, canvas, cam_frame, all_lms: list):
        self._draw_camera(canvas, cam_frame, all_lms)
        cv2.line(canvas, (CAM_W, 0), (CAM_W, H), (60, 70, 60), 2)
        self._draw_game(canvas)

    def _draw_camera(self, canvas, cam_frame, all_lms: list):
        if cam_frame is not None:
            canvas[:, :CAM_W] = cv2.resize(cam_frame, (CAM_W, H))
        ov = canvas[:, :CAM_W].copy()
        cv2.rectangle(ov, (0, 0), (CAM_W, 50), (20, 22, 30), -1)
        cv2.addWeighted(ov, 0.82, canvas[:, :CAM_W], 0.18, 0, canvas[:, :CAM_W])
        draw_text(canvas, 'SQUAT RUNNER', 10, 8, 22, (80, 220, 80))

        SKEL_LINE  = [(0, 170, 255), (255, 140,  0)]   # P1 파랑, P2 주황
        SKEL_DOT   = [(0, 230, 130), (0, 220, 255)]
        for pi, landmarks in enumerate(all_lms):
            if not landmarks:
                continue
            lc = SKEL_LINE[pi % len(SKEL_LINE)]
            dc = SKEL_DOT[pi % len(SKEL_DOT)]
            for conn in _CONNECTIONS:
                a, b = landmarks[conn.start], landmarks[conn.end]
                if a.visibility > 0.5 and b.visibility > 0.5:
                    cv2.line(canvas,
                             (int(a.x * CAM_W), int(a.y * H)),
                             (int(b.x * CAM_W), int(b.y * H)),
                             lc, 2)
            for lm in landmarks:
                if lm.visibility > 0.5:
                    cv2.circle(canvas, (int(lm.x * CAM_W), int(lm.y * H)), 4, dc, -1)

        self._draw_lane_indicator(canvas)

        if self.state == self.S_CALIB:
            # 평균 보정 진행률 표시
            prog = sum(p.detector.calib_progress for p in self._players) / self.num_players
            bx  = 20; bw_ = CAM_W - 40
            by_ = H - 80; bh_ = 14
            cv2.rectangle(canvas, (bx, by_), (bx + bw_, by_ + bh_), (40, 42, 55), -1)
            cv2.rectangle(canvas, (bx, by_), (bx + int(bw_ * prog), by_ + bh_), (80, 210, 235), -1)
            draw_text(canvas, '보정 중... 스쿼트를 해보세요', CAM_W // 2, H - 110, 18, (150, 200, 255), 'center')
            draw_text(canvas, f'{int(prog * 100)}%', CAM_W // 2, H - 55, 22, (220, 220, 220), 'center')

    def _draw_lane_indicator(self, canvas):
        bx      = CAM_W - 30
        seg_h   = (H - 120) // 3
        ind_col = [(80, 220, 80), (50, 210, 255), (255, 140, 50)]
        for i, col in enumerate(ind_col):
            y0 = 60 + i * seg_h
            y1 = y0 + seg_h - 4
            active = any(p.detector.calibrated and p.detector.lane == i for p in self._players)
            alpha  = 0.85 if active else 0.6
            ov = canvas[:, bx:bx + 28].copy()
            cv2.rectangle(ov, (0, y0), (28, y1), col if active else (40, 42, 55), -1)
            cv2.addWeighted(ov, alpha, canvas[:, bx:bx + 28], 1 - alpha, 0, canvas[:, bx:bx + 28])
            if active:
                cv2.rectangle(canvas, (bx, y0), (bx + 28, y1), col, 2)
        BALL_COLORS = [(230, 230, 230), (60, 180, 255)]
        offsets     = [7, 21]   # P1 left, P2 right within 28px strip
        for pi, p in enumerate(self._players):
            if p.detector.calibrated:
                hy  = 60 + int((1.0 - p.detector.smooth_norm) * (H - 180))
                bxc = bx + offsets[pi % len(offsets)]
                cv2.circle(canvas, (bxc, hy), 8, BALL_COLORS[pi % len(BALL_COLORS)], -1)
                cv2.circle(canvas, (bxc, hy), 8, (80, 80, 90), 2)

    def _draw_game(self, canvas):
        area = canvas[:, GAME_X:]
        # 배경 스프라이트 (없으면 단색)
        if not _blit(area, _SPRITES.get('background'), 0, 0):
            area[:] = np.array(BG_COLOR, dtype=np.uint8)

        if self.state in (self.S_PLAY, self.S_OVER):
            self._draw_tracks(area)
            self._draw_meats(area)
            for p in self._players:
                self._draw_player(area, p)

        self._draw_hud(area)

        if self.state == self.S_CALIB:
            ov = area.copy()
            cv2.rectangle(ov, (0, 0), (GAME_W, H), (0, 0, 0), -1)
            cv2.addWeighted(ov, 0.75, area, 0.25, 0, area)
            draw_text(area, 'SQUAT RUNNER',    GAME_W // 2, H // 2 - 50, 46, (80, 220, 80),  'center')
            draw_text(area, '스쿼트 보정 중...', GAME_W // 2, H // 2 + 14, 26, (180, 210, 180), 'center')
        elif self.state == self.S_READY:
            self._draw_ready(area)
        elif self.state == self.S_OVER:
            self._draw_gameover(area)

        # 충돌 플래시
        if any(time.time() - p._hit_t < 0.3 for p in self._players):
            fl = np.zeros_like(area)
            fl[:] = (0, 0, 160)
            cv2.addWeighted(fl, 0.35, area, 0.65, 0, area)

        canvas[:, GAME_X:] = area

    def _draw_tracks(self, area):
        now = time.time()
        # 위험 레인: 활성 플레이어 중 낙하/무적 없이 danger 상태인 레인
        dangerous_lanes = set()
        for p in self._players:
            if (p.alive and not p._falling and now >= p._invincible_until
                    and self._is_danger(p.detector.lane, float(p.screen_x))):
                dangerous_lanes.add(p.detector.lane)

        for lane in range(3):
            fy  = LANE_FLOOR_Y[lane]
            col = LANE_COLORS[lane]

            # 배경 밴드
            band = tuple(int(c * 0.15 + BG_COLOR[i] * 0.85) for i, c in enumerate(col))
            cv2.rectangle(area, (0, fy - PLAYER_H - 50), (GAME_W, fy + PLATFORM_H + 12), band, -1)

            # ── 연속 플랫폼 (스프라이트 타일 또는 폴백 사각형) ──
            spr_name = ['platform_green', 'platform_cyan', 'platform_red'][lane]
            if not _tile_h(area, spr_name, fy, 0, GAME_W):
                cv2.rectangle(area, (0, fy), (GAME_W, fy + PLATFORM_H), col, -1)
                hi = tuple(min(255, c + 80) for c in col)
                cv2.line(area, (0, fy), (GAME_W, fy), hi, 2)

            # ── 챌린지 구간: 구멍 그리기 ──────────────────────
            for ch in self._challenges:
                if ch.lane != lane:
                    continue
                x0 = max(0, int(ch.x))
                x1 = min(GAME_W, int(ch.x_end))
                if x0 >= x1:
                    continue
                # 플랫폼 구멍 영역 어둡게 덮기
                area[fy - 3:fy + PLATFORM_H + 6, x0:x1] = (3, 3, 6)
                # 구멍 텍스처 타일 (없으면 경고 줄무늬)
                if not _tile_h(area, 'hole', fy - 3, x0, x1):
                    warn_col = (20, 50, 160)
                    for xi in range(x0, x1, 18):
                        cv2.line(area, (xi, fy - 2), (min(xi + 12, x1), fy + PLATFORM_H + 4), warn_col, 1)
                cv2.rectangle(area, (x0, fy - 3), (x1 - 1, fy + PLATFORM_H + 5), (50, 40, 80), 1)

            # ── 위험 경고: 플레이어 레인이 막혀있으면 빨간 테두리 ──
            if lane in dangerous_lanes:
                t_blink = math.sin(now * 12) > 0
                if t_blink:
                    cv2.rectangle(area, (0, fy - 5), (GAME_W, fy + PLATFORM_H + 7),
                                  (0, 0, 220), 3)

            # 레인 레이블
            dim = tuple(c // 3 for c in col)
            labels = ['서있기', '반스쿼트', '풀스쿼트']
            draw_text(area, labels[lane], GAME_W - 8, fy + PLATFORM_H + 3, 15, dim, 'right')

    def _draw_meats(self, area):
        for m in self._meats:
            m.draw(area, self._bob_t)

    def _draw_player(self, area, player: 'PlayerState'):
        lane  = player.detector.lane
        cx    = player.screen_x
        fy    = LANE_FLOOR_Y[lane]
        fyo   = int(player._fall_y)
        foot  = fy - 2 + fyo
        head  = foot - PLAYER_H
        swing = math.sin(player._leg_phase) * 10

        # 무적 중 깜빡임
        now = time.time()
        if now < player._invincible_until:
            if math.sin(now * 16) < 0:
                return

        # 그림자
        cv2.ellipse(area, (cx, fy + 3), (22, 5), 0, 0, 360, (5, 5, 12), -1)

        spr = _SPRITES.get('player')
        if spr is not None:
            ph, pw = spr.shape[:2]
            frame = _SPRITES.get('player_p2', spr) if player.idx == 1 else spr
            _blit(area, frame, cx - pw // 2, foot - ph)
        else:
            col_body = player.color
            col_dark = tuple(max(0, c - 80) for c in col_body)
            col_skin = (120, 185, 228)
            cv2.rectangle(area, (cx - 12, head + 20), (cx + 12, foot - 14), col_body, -1)
            cv2.ellipse(area, (cx, head + 13), (13, 15), 0, 0, 360, col_skin, -1)
            cv2.line(area, (cx - 12, head + 28), (cx - 23, head + 42 - int(swing * 0.5)), col_dark, 5)
            cv2.line(area, (cx + 12, head + 28), (cx + 23, head + 42 + int(swing * 0.5)), col_dark, 5)
            cv2.line(area, (cx - 5, foot - 14), (cx - 11 + int(swing), foot), col_body, 6)
            cv2.line(area, (cx + 5, foot - 14), (cx + 11 - int(swing), foot), col_body, 6)

        # 플레이어 번호 (2P 모드에서만)
        if self.num_players > 1:
            draw_text(area, f'P{player.idx + 1}', cx, foot + 5, 16, player.color, 'center')

        # 낙하 중 적색 오버레이
        if player._falling:
            ov2 = area.copy()
            cv2.circle(ov2, (cx, (head + foot) // 2), 38, (0, 0, 200), -1)
            cv2.addWeighted(ov2, 0.28, area, 0.72, 0, area)

    def _draw_hud(self, area):
        ov = area[:58].copy()
        cv2.rectangle(ov, (0, 0), (GAME_W, 58), (18, 20, 28), -1)
        cv2.addWeighted(ov, 0.85, area[:58], 0.15, 0, area[:58])

        heart_spr = _SPRITES.get('heart')

        def _draw_hearts(x_start: int, lives: int, direction: int = 1):
            """direction=1: 왼→오, direction=-1: 오→왼"""
            for i in range(3):
                hx = x_start + direction * i * 30
                if heart_spr is not None:
                    hw = heart_spr.shape[1]
                    bx = hx - hw // 2
                    if i < lives:
                        _blit(area, heart_spr, bx, 16)
                    else:
                        gray = (heart_spr.astype(float) * [0.2, 0.2, 0.2, 1.0]).astype(np.uint8)
                        _blit(area, gray, bx, 16)
                else:
                    col = (60, 60, 220) if i < lives else (45, 45, 55)
                    draw_text(area, '♥', hx, 10, 24, col, 'center')

        if self.num_players == 1:
            p = self._players[0]
            draw_text(area, f'SCORE  {int(p.score):06d}', 14, 10, 26, (80, 220, 80))
            if self.state == self.S_PLAY:
                spd = int(self._scroll_spd / SCROLL_SPEED_INIT * 100)
                draw_text(area, f'SPD {spd}%', GAME_W // 2, 10, 22, (200, 200, 100), 'center')
            _draw_hearts(GAME_W - 22 - 2 * 30, p.lives, direction=1)
            draw_text(area, f'고기 {p.meat_count}', GAME_W // 2 + 110, 12, 20, (60, 140, 255))
        else:
            # 2P HUD: P1 왼쪽, P2 오른쪽
            p1, p2 = self._players[0], self._players[1]
            draw_text(area, f'P1  {int(p1.score):05d}', 10, 6, 20, p1.color)
            _draw_hearts(14, p1.lives, direction=1)
            draw_text(area, f'P2  {int(p2.score):05d}', GAME_W - 10, 6, 20, p2.color, 'right')
            _draw_hearts(GAME_W - 14 - 2 * 30, p2.lives, direction=1)
            if self.state == self.S_PLAY:
                spd = int(self._scroll_spd / SCROLL_SPEED_INIT * 100)
                draw_text(area, f'SPD {spd}%', GAME_W // 2, 10, 20, (200, 200, 100), 'center')

        # 무적 / 고기 팝업
        now = time.time()
        for pi, p in enumerate(self._players):
            if now < p._invincible_until:
                remain = p._invincible_until - now
                label  = f'P{pi+1} 무적' if self.num_players > 1 else '무적'
                draw_text(area, f'{label} {remain:.1f}s',
                          GAME_W // 2, H - 40 - pi * 28, 22, (80, 255, 200), 'center')
            if now - p._meat_pop_t < 1.2:
                alpha_v = max(0.0, 1.0 - (now - p._meat_pop_t) / 1.2)
                c = tuple(int(v * alpha_v) for v in (60, 160, 255))
                draw_text(area, f'+50점! ({p._meat_pop_n}개)',
                          GAME_W // 2, H // 2 - 60 - pi * 42, 34, c, 'center')

    def _draw_ready(self, area):
        ov = area.copy()
        cv2.rectangle(ov, (0, 0), (GAME_W, H), (0, 0, 0), -1)
        cv2.addWeighted(ov, 0.52, area, 0.48, 0, area)
        # 로고 스프라이트
        logo_spr = _SPRITES.get('logo')
        if logo_spr is not None:
            lh, lw = logo_spr.shape[:2]
            _blit(area, logo_spr, GAME_W // 2 - lw // 2, H // 2 - 150)
        else:
            draw_text(area, '준비 완료!', GAME_W//2, H//2 - 100, 52, (80, 220, 80), 'center')
        draw_text(area, '스쿼트로 트랙을 바꿔 고기를 모으세요!',  GAME_W//2, H//2 - 34,  22, (160, 200, 160), 'center')
        draw_text(area, '어두운 구멍이 있는 트랙은 위험합니다!',   GAME_W//2, H//2 + 2,   20, (180, 150, 100), 'center')
        draw_text(area, '낙하 후 2초간 무적 (여유롭게 이동)',      GAME_W//2, H//2 + 32,  18, (100, 200, 200), 'center')
        if self.num_players > 1:
            draw_text(area, f'★ {self.num_players}인 플레이 ★', GAME_W//2, H//2 + 60, 24, (255, 200, 60), 'center')
        draw_text(area, '[ Space ] 시작',                     GAME_W//2, H//2 + 88,  30, (200, 200, 200), 'center')
        draw_text(area, '"시작" 이라고 말해도 됩니다',              GAME_W//2, H//2 + 126, 20, (120, 200, 255), 'center')
        if self.best > 0:
            draw_text(area, f'최고 기록: {self.best}점',        GAME_W//2, H//2 + 158, 22, (180, 180, 100), 'center')

    def _draw_gameover(self, area):
        ov = area.copy()
        cv2.rectangle(ov, (0, 0), (GAME_W, H), (0, 0, 0), -1)
        cv2.addWeighted(ov, 0.65, area, 0.35, 0, area)
        draw_text(area, 'GAME OVER', GAME_W//2, H//2 - 110, 64, (60, 60, 225), 'center')
        if self.num_players == 1:
            p = self._players[0]
            draw_text(area, f'점수: {int(p.score)}',   GAME_W//2, H//2 - 28, 40, (220, 220, 220), 'center')
            draw_text(area, f'고기: {p.meat_count}개', GAME_W//2, H//2 + 30, 28, (60, 140, 255),  'center')
        else:
            for i, p in enumerate(self._players):
                draw_text(area, f'P{i+1} 점수: {int(p.score)}  고기: {p.meat_count}개',
                          GAME_W//2, H//2 - 28 + i * 44, 30, p.color, 'center')
        draw_text(area, f'최고 기록: {self.best}점',       GAME_W//2, H//2 + 80,  24, (180, 180, 100), 'center')
        draw_text(area, '[ Space ] 다시 시작    [ Q ] 종료', GAME_W//2, H//2 + 118, 24, (160, 160, 160), 'center')

    # ── 음성 리스너 ────────────────────────────────────────
    def _start_voice_listener(self):
        if not _VOICE_AVAILABLE:
            print("whisper / sounddevice 미설치 — 음성 시작 비활성화")
            return

        def _run():
            try:
                model = _whisper.load_model("tiny")
                RATE  = 16000
                print("음성 인식 준비 완료 ('시작'이라고 말하세요)")
                while True:
                    audio = _sd.rec(int(1.5 * RATE), samplerate=RATE, channels=1, dtype='float32')
                    _sd.wait()
                    text = model.transcribe(audio.flatten(), language='ko', fp16=False).get('text', '')
                    if '시작' in text:
                        self._voice_trig = True
            except Exception as e:
                print(f"음성 오류: {e}")

        threading.Thread(target=_run, daemon=True).start()

    # ── 메인 루프 ──────────────────────────────────────────
    def run(self):
        _load_sprites()
        _ensure_model()

        options = _PoseLandmarkerOptions(
            base_options=_BaseOptions(model_asset_path=MODEL_PATH),
            running_mode=_RunningMode.VIDEO,
            num_poses=self.num_players,
            min_pose_detection_confidence=0.6,
            min_pose_presence_confidence=0.6,
            min_tracking_confidence=0.6,
        )

        available = []
        for idx in range(4):
            c = cv2.VideoCapture(idx)
            if c.isOpened():
                ok, _ = c.read()
                if ok:
                    available.append(idx)
            c.release()

        cam_idx = 0
        if len(available) > 1:
            print("\n사용 가능한 카메라:")
            for idx in available:
                label = "(iPhone/외부)" if idx == 0 else "(내장)" if idx == 1 else ""
                print(f"  {idx}: 카메라 {idx}  {label}")
            while True:
                try:
                    sel = int(input("카메라 번호 선택: ").strip())
                    if sel in available:
                        cam_idx = sel
                        break
                except (ValueError, EOFError):
                    pass
        elif available:
            cam_idx = available[0]

        self._start_voice_listener()

        cap = cv2.VideoCapture(cam_idx)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

        canvas = np.zeros((H, W, 3), dtype=np.uint8)
        cv2.namedWindow('Squat Runner', cv2.WINDOW_NORMAL)

        def _knee_angle(lms):
            hip   = lms[LM.RIGHT_HIP.value]
            knee  = lms[LM.RIGHT_KNEE.value]
            ankle = lms[LM.RIGHT_ANKLE.value]
            if not all(l.visibility > 0.5 for l in (hip, knee, ankle)):
                return None
            pa = np.array([hip.x,   hip.y])
            pb = np.array([knee.x,  knee.y])
            pc = np.array([ankle.x, ankle.y])
            v1, v2 = pa - pb, pc - pb
            cos_a  = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9)
            return float(np.degrees(np.arccos(np.clip(cos_a, -1, 1))))

        with _PoseLandmarker.create_from_options(options) as landmarker:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frame = cv2.flip(frame, 1)

                rgb    = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                ts_ms  = int(time.time() * 1000)
                result = landmarker.detect_for_video(mp_img, ts_ms)

                # 각 플레이어에게 포즈 결과 할당
                all_lms = list(result.pose_landmarks) if result.pose_landmarks else []
                while len(all_lms) < self.num_players:
                    all_lms.append(None)

                for pi, p in enumerate(self._players):
                    lms = all_lms[pi]
                    if lms:
                        angle = _knee_angle(lms)
                        if angle is not None:
                            p.detector.update(angle)

                if self._voice_trig:
                    self._voice_trig = False
                    if self.state in (self.S_READY, self.S_OVER):
                        self.reset()

                self.update()
                self.draw(canvas, frame, all_lms)
                cv2.imshow('Squat Runner', canvas)

                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    break
                elif key == ord(' ') and self.state in (self.S_READY, self.S_OVER):
                    self.reset()

        cap.release()
        cv2.destroyAllWindows()


# ═══════════════════════════════════════════════════════════
# 진입점
# ═══════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("Squat Runner")
    print("스쿼트 깊이로 트랙을 바꿔 고기를 모으며 달리세요!\n")
    print("  서있기    → 위쪽 트랙 (초록)")
    print("  반스쿼트  → 가운데 트랙 (시안)")
    print("  풀스쿼트  → 아래쪽 트랙 (빨강)\n")
    print("어두운 구멍이 보이면 다른 트랙으로 이동하세요!")
    print("낙하 후 2초간 무적 시간이 주어집니다.\n")

    num_players = 1
    try:
        ans = input("인원수를 선택하세요  1인 / 2인  [1]: ").strip()
        if ans == '2':
            num_players = 2
            print("2인 플레이 모드! 두 사람 모두 카메라 앞에 서세요.")
    except (ValueError, EOFError):
        pass

    SideRunner(num_players=num_players).run()
