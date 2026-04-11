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
      <h1 className="text-4xl font-bold text-blue-400">🌐 Online Multiplayer</h1>

      {/* Create Room */}
      <div className="flex flex-col items-center gap-3 bg-gray-900 p-8 rounded-2xl w-full max-w-sm">
        <h2 className="text-white text-xl font-bold">Create Room</h2>
        <p className="text-gray-400 text-sm text-center">
          Create a new room and share the code with friends
        </p>
        <button
          onClick={handleCreate}
          className="w-full py-3 bg-green-600 hover:bg-green-500 text-white text-lg font-bold rounded-xl transition"
        >
          Create Room →
        </button>
      </div>

      <div className="text-gray-600 text-lg">— or —</div>

      {/* Join Room */}
      <div className="flex flex-col items-center gap-3 bg-gray-900 p-8 rounded-2xl w-full max-w-sm">
        <h2 className="text-white text-xl font-bold">Join Room</h2>
        <p className="text-gray-400 text-sm text-center">
          Enter the room code shared by your friend
        </p>
        <input
          type="text"
          placeholder="Room code (e.g. ABC123)"
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
          Join →
        </button>
      </div>

      <button
        onClick={() => router.push('/')}
        className="text-gray-500 hover:text-gray-300 text-sm transition"
      >
        ← Back
      </button>
    </div>
  );
}
