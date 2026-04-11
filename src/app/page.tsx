'use client';
import { useRouter } from 'next/navigation';
import SquatGame from '../components/SquatGame';
import { useState } from 'react';

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<'select' | 'local'>('select');

  if (mode === 'local') {
    return <SquatGame numPlayers={1} />;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black gap-8">
      <h1 className="text-5xl font-bold text-green-400 tracking-widest">SQUAT RUNNER</h1>
      <p className="text-gray-400 text-lg">Control your runner with squats</p>

      <div className="flex flex-col gap-4 w-72">
        <button
          onClick={() => setMode('local')}
          className="py-4 px-8 bg-green-600 hover:bg-green-500 text-white text-2xl font-bold rounded-xl transition"
        >
          🏋️ Solo Play
        </button>

        <button
          onClick={() => router.push('/online')}
          className="py-4 px-8 bg-blue-600 hover:bg-blue-500 text-white text-2xl font-bold rounded-xl transition"
        >
          🌐 Online Multiplayer
        </button>
      </div>

      <p className="text-gray-600 text-sm mt-4">Up to 4 players online</p>
    </div>
  );
}
