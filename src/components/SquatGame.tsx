'use client';

import { useEffect, useRef, useState } from 'react';
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { GameEngine } from '../game/GameEngine';
import { W, H } from '../game/constants';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';

export default function SquatGame({ numPlayers = 1 }: { numPlayers?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef  = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState('Loading MediaPipe...');
  const [ready, setReady]   = useState(false);

  useEffect(() => {
    let animId: number;
    let landmarker: PoseLandmarker;

    async function init() {
      try {
        setStatus('Loading pose model...');
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: numPlayers,
        });

        setStatus('Requesting camera...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: 'user' },
        });
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();

        setStatus('Loading assets...');
        const engine = new GameEngine(canvasRef.current!, numPlayers);
        await engine.loadAssets();

        setReady(true);
        setStatus('');

        function loop() {
          const video = videoRef.current!;
          if (video.readyState >= 2) {
            const result = landmarker.detectForVideo(video, performance.now());
            const allLms = result.landmarks.length
              ? result.landmarks
              : Array(numPlayers).fill(null);
            // null 패딩
            while (allLms.length < numPlayers) allLms.push(null);
            engine.tick(allLms, video);
          }
          animId = requestAnimationFrame(loop);
        }
        animId = requestAnimationFrame(loop);
      } catch (e) {
        setStatus(`Error: ${e}`);
      }
    }

    init();
    return () => {
      cancelAnimationFrame(animId);
      landmarker?.close();
    };
  }, [numPlayers]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black">
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
