'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import PartySocket from 'partysocket';
import { GameEngine } from '../game/GameEngine';
import { W, H } from '../game/constants';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

const PARTYKIT_HOST =
  process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? 'localhost:1999';

function hashRoomCode(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) | 0) >>> 0;
  }
  return h;
}

interface RemotePlayer {
  id: string;
  name: string;
}

export default function OnlineGame({ roomCode }: { roomCode: string }) {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const videoRef       = useRef<HTMLVideoElement>(null);
  const engineRef      = useRef<GameEngine | null>(null);
  const socketRef      = useRef<PartySocket | null>(null);
  // playerId → engineIndex 매핑
  const playerMapRef   = useRef<Map<string, number>>(new Map());

  const [status,        setStatus]        = useState('Loading...');
  const [ready,         setReady]         = useState(false);
  const [remotePlayers, setRemotePlayers] = useState<RemotePlayer[]>([]);

  const joinUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/online/${roomCode}/join`
      : `/online/${roomCode}/join`;

  // ── WebSocket 메시지 핸들러 ──────────────────────────────
  const handleMessage = useCallback((event: MessageEvent) => {
    const data = JSON.parse(event.data as string) as Record<string, unknown>;
    const engine = engineRef.current;
    if (!engine) return;

    if (data.type === 'player_joined') {
      const players = data.players as Array<{ id: string; name: string }>;
      const myId = socketRef.current?.id;
      const remotes = players.filter(p => p.id !== myId);
      setRemotePlayers(remotes);
      remotes.forEach(p => {
        if (!playerMapRef.current.has(p.id)) {
          const idx = engine.addRemotePlayer(p.name);
          playerMapRef.current.set(p.id, idx);
        }
      });
    }

    if (data.type === 'player_left') {
      const playerId = data.playerId as string;
      const idx = playerMapRef.current.get(playerId);
      if (idx !== undefined) {
        engine.removeRemotePlayer(idx);
        playerMapRef.current.delete(playerId);
        const entries = Array.from(playerMapRef.current.entries())
          .sort((a, b) => a[1] - b[1]);
        playerMapRef.current.clear();
        entries.forEach(([id, oldIdx]) => {
          playerMapRef.current.set(id, oldIdx > idx ? oldIdx - 1 : oldIdx);
        });
      }
      const players = data.players as Array<{ id: string; name: string }>;
      const myId = socketRef.current?.id;
      setRemotePlayers(players.filter(p => p.id !== myId));
    }

    if (data.type === 'lane_update') {
      const playerId  = data.playerId as string;
      const lane      = data.lane as number;
      const calibrated = data.calibrated as boolean;
      const idx = playerMapRef.current.get(playerId);
      if (idx !== undefined) engine.injectRemoteLane(idx, lane, calibrated);
    }
  }, []);

  // ── 초기화 ─────────────────────────────────────────────
  useEffect(() => {
    let animId: number;
    let landmarker: PoseLandmarker;

    async function init() {
      try {
        setStatus('포즈 모델 로딩...');
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

        setStatus('에셋 로딩...');
        const engine = new GameEngine(canvasRef.current!, 1);
        await engine.loadAssets();
        engineRef.current = engine;

        setStatus('서버 연결...');
        const socket = new PartySocket({ host: PARTYKIT_HOST, room: roomCode });
        socketRef.current = socket;

        // 방 코드를 숫자 시드로 변환 (결정론적 맵 생성)
        const seed = hashRoomCode(roomCode);
        engine.setSeed(seed);

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'join', name: 'Host' }));
          socket.send(JSON.stringify({ type: 'game_sync', seed }));
          setReady(true);
          setStatus('');
        };

        socket.onmessage = handleMessage;
        socket.onerror = () => setStatus('서버 연결 실패 — 로컬 모드로 진행');

        // broadcast: compact tick 매 프레임 + full_sync 2초마다
        let lastFullSyncT = 0;

        function loop() {
          const video = videoRef.current!;
          if (video.readyState >= 2) {
            const result = landmarker.detectForVideo(video, performance.now());
            const lms = result.landmarks.length ? result.landmarks : [null];
            engine.tick(lms, video);
          }

          if (socket.readyState === WebSocket.OPEN) {
            const now = performance.now();
            const playerIds: string[] = new Array(engine.playerCount).fill('');
            playerIds[0] = socket.id ?? '';
            playerMapRef.current.forEach((engineIdx, socketId) => {
              playerIds[engineIdx] = socketId;
            });

            // 매 프레임: compact tick (~400B) — 장애물 scrollDx + 플레이어/보스 상태
            socket.send(JSON.stringify({
              type: 'tick',
              ...engine.getCompactTick(),
              playerIds,
            }));

            // 2초마다: full sync (~3-5KB) — 장애물 절대 위치 교정
            if (now - lastFullSyncT >= 2000) {
              lastFullSyncT = now;
              socket.send(JSON.stringify({
                type: 'full_sync',
                ...engine.getFullRenderState(),
                playerIds,
              }));
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

  function copyJoinUrl() {
    navigator.clipboard.writeText(joinUrl).catch(() => {});
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black gap-2">
      <div className="flex items-center gap-4 bg-gray-900 px-6 py-2 rounded-xl">
        <span className="text-gray-400 text-sm">방 코드</span>
        <span className="text-yellow-400 text-2xl font-mono font-bold tracking-widest">
          {roomCode}
        </span>
        <button
          onClick={copyJoinUrl}
          className="text-xs bg-blue-700 hover:bg-blue-600 text-white px-3 py-1 rounded-lg transition"
        >
          참가 링크 복사
        </button>
        {remotePlayers.length > 0 && (
          <span className="text-green-400 text-sm font-bold">
            👥 +{remotePlayers.length}명 접속 중
          </span>
        )}
      </div>

      {!ready && (
        <div className="absolute z-10 text-white text-xl bg-black/80 px-6 py-3 rounded-lg">
          {status}
        </div>
      )}

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
