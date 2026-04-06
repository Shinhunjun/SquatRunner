# 🏋️ Squat Runner

스쿼트 깊이로 캐릭터를 조종하는 웹 달리기 게임.  
웹캠으로 실시간 포즈를 감지해 3개의 트랙 중 하나를 선택하고, 구멍을 피하면서 고기를 모으세요!

**[▶ 플레이하기](https://squat-runner-web.vercel.app)**

---

## 게임 방법

| 동작 | 트랙 |
|------|------|
| 서있기 | 위 트랙 (초록) |
| 반스쿼트 | 가운데 트랙 (시안) |
| 풀스쿼트 | 아래 트랙 (빨강) |

- 어두운 **구멍**이 있는 트랙은 피하세요 — 떨어지면 목숨 1개 감소
- 낙하 후 **2초 무적** 시간 활용
- **고기(🍖)** 를 먹으면 보너스 점수 +50점
- 시간이 지날수록 속도가 빨라집니다

---

## 기술 스택

**Web (배포 버전)**
- [Next.js 15](https://nextjs.org) + TypeScript
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) — 브라우저에서 실시간 포즈 감지
- HTML Canvas 2D — 게임 렌더링
- Tailwind CSS
- Vercel 배포

**Python (로컬 버전)**
- MediaPipe Python
- OpenCV
- pygame (배경음악)
- Pillow / NumPy

---

## 폴더 구조

```
SquatRunner/
├── src/
│   ├── app/          # Next.js 페이지
│   ├── components/   # SquatGame 컴포넌트
│   └── game/         # 게임 엔진 (TypeScript)
│       ├── GameEngine.ts
│       ├── SquatDetector.ts
│       ├── Challenge.ts
│       ├── MeatItem.ts
│       ├── PlayerState.ts
│       └── constants.ts
├── public/
│   ├── img/          # 게임 스프라이트
│   └── sound/        # 배경음악
└── python/           # 로컬 실행용 Python 버전
    ├── squat_game.py
    ├── requirements.txt
    └── asset/
```

---

## 로컬 실행

### 웹 버전

```bash
npm install
npm run dev
# http://localhost:3000
```

### Python 버전

```bash
cd python
pip install -r requirements.txt
python squat_game.py
```

> Python 버전은 처음 실행 시 MediaPipe 포즈 모델(~6MB)을 자동 다운로드합니다.

---

## 요구사항

- 웹캠 (내장 또는 외부)
- 전신이 보이는 공간 (무릎~머리)
- 웹 버전: 크롬 / 사파리 최신 버전
- Python 버전: Python 3.10+
