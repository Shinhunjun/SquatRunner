# 🏋️ Squat Runner

A web-based endless runner controlled entirely by your body — squat depth determines which of three tracks your character runs on. Dodge the gaps, collect the meat, and survive as long as you can!

**[▶ Play Now](https://squat-runner-web.vercel.app)**

---

## How to Play

| Pose | Track |
|------|-------|
| Standing | Top track (green) |
| Half squat | Middle track (cyan) |
| Full squat | Bottom track (red) |

- **Gaps** on a track will make you fall — switch lanes before you reach them
- You get **2 seconds of invincibility** after each fall — use it to reposition
- Collecting **meat 🍖** gives +50 bonus points
- Speed increases over time — stay sharp!
- Say **"시작"** (or press **Space**) to start / restart

---

## Tech Stack

**Web (deployed)**
- [Next.js 15](https://nextjs.org) + TypeScript
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) — real-time in-browser pose detection via WebAssembly
- HTML Canvas 2D — game rendering
- Web Speech API — voice command recognition
- Tailwind CSS
- Deployed on [Vercel](https://vercel.com)

**Python (local desktop version)**
- MediaPipe Python
- OpenCV
- pygame (background music)
- Pillow / NumPy

---

## Project Structure

```
SquatRunner/
├── src/
│   ├── app/            # Next.js app router
│   ├── components/     # SquatGame React component
│   └── game/           # Game engine (TypeScript)
│       ├── GameEngine.ts
│       ├── SquatDetector.ts
│       ├── Challenge.ts
│       ├── MeatItem.ts
│       ├── PlayerState.ts
│       └── constants.ts
├── public/
│   ├── img/            # Game sprites
│   └── sound/          # Background music
└── python/             # Standalone Python version
    ├── squat_game.py
    ├── requirements.txt
    └── asset/
```

---

## Running Locally

### Web version

```bash
npm install
npm run dev
# Open http://localhost:3000
```

### Python version

```bash
cd python
pip install -r requirements.txt
python squat_game.py
```

> The Python version automatically downloads the MediaPipe pose model (~6 MB) on first run.

---

## Requirements

- Webcam (built-in or external)
- Enough space for the camera to see you from knees to head
- Web version: latest Chrome or Safari
- Python version: Python 3.10+
