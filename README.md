# Laya Minecraft

TypeScript로 작성하는 Minecraft 봇 운영 시스템입니다. 중앙 시스템이 목표와 작업을 관리하고, 봇은 Mineflayer 공개 API로 실행합니다. Vite와 React UI에서 마을 지도, 전체 봇과 목표 현황을 보고 봇별 상세 상태와 3D 화면을 엽니다.

## 구조

```text
apps/server       HTTP API, SSE, 저장소, 프로세스 관리
apps/web          Vite React 운영 화면
packages/contracts 메시지와 API 스키마
packages/core     목표, 계획, 작업, 배정, 정책, 복구
packages/minecraft Mineflayer 관측과 작업 실행
packages/models   Laya 및 목표 해석 모델 연결
config            운영 설정
training          모델 학습 작업과 평가
tests             계약, 시뮬레이션, 통합 검증
```

## 설계와 개발

- [구조와 확정한 운영 정책](docs/architecture.md)
- [메시지와 API 계약](docs/contracts.md)
- [구현 순서와 검증 기준](docs/implementation-plan.md)
- [프로젝트 제약](AGENTS.md)

`main`은 새 프로젝트 기준으로 초기화했습니다. 구현 기능은 별도 브랜치와 PR에서 추가합니다. 실행 방법과 지원 기능은 통합 검증 결과에 맞춰 갱신합니다.

Mineflayer와 외부 라이브러리의 소스나 런타임 메서드를 변경하지 않습니다. 관리용 테스트는 `minecraft-laya-validation`, 포트 **25566**에서만 실행합니다. 봇 코드의 개선과 Laya 모델 학습은 별도로 기록합니다.
