'use client';

import { useEffect, useRef, useState } from 'react';
import { PoseLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import PartySocket from 'partysocket';
import {
  EMA_ALPHA, CALIB_FRAMES, LANE_THRESHOLDS,
  LM_RIGHT_HIP, LM_RIGHT_KNEE, LM_RIGHT_ANKLE,
} from '../game/constants';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const PARTYKIT_HOST =
  process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? 'localhost:1999';

interface PlayerState {
  idx: number;
  lane: number;
  lives: number;
  score: number;
  squatCount: number;
  alive: boolean;
  color: string;
  name: string;
}

interface GameState {
  players: PlayerState[];
  level: number;
  phase: string;
  gameState: string;
  bossHP: number;
  bossMaxHP: number;
  levelProgress: number;
  playerIds: string[];
}

const LANE_Y    = [110, 230, 350]; // 게임뷰 캔버스 안 레인 Y
const CANVAS_W  = 700;
const CANVAS_H  = 480;
const LANE_COLORS = ['#32d250', '#3cb4ff', '#eb3b24'];

function drawGameView(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  mySocketId: string,
) {
  const { players, level, phase, bossHP, bossMaxHP, levelProgress } = gs;

  // 배경
  ctx.fillStyle = '#0a0c14';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // ── 상단 HUD ──
  ctx.fillStyle = 'rgba(18,20,28,0.9)';
  ctx.fillRect(0, 0, CANVAS_W, 56);

  ctx.fillStyle = '#ffd23c';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`LVL ${level}`, 12, 36);

  if (phase === 'boss') {
    // 보스 HP 바
    const barW = 240, barH = 14;
    const barX = CANVAS_W / 2 - barW / 2;
    const barY = 20;
    ctx.fillStyle = '#3c1010';
    ctx.fillRect(barX, barY, barW, barH);
    const hpRatio = bossMaxHP > 0 ? bossHP / bossMaxHP : 0;
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#ff4040');
    grad.addColorStop(1, '#ffb040');
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW * hpRatio, barH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`BOSS  ${Math.ceil(bossHP)} / ${bossMaxHP}`, CANVAS_W / 2, barY + 12);
  } else if (phase === 'running') {
    // 진행도 바
    const barW = 240, barH = 14;
    const barX = CANVAS_W / 2 - barW / 2;
    const barY = 20;
    ctx.fillStyle = '#1a3a1a';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = '#50dc50';
    ctx.fillRect(barX, barY, barW * levelProgress, barH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `Level ${level} → Boss ${Math.floor(levelProgress * 100)}%`,
      CANVAS_W / 2, barY + 12,
    );
  }

  ctx.textAlign = 'left';

  // ── 레인 트랙 ──
  const laneX  = 20;
  const laneW  = CANVAS_W - 40;
  const laneH  = 80;

  for (let i = 0; i < 3; i++) {
    const y = LANE_Y[i] - laneH / 2;
    ctx.fillStyle = `rgba(255,255,255,0.03)`;
    ctx.fillRect(laneX, y, laneW, laneH);
    ctx.strokeStyle = `rgba(255,255,255,0.08)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(laneX, y, laneW, laneH);

    ctx.fillStyle = LANE_COLORS[i];
    ctx.globalAlpha = 0.5;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(['서있기', '반스쿼트', '풀스쿼트'][i], laneX + 8, LANE_Y[i] + 5);
    ctx.globalAlpha = 1;
  }

  // ── 각 플레이어 캐릭터 ──
  const totalPlayers = players.length;
  players.forEach((p, playerIdx) => {
    if (!p.alive) return;

    // 같은 레인에 여러 명 있을 때 X를 분산
    const samelanePlayers = players.filter(pp => pp.lane === p.lane && pp.alive);
    const posInLane = samelanePlayers.findIndex(pp => pp.idx === p.idx);
    const spacing = laneW / (totalPlayers + 1);
    const baseX = laneX + spacing * (playerIdx + 1);
    const jitter = (posInLane - (samelanePlayers.length - 1) / 2) * 30;
    const cx = baseX + jitter;
    const cy = LANE_Y[p.lane];

    const isMe = (gs.playerIds[p.idx] === mySocketId);

    // 원형 배경 (나 표시)
    if (isMe) {
      ctx.beginPath();
      ctx.arc(cx, cy, 28, 0, Math.PI * 2);
      ctx.fillStyle = `${p.color}33`;
      ctx.fill();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // 캐릭터 (단순 원형 + 이름)
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = `bold ${isMe ? 13 : 11}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(isMe ? `★${p.name}` : p.name, cx, cy + 5);

    // 목숨 점
    for (let h = 0; h < 3; h++) {
      ctx.beginPath();
      ctx.arc(cx - 14 + h * 14, cy + 28, 5, 0, Math.PI * 2);
      ctx.fillStyle = h < p.lives ? '#dc3cdc' : '#333';
      ctx.fill();
    }
  });

  ctx.textAlign = 'left';

  // ── 하단 점수 HUD ──
  ctx.fillStyle = 'rgba(18,20,28,0.9)';
  ctx.fillRect(0, CANVAS_H - 70, CANVAS_W, 70);

  const colW = CANVAS_W / Math.max(players.length, 1);
  players.forEach((p, i) => {
    const x = colW * i + 10;
    ctx.fillStyle = p.color;
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`${p.name}`, x, CANVAS_H - 50);
    ctx.fillStyle = '#50dc50';
    ctx.font = '13px monospace';
    ctx.fillText(`${String(p.score).padStart(5, '0')} pts`, x, CANVAS_H - 32);
    ctx.fillStyle = '#a0e632';
    ctx.font = '12px sans-serif';
    ctx.fillText(`🦵 ${p.squatCount}`, x, CANVAS_H - 14);
  });
}

