# 마을 관제실

Vite, React와 TypeScript로 구현한 마을 관리 화면입니다. 화면의 봇, 목표,
위치와 인벤토리는 중앙 API의 실제 보고를 사용합니다. 연결이 끊기면 마지막
현황임을 표시하고 변경 작업을 잠급니다. 제품 코드에 샘플 봇이나 가상 접속
상태를 넣지 않습니다.

저장소 루트에서 실행합니다.

```sh
npm run dev:web
npm run typecheck
npm run build:web
npx playwright test --config apps/web/playwright.config.ts
```

개발 화면은 `http://127.0.0.1:5173`이며 `/api`와 `/viewer`를 중앙 API
`127.0.0.1:3001`로 전달합니다. 빌드 출력은 루트의 `dist/web`입니다.

- `src/App.tsx`: 화면 구성과 사용자 변경 요청
- `src/hooks/useFleet.ts`: 초기 현황, 단일 SSE 연결과 변경 요청 상태
- `src/components/VillageMap.tsx`: 월드·차원을 구분한 실제 관측 지도
- `src/components/BotDetail.tsx`: 선택한 봇의 목표·행동·인벤토리·3D 화면
- `src/components/Forms.tsx`: 목표 해석 확인·수정, 봇·마을·규칙 입력
- `src/lib`: API 요청, 표시와 시간·URL 검증

3D 화면은 선택한 봇만 연결하며, 선택을 바꾸거나 닫으면 이전 관전을 해제합니다.
설정 변경은 요청 접수와 실제 적용 완료를 구분합니다. 목표의 수집·입고 완료
판정과 작업 소유권은 중앙 시스템에서 관리합니다.

브라우저 테스트는 격리된 HTTP·SSE 대역만 사용합니다. 자연어 목표 수정,
설정 요청, 늦은 응답의 상태 역전 방지, 관전 전환·재접속, 보고 지연과 작은
화면을 확인하며 Minecraft 월드에 접속하지 않습니다. 실제 게임 검증은
별도의 `minecraft-laya-validation:25566`에서 수행합니다.
