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

  const [status,        setStatus]        = useState('Loading pose model...');
  const [ready,         setReady]         = useState(false);
  const [connected,     setConnected]     = useState(false);
  const [myLane,        setMyLane]        = useState<0 | 1 | 2>(0);
  const [calibrated,    setCalibrated]    = useState(false);
  const [waiting,       setWaiting]       = useState(true);
  const [calibProgress, setCalibProgress] = useState(0);
  const [error,         setError]         = useState<string | null>(null);

  const LANE_COLORS = ['#32d250', '#3cb4ff', '#eb3b24'];
  const LANE_LABELS = ['🟢 Standing', '🔵 Half Squat', '🔴 Full Squat'];

  useEffect(() => {
    let animId: number;
    let landmarker: PoseLandmarker;

    // EMA calibration state
    let ema: number | null = null;
    let obsMin = Infinity, obsMax = -Infinity, frames = 0;
    let calibDone = false;
    let lastSentLane = -1, lastSendT = 0;


    async function init() {
      try {
        // ── Pose model ──
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });

        // ── Camera ──
        setStatus('Connecting camera...');
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: 'user' },
          });
        } catch {
          setError('Camera access denied. Please allow camera access and reload.');
          return;
        }
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();

        // ── GameEngine (viewer mode) ──
        setStatus('Loading assets...');
        const engine = new GameEngine(canvasRef.current!, 1);
        await engine.loadAssets();
        engineRef.current = engine;

        // ── PartyKit connection ──
        setStatus('Connecting to server...');
        const socket = new PartySocket({ host: PARTYKIT_HOST, room: roomCode });
        socketRef.current = socket;

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'join', name: 'Player' }));
          setConnected(true);
          setStatus('');
        };

        socket.onmessage = (e) => {
          const data = JSON.parse(e.data as string) as Record<string, unknown>;
          if (data.type === 'game_sync') {
            engine.setSeed(data.seed as number);
          }
          if (data.type === 'tick') {
            try {
              engine.applyCompactTick(
                data as Parameters<typeof engine.applyCompactTick>[0]
              );
            } catch (err) {
              console.warn('applyCompactTick error:', err);
            }
            setWaiting(false);
          }
          if (data.type === 'full_sync') {
            try {
              engine.applyRemoteRenderState(
                data as Parameters<typeof engine.applyRemoteRenderState>[0]
              );
            } catch (err) {
              console.warn('applyRemoteRenderState error:', err);
            }
            setWaiting(false);
          }
        };

        socket.onerror = () => setError('Server connection failed. Please reload.');

        setReady(true);

        // ── Main loop ──
        function loop() {
          const video = videoRef.current!;

          if (video.readyState >= 2) {
            const result = landmarker.detectForVideo(video, performance.now());
            const lms = result.landmarks.length ? result.landmarks : [null];

            // Pose detection → lane calculation → send to PartyKit
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

                if (!calibDone) {
                  // Progress: 50% weight on frames, 50% on range coverage
                  const framesPct  = Math.min(1, frames / CALIB_FRAMES);
                  const rangePct   = Math.min(1, range / 20);
                  const progress   = Math.round((framesPct * 0.5 + rangePct * 0.5) * 100);
                  setCalibProgress(progress);

                  if (range >= 20 && frames >= CALIB_FRAMES) {
                    calibDone = true;
                    setCalibrated(true);
                    setCalibProgress(100);
                  }
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

            // Render host game state on local canvas
            engine.drawViewerFrame(video, lms);
          }

          animId = requestAnimationFrame(loop);
        }
        animId = requestAnimationFrame(loop);
      } catch (err) {
        setError(`Error: ${err}`);
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
      {/* Status header */}
      <div className="flex items-center gap-4 bg-gray-900 px-5 py-2 rounded-xl">
        <span className={`text-sm font-bold px-3 py-1 rounded-full ${
          connected ? 'bg-green-800 text-green-300' : 'bg-gray-800 text-gray-400'
        }`}>
          {connected ? '● Connected' : '○ Connecting...'}
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
      </div>

      {/* Calibration panel */}
      {!calibrated && connected && !error && (
        <div className="flex flex-col items-center gap-2 bg-gray-900 px-6 py-4 rounded-xl w-full max-w-md">
          <p className="text-yellow-400 text-sm font-bold text-center">
            Calibration — stand up straight, then squat as low as you can, then stand up again
          </p>
          <div className="w-full bg-gray-700 rounded-full h-3">
            <div
              className="h-3 rounded-full transition-all duration-300"
              style={{
                width: `${calibProgress}%`,
                background: calibProgress < 50 ? '#facc15' : calibProgress < 90 ? '#60a5fa' : '#4ade80',
              }}
            />
          </div>
          <p className="text-gray-400 text-xs">{calibProgress}% — keep squatting</p>
        </div>
      )}

      {/* Calibration complete flash */}
      {calibrated && (
        <div className="text-green-400 text-sm font-semibold animate-pulse">
          Calibration complete — play!
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex flex-col items-center gap-2 bg-red-900/40 border border-red-700 px-6 py-4 rounded-xl max-w-md text-center">
          <p className="text-red-300 text-sm font-bold">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-1 px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-bold rounded-lg transition"
          >
            Reload
          </button>
        </div>
      )}

      {/* Loading / waiting overlay */}
      {(!ready || waiting) && !error && (
        <div className="absolute z-10 text-white text-xl bg-black/80 px-6 py-3 rounded-lg">
          {!ready ? status : 'Waiting for host...'}
        </div>
      )}

      {/* Game canvas — mirrors host screen */}
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