function kneeAngle(lms: NormalizedLandmark[]): number | null {
  const hip   = lms[LM_RIGHT_HIP];
  const knee  = lms[LM_RIGHT_KNEE];
  const ankle = lms[LM_RIGHT_ANKLE];
  if (!hip || !knee || !ankle) return null;
  const v1 = { x: hip.x - knee.x,   y: hip.y - knee.y };
  const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 < 0.01 || mag2 < 0.01) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (mag1 * mag2)))) * 180) / Math.PI;
}

const LANE_LABELS = ['🟢 서있기', '🔵 반스쿼트', '🔴 풀스쿼트'];
const LANE_BG     = ['#0d2d16', '#0a1f30', '#2d0d0d'];

export default function ParticipantView({ roomCode }: { roomCode: string }) {
  const camCanvasRef  = useRef<HTMLCanvasElement>(null);
  const gameCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef      = useRef<HTMLVideoElement>(null);
  const socketRef     = useRef<PartySocket | null>(null);
  const myIdRef       = useRef<string>('');
  const gameStateRef  = useRef<GameState | null>(null);
  const rafRef        = useRef<number>(0);

  const [status,     setStatus]     = useState('포즈 모델 로딩...');
  const [lane,       setLane]       = useState<0 | 1 | 2>(0);
  const [calibrated, setCalibrated] = useState(false);
  const [connected,  setConnected]  = useState(false);

  useEffect(() => {
    let animId: number;
    let landmarker: PoseLandmarker;

    let ema: number | null = null;
    let obsMin = Infinity, obsMax = -Infinity, frames = 0;
    let calibDone = false;
    let lastSentLane = -1, lastSendT = 0;

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });

        setStatus('카메라 연결...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
        });
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();

        setStatus('서버 연결...');
        const socket = new PartySocket({ host: PARTYKIT_HOST, room: roomCode });
        socketRef.current = socket;

        socket.onopen = () => {
          myIdRef.current = socket.id ?? '';
          socket.send(JSON.stringify({ type: 'join', name: 'Player' }));
          setConnected(true);
          setStatus('');
        };

        socket.onmessage = (e) => {
          const data = JSON.parse(e.data as string) as Record<string, unknown>;
          if (data.type === 'game_state') {
            gameStateRef.current = data as unknown as GameState;
          }
        };

        socket.onerror = () => setStatus('서버 연결 실패');

        const camCtx  = camCanvasRef.current!.getContext('2d')!;
        const gameCtx = gameCanvasRef.current!.getContext('2d')!;

        function loop() {
          const video = videoRef.current!;

          // ── 카메라 캔버스 ──
          if (video.readyState >= 2) {
            const cw = camCanvasRef.current!.width  = video.videoWidth  || 320;
            const ch = camCanvasRef.current!.height = video.videoHeight || 240;

            camCtx.save();
            camCtx.translate(cw, 0);
            camCtx.scale(-1, 1);
            camCtx.drawImage(video, 0, 0);
            camCtx.restore();

            const result = landmarker.detectForVideo(video, performance.now());
            if (result.landmarks.length > 0) {
              const lms = result.landmarks[0];
              const angle = kneeAngle(lms);
              if (angle !== null) {
                ema = ema === null
                  ? angle
                  : EMA_ALPHA * angle + (1 - EMA_ALPHA) * ema;
                obsMin = Math.min(obsMin, ema);
                obsMax = Math.max(obsMax, ema);
                frames++;
                const range = obsMax - obsMin;
                if (!calibDone && range >= 20 && frames >= CALIB_FRAMES) {
                  calibDone = true;
                  setCalibrated(true);
                }
                if (calibDone) {
                  const norm = Math.max(0, Math.min(1, (ema - obsMin) / Math.max(range, 1)));
                  const [lo, hi] = LANE_THRESHOLDS;
                  const newLane: 0 | 1 | 2 = norm < lo ? 2 : norm < hi ? 1 : 0;
                  setLane(newLane);
                  const now = performance.now();
                  if (newLane !== lastSentLane || now - lastSendT > 100) {
                    socket.send(JSON.stringify({ type: 'lane_update', lane: newLane, calibrated: true }));
                    lastSentLane = newLane;
                    lastSendT = now;
                  }
                }
              }

              // 포즈 점 오버레이
              camCtx.fillStyle = '#00ff88';
              lms.forEach(lm => {
                camCtx.beginPath();
                camCtx.arc((1 - lm.x) * cw, lm.y * ch, 4, 0, Math.PI * 2);
                camCtx.fill();
              });
            }

            // 캘리브레이션 진행도
            if (!calibDone) {
              const prog = Math.min(1, frames / CALIB_FRAMES);
              camCtx.fillStyle = 'rgba(0,0,0,0.55)';
              camCtx.fillRect(10, ch - 46, cw - 20, 22);
              camCtx.fillStyle = '#50dc50';
              camCtx.fillRect(10, ch - 46, (cw - 20) * prog, 22);
              camCtx.fillStyle = '#fff';
              camCtx.font = '13px sans-serif';
              camCtx.textAlign = 'center';
              camCtx.fillText(`캘리브레이션 ${Math.floor(prog * 100)}%`, cw / 2, ch - 30);
              camCtx.textAlign = 'left';
            }
          }

          // ── 게임 상태 캔버스 ──
          const gs = gameStateRef.current;
          if (gs) {
            drawGameView(gameCtx, gs, myIdRef.current);
          } else {
            gameCtx.fillStyle = '#0a0c14';
            gameCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
            gameCtx.fillStyle = '#444';
            gameCtx.font = '18px sans-serif';
            gameCtx.textAlign = 'center';
            gameCtx.fillText('호스트 연결 대기 중...', CANVAS_W / 2, CANVAS_H / 2);
            gameCtx.textAlign = 'left';
          }

          animId = requestAnimationFrame(loop);
        }
        animId = requestAnimationFrame(loop);
        rafRef.current = animId;
      } catch (e) {
        setStatus(`오류: ${e}`);
      }
    }

    init();
    return () => {
      cancelAnimationFrame(animId);
      landmarker?.close();
      socketRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black gap-3 px-2 py-4">
      {/* 헤더 */}
      <div className="flex items-center gap-4">
        <span className={`text-sm font-bold px-3 py-1 rounded-full ${
          connected ? 'bg-green-800 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>
          {connected ? '● 연결됨' : '○ 연결 중...'}
        </span>
        <span className="text-yellow-400 font-mono text-xl font-bold tracking-widest">
          {roomCode}
        </span>
      </div>

      {status && (
        <div className="text-white bg-gray-900 px-6 py-2 rounded-lg text-sm">{status}</div>
      )}

      {/* 게임 뷰 (모든 참가자 캐릭터) */}
      <canvas
        ref={gameCanvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="rounded-2xl border border-gray-700 max-w-full"
      />

      {/* 하단: 카메라 + 레인 표시 */}
      <div className="flex gap-3 w-full max-w-xl">
        {/* 내 카메라 */}
        <div className="relative flex-1 rounded-xl overflow-hidden border-2"
          style={{ borderColor: LANE_COLORS[lane] }}>
          <canvas ref={camCanvasRef} className="w-full" />
          <video ref={videoRef} className="hidden" playsInline muted />
        </div>

        {/* 내 레인 표시 */}
        <div
          className="flex flex-col items-center justify-center w-36 rounded-xl py-4 gap-1"
          style={{ background: LANE_BG[lane], border: `2px solid ${LANE_COLORS[lane]}` }}
        >
          <span className="text-2xl font-black" style={{ color: LANE_COLORS[lane] }}>
            {LANE_LABELS[lane]}
          </span>
          <span className="text-xs" style={{ color: LANE_COLORS[lane] }}>
            {calibrated ? '인식 중' : '캘리브 필요'}
          </span>
        </div>
      </div>
    </div>
  );
}
