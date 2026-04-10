@AGENTS.md

# Auto-commit & push rule
코드를 수정한 후에는 항상 자동으로 commit 하고 `git push` 까지 실행한다.
- 사용자에게 커밋/푸시 여부를 되묻지 말 것
- 논리적으로 연관된 변경은 하나의 커밋으로 묶을 것
- 커밋 메시지는 기존 스타일(`feat:`, `fix:`, `docs:` 등)을 따를 것
- push가 거부되면 `git pull --rebase` 후 재시도
- 단, 명백히 위험한 작업(force push, main 브랜치 리셋 등)은 예외로 사용자 확인을 받을 것
