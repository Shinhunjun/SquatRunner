'use client';

import { useEffect, useRef, useState } from 'react';
import { PoseLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import PartySocket from 'partysocket';
import { GameEngine } from '../game/GameEngine';
import { W, H } from '../game/constants';
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

export default function ParticipantView({ roomCode }: { roomCode: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef  = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const socketRef = useRef<PartySocket | null>(null);

  const [status,     setStatus]     = useState('포즈 모델 로딩...');
  const [ready,      setReady]      = useState(false);
  const [connected,  setConnected]  = useState(false);
  const [myLane,     setMyLane]     = useState<0 | 1 | 2>(0);
  const [calibrated, setCalibrated] = useState(false);
  const [waiting,    setWaiting]    = useState(true); // 호스트 상태 수신 전

  const LANE_COLORS = ['#32d250', '#3cb4ff', '#eb3b24'];
  const LANE_LABELS = ['🟢 서있기', '🔵 반스쿼트', '🔴 풀스쿼트'];

  useEffect(() => {
    let animId: number;
    let landmarker: PoseLandmarker;

    // EMA 캘리브레이션 상태
    let ema: number | null = null;
    let obsMin = Infinity, obsMax = -Infinity, frames = 0;
    let calibDone = false;
    let lastSentLane = -1, lastSendT = 0;

    async function init() {
      try {
        // ── 포즈 모델 ──
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });

        // ── 카메라 ──
        setStatus('카메라 연결...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: 'user' },
        });
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();

        // ── GameEngine (뷰어 모드 — 게임 에셋 로드 후 applyRemoteRenderState로 구동) ──
        setStatus('에셋 로딩...');
        const engine = new GameEngine(canvasRef.current!, 1);
        await engine.loadAssets();
        engineRef.current = engine;

        // ── PartyKit 연결 ──
        setStatus('서버 연결...');
        const socket = new PartySocket({ host: PARTYKIT_HOST, room: roomCode });
        socketRef.current = socket;

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'join', name: 'Player' }));
          setConnected(true);
          setStatus('');
        };

        socket.onmessage = (e) => {
          const data = JSON.parse(e.data as string) as Record<string, unknown>;
          if (data.type === 'game_state') {
            // 호스트 전체 렌더 상태 수신 → 엔진에 적용
            engine.applyRemoteRenderState(
              data as Parameters<typeof engine.applyRemoteRenderState>[0]
            );
            setWaiting(false);
          }
        };

        socket.onerror = () => setStatus('서버 연결 실패');

        setReady(true);

        // ── 메인 루프 ──
        function loop() {
          const video = videoRef.current!;

          if (video.readyState >= 2) {
            const result = landmarker.detectForVideo(video, performance.now());
            const lms = result.landmarks.length ? result.landmarks : [null];

            // 포즈 감지 → lane 계산 → PartyKit 전송
            if (result.landmarks.length > 0) {
              const angle = kneeAngle(result.landmarks[0]);
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
                  setMyLane(newLane);
                  const now = performance.now();
                  if (newLane !== lastSentLane || now - lastSendT > 100) {
                    socket.send(JSON.stringify({ type: 'lane_update', lane: newLane, calibrated: true }));
                    lastSentLane = newLane;
                    lastSendT = now;
                  }
                }
              }
            }

            // 호스트 게임 상태를 내 캔버스에 렌더링 (본인 카메라 + 동일 게임 화면)
            engine.drawViewerFrame(video, lms);
          }

          animId = requestAnimationFrame(loop);
        }
        animId = requestAnimationFrame(loop);
      } catch (err) {
        setStatus(`오류: ${err}`);
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-black gap-2">
      {/* 상태 헤더 */}
      <div className="flex items-center gap-4 bg-gray-900 px-5 py-2 rounded-xl">
        <span className={`text-sm font-bold px-3 py-1 rounded-full ${
          connected ? 'bg-green-800 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>
          {connected ? '● 연결됨' : '○ 연결 중...'}
        </span>
        <span className="text-yellow-400 font-mono text-xl font-bold tracking-widest">
          {roomCode}
        </span>
        {calibrated && (
          <span
            className="text-sm font-bold px-3 py-1 rounded-full"
            style={{ background: `${LANE_COLORS[myLane]}22`, color: LANE_COLORS[myLane] }}
          >
            {LANE_LABELS[myLane]}
          </span>
        )}
        {!calibrated && connected && (
          <span className="text-yellow-400 text-sm animate-pulse">
            ⚠ 무릎을 구부렸다 펴세요 (캘리브레이션)
          </span>
        )}
      </div>

      {(!ready || waiting) && (
        <div className="absolute z-10 text-white text-xl bg-black/80 px-6 py-3 rounded-lg">
          {!ready ? status : '호스트 연결 대기 중...'}
        </div>
      )}

      {/* 게임 캔버스 — 호스트와 동일한 화면 */}
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="max-w-full"
        style={{ aspectRatio: `${W}/${H}` }}
      />
      <video ref={videoRef} className="hidden" playsInline muted />
    </div>
  );
}
