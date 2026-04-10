'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function OnlineLobby() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState('');

  function handleCreate() {
    const code = generateCode();
    router.push(`/online/${code}`);
  }

  function handleJoin() {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) return;
    router.push(`/online/${code}/join`);
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black gap-10 px-4">
      <h1 className="text-4xl font-bold text-blue-400">🌐 온라인 멀티플레이</h1>

      {/* 방 만들기 */}
      <div className="flex flex-col items-center gap-3 bg-gray-900 p-8 rounded-2xl w-full max-w-sm">
        <h2 className="text-white text-xl font-bold">방 만들기</h2>
        <p className="text-gray-400 text-sm text-center">
          새 방을 만들고 친구에게 코드를 공유하세요
        </p>
        <button
          onClick={handleCreate}
          className="w-full py-3 bg-green-600 hover:bg-green-500 text-white text-lg font-bold rounded-xl transition"
        >
          방 만들기 →
        </button>
      </div>

      <div className="text-gray-600 text-lg">— 또는 —</div>

      {/* 방 참가 */}
      <div className="flex flex-col items-center gap-3 bg-gray-900 p-8 rounded-2xl w-full max-w-sm">
        <h2 className="text-white text-xl font-bold">방 참가</h2>
        <p className="text-gray-400 text-sm text-center">
          친구에게 받은 방 코드를 입력하세요
        </p>
        <input
          type="text"
          placeholder="방 코드 (예: ABC123)"
          value={joinCode}
          onChange={e => setJoinCode(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleJoin()}
          className="w-full py-3 px-4 bg-gray-800 text-white text-center text-xl font-mono tracking-widest rounded-xl border border-gray-700 focus:outline-none focus:border-blue-500"
          maxLength={8}
        />
        <button
          onClick={handleJoin}
          disabled={joinCode.trim().length < 4}
          className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-lg font-bold rounded-xl transition"
        >
          참가하기 →
        </button>
      </div>

      <button
        onClick={() => router.push('/')}
        className="text-gray-500 hover:text-gray-300 text-sm transition"
      >
        ← 돌아가기
      </button>
    </div>
  );
}
