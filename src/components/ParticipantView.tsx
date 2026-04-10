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

const LANE_LABELS  = ['🟢 서있기', '🔵 반스쿼트', '🔴 풀스쿼트'];
const LANE_COLORS  = ['#32d250', '#3cb4ff', '#eb3b24'];
const LANE_BG      = ['#0d2d16', '#0a1f30', '#2d0d0d'];

function kneeAngle(lms: NormalizedLandmark[]): number | null {
  const hip   = lms[LM_RIGHT_HIP];
  const knee  = lms[LM_RIGHT_KNEE];
  const ankle = lms[LM_RIGHT_ANKLE];
  if (!hip || !knee || !ankle) return null;
  const v1 = { x: hip.x   - knee.x, y: hip.y   - knee.y };
  const v2 = { x: ankle.x - knee.x, y: ankle.y - knee.y };
  const dot  = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 < 0.01 || mag2 < 0.01) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (mag1 * mag2)))) * 180) / Math.PI;
}

export default function ParticipantView({ roomCode }: { roomCode: string }) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const socketRef  = useRef<PartySocket | null>(null);

  const [status,      setStatus]     = useState('포즈 모델 로딩...');
  const [lane,        setLane]       = useState<0 | 1 | 2>(0);
  const [calibrated,  setCalibrated] = useState(false);
  const [connected,   setConnected]  = useState(false);
  const [playerCount, setPlayerCount] = useState(0);

  useEffect(() => {
    let animId: number;
    let landmarker: PoseLandmarker;

    // EMA 상태 (SquatDetector와 동일 로직)
    let ema: number | null = null;
    let obsMin = Infinity;
    let obsMax = -Infinity;
    let frames = 0;
    let calibDone = false;
    let lastSentLane: number = -1;
    let lastSendT = 0;

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
          video: { width: 1280, height: 720, facingMode: 'user' },
        });
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();

        setStatus('서버 연결...');
        const socket = new PartySocket({ host: PARTYKIT_HOST, room: roomCode });
        socketRef.current = socket;

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'join', name: 'Participant' }));
          setConnected(true);
          setStatus('');
        };
        socket.onmessage = (e) => {
          const data = JSON.parse(e.data as string) as Record<string, unknown>;
          if (data.type === 'player_joined' || data.type === 'room_state') {
            const players = data.players as unknown[];
            setPlayerCount(players.length);
          }
          if (data.type === 'player_left') {
            const players = data.players as unknown[];
            setPlayerCount(players.length);
          }
        };
        socket.onerror = () => setStatus('서버 연결 실패');

        // 카메라에 포즈 오버레이
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d')!;

        function loop() {
          const video = videoRef.current!;
          if (video.readyState >= 2) {
            const result = landmarker.detectForVideo(video, performance.now());
            const lmsList = result.landmarks;

            // 카메라 미러 렌더
            canvas.width  = video.videoWidth  || 640;
            canvas.height = video.videoHeight || 480;
            ctx.save();
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(video, 0, 0);
            ctx.restore();

            if (lmsList.length > 0) {
              const lms = lmsList[0];
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

                  // 변화 시 또는 100ms마다 전송
                  const now = performance.now();
                  if (newLane !== lastSentLane || now - lastSendT > 100) {
                    socket.send(JSON.stringify({
                      type: 'lane_update',
                      lane: newLane,
                      calibrated: true,
                    }));
                    lastSentLane = newLane;
                    lastSendT = now;
                  }
                }
              }

              // 랜드마크 오버레이
              ctx.strokeStyle = '#00ff88';
              ctx.lineWidth = 3;
              lms.forEach(lm => {
                ctx.beginPath();
                ctx.arc(
                  (1 - lm.x) * canvas.width,
                  lm.y * canvas.height,
                  5, 0, Math.PI * 2
                );
                ctx.fillStyle = '#00ff88';
                ctx.fill();
              });
            }

            // 캘리브레이션 진행도
            if (!calibDone) {
              const prog = Math.min(1, frames / CALIB_FRAMES);
              ctx.fillStyle = 'rgba(0,0,0,0.5)';
              ctx.fillRect(20, canvas.height - 50, canvas.width - 40, 24);
              ctx.fillStyle = '#50dc50';
              ctx.fillRect(20, canvas.height - 50, (canvas.width - 40) * prog, 24);
              ctx.fillStyle = '#fff';
              ctx.font = 'bold 16px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(
                `캘리브레이션 ${Math.floor(prog * 100)}% — 무릎을 구부렸다 펴보세요`,
                canvas.width / 2, canvas.height - 32
              );
              ctx.textAlign = 'left';
            }
          }

          animId = requestAnimationFrame(loop);
        }
        animId = requestAnimationFrame(loop);
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-black gap-4 px-4">
      {/* 상태 헤더 */}
      <div className="flex items-center gap-4">
        <span
          className={`text-sm font-bold px-3 py-1 rounded-full ${
            connected ? 'bg-green-800 text-green-300' : 'bg-gray-800 text-gray-400'
          }`}
        >
          {connected ? '● 연결됨' : '○ 연결 중...'}
        </span>
        <span className="text-yellow-400 font-mono text-lg font-bold tracking-widest">
          {roomCode}
        </span>
        {playerCount > 0 && (
          <span className="text-blue-400 text-sm">👥 {playerCount}명 참가</span>
        )}
      </div>

      {status && (
        <div className="text-white text-lg bg-gray-900 px-6 py-3 rounded-lg">{status}</div>
      )}

      {/* 카메라 + 포즈 오버레이 */}
      <div className="relative w-full max-w-md rounded-2xl overflow-hidden border-4"
        style={{ borderColor: LANE_COLORS[lane] }}>
        <canvas ref={canvasRef} className="w-full" />
        <video ref={videoRef} className="hidden" playsInline muted />
      </div>

      {/* 레인 표시 */}
      <div
        className="w-full max-w-md py-6 rounded-2xl flex flex-col items-center gap-1 transition-all duration-100"
        style={{ background: LANE_BG[lane], border: `3px solid ${LANE_COLORS[lane]}` }}
      >
        <span className="text-5xl font-black" style={{ color: LANE_COLORS[lane] }}>
          {LANE_LABELS[lane]}
        </span>
        <span className="text-gray-500 text-sm mt-1">
          {calibrated ? '인식 중' : '캘리브레이션 필요'}
        </span>
      </div>

      {/* 레인 설명 */}
      <div className="flex gap-3 text-xs text-gray-500">
        <span style={{ color: LANE_COLORS[0] }}>↑ 서있기 = 레인 0</span>
        <span style={{ color: LANE_COLORS[1] }}>↕ 반스쿼트 = 레인 1</span>
        <span style={{ color: LANE_COLORS[2] }}>↓ 풀스쿼트 = 레인 2</span>
      </div>
    </div>
  );
}
