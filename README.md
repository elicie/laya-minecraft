# Laya Minecraft

TypeScript Minecraft 봇 운영 시스템입니다. 중앙 시스템이 목표와 작업을 관리하고, 봇마다 독립 프로세스가 Mineflayer 공개 API로 실행합니다. Vite/React UI에서 마을 지도와 전체 목표를 보고 선택한 봇의 실제 상태와 3D 화면을 엽니다.

## 실행

Node.js 22.12 이상을 사용합니다. Minecraft Java 1.21.1에서 검증합니다.

설계도 관리까지 포함한 구현은 `feat/blueprint-catalog` 브랜치에 연결되어 있습니다. 기능별 PR을 검토하는 동안 새로 내려받는 경우 이 브랜치를 사용합니다.

```bash
git clone --branch feat/blueprint-catalog https://github.com/elicie/laya-minecraft.git
cd laya-minecraft
```

```bash
npm ci
cp .env.example .env
npm run dev
```

UI는 `http://127.0.0.1:5173`, API는 `http://127.0.0.1:3001`입니다. 처음에는 등록된 봇이 없습니다. UI에서 봇 이름과 Minecraft 서버 접속 정보를 입력해 추가합니다. 기본 접속 포트는 검증용 **25566**이며 실제 운영 서버 주소는 봇 등록 화면에서 지정합니다. 마을 중심·반경·월드·차원과 공동 창고 좌표를 설정한 후 목표를 등록합니다.

```bash
npm run build
npm start
```

빌드 후에는 `http://127.0.0.1:3001`에서 UI와 API를 함께 제공합니다. `runtime/control.sqlite`에 봇 설정·목표·설계도·체크포인트·명령·관측 기록을 저장합니다. 동일 저장 경로로 중앙 서버 두 개를 실행할 수 없습니다. 중앙 재시작 시 기존 워커 종료를 확인하고 새 월드 관측 후 남은 작업을 재개합니다. 운영 기록은 30일 보존합니다.

## 지원 범위

- 수집·창고 입출고·제작·제련, 설계도 건축, 1~8개 구획의 밀·당근·감자·비트 농사, 가축 번식.
- 사냥·적 처치·경비·탐험·따라가기·귀환·수면·생존. 경비와 사냥꾼은 확인된 위협에 선제 대응하고 다른 역할도 공격받으면 반격합니다. 불리하면 지원을 요청하고 방어하거나 퇴각합니다.
- 주 역할과 허용 작업을 고려한 배정, 안전한 중단·일시정지·제거·즉시 전환, 실제 결과 검증과 최대 5회 재시도.
- 사용자 목표를 우선하고 여유가 있는 봇에 마을 발전 목표를 생성합니다. 자율 건축은 전체 설계가 마을 반경 안에 있어야 합니다.
- 웹의 **설계도 관리**에서 기본 설계를 복제해 크기·바닥·벽·지붕·창문 재료와 가구를 수정하고 저장·수정·삭제합니다. 저장한 설계도는 목표 목록에 반영되며, 이미 등록한 목표는 등록 당시 설계를 유지합니다.

`원목 32개 모아`는 공동 창고에 총 32개를 입고하는 목표입니다. 창고에 10개가 있으면 부족한 22개를 확보합니다. `추가로 32개`와 `32개 유지`는 각각 추가 확보와 지속 보충입니다. 건축은 cabin·house·warehouse·tower·bridge·castle과 이 설계를 바탕으로 저장한 설계도를 지원하고 기존 부지의 다른 블록을 보존합니다. 평지가 없으면 관측한 얕은 자연 지형을 제한된 범위에서 깎고 메워 부지와 출입로를 준비합니다. 새로운 자유형 블록 설계, 깊거나 불안정한 지형 개척, 사망 물자 자동 회수는 추가 구현 범위입니다. 조건을 확인할 수 없으면 완료로 처리하지 않고 대기하거나 보류합니다.

Laya는 같은 우선순위의 실행 가능한 후보에서 작업을 선택합니다. 한국어의 정형 목표는 코드로 해석하고 그 밖의 입력은 Qwen으로 구조화해 UI에서 확인합니다. `.env`에서 기존 Laya `/api/decide` 서버와 Qwen Ollama 주소를 설정합니다. 응답 검증 실패·시간 초과 시 코드 판단을 사용하며 출처를 기록합니다. 이 구현 작업에서 모델 학습은 수행하지 않았습니다.

## 구조

```text
apps/server       HTTP API, SSE, 저장소, 프로세스 관리
apps/web          Vite React 운영 화면
packages/contracts 메시지와 API 스키마
packages/core     목표, 계획, 작업, 배정, 정책, 복구
packages/minecraft Mineflayer 관측과 작업 실행
packages/models   Laya 및 목표 해석 모델 연결
runtime           SQLite 상태와 계정 인증 정보 (Git 제외)
training          코드 개선과 모델 학습의 경계 설명
tests             계약, 시뮬레이션, 통합 검증
```

## 설계와 개발

- [구조와 확정한 운영 정책](docs/architecture.md)
- [메시지와 API 계약](docs/contracts.md)
- [구현 순서와 검증 기준](docs/implementation-plan.md)
- [UI 사용 방법](docs/ui.md)
- [검증 결과와 실제 실행 범위](docs/validation.md)
- [프로젝트 제약](AGENTS.md)

## 검증

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:web
MC_HOST=127.0.0.1 MC_PORT=25566 npm run test:live
```

일반 테스트는 가상 워커와 공개 API 대역으로 계약·정책·복구를 검증합니다. UI 브라우저 시나리오는 테스트 전용 API 대역을 사용합니다. 실제 서버 테스트는 별도의 Docker 컨테이너 `minecraft-laya-validation`과 포트 바인딩을 확인한 뒤 전용 구역에 관리용 재료·동물·지형을 준비합니다. 전체 생존 월드의 무재료 자율 발전 또는 실제 20봇의 성능 검증과는 구분합니다.

`main`을 새 프로젝트 기준으로 정리했고 기능별 브랜치·PR에 구현을 제공합니다. 원래 `../minecraft` 소스와 월드는 변경하지 않습니다.

Mineflayer와 외부 라이브러리의 소스나 런타임 메서드를 변경하지 않습니다. 관리용 테스트는 `minecraft-laya-validation`, 포트 **25566**에서만 실행합니다. 봇 코드의 개선과 Laya 모델 학습은 별도로 기록합니다.
