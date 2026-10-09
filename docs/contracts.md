# 메시지와 API 계약

TypeScript 타입과 런타임 검증을 packages/contracts에 함께 둡니다. UI, API와 워커는 동일한 스키마를 사용합니다. 한 컴퓨터의 중앙과 봇 간 통신은 Node 프로세스 IPC, 브라우저 명령은 HTTP, 전체 실시간 현황은 하나의 SSE 연결을 사용합니다.

## 실행 식별

메시지는 protocolVersion, messageId, controllerEpoch, botId, sessionId, sentAt, type과 payload를 포함합니다. 작업 메시지는 taskId와 attemptId를 추가합니다. commandId는 UI 요청을 추적하고 messageId는 전송을 식별합니다. 세션과 시도를 바꾸지 않는 중복 전송은 동일 메시지 효과를 반복하지 않습니다.

새 중앙 실행은 새 controllerEpoch를 발급합니다. 새 봇 프로세스나 재연결은 새 sessionId를 사용합니다. 작업 재개와 재시도는 새 attemptId를 사용합니다. 현재 소유권과 일치하지 않는 결과를 active task에 적용하지 않습니다. 수신 시점은 중앙 시계를 기준으로 기록합니다.

## 중앙에서 봇으로

| 메시지 | 의미 |
| --- | --- |
| task.assign | 작업, 선행 조건, 완료 조건, 예약 정보 |
| task.cancel | 안전한 중단과 결과 확인 요청 |
| rules.update | 규칙 버전, 내용과 적용 시점 |
| bot.shutdown | 연결과 실행의 정상 종료 요청 |
| viewer.start / viewer.stop | 선택한 봇의 화면 연결 제어 |

## 봇에서 중앙으로

| 메시지 | 의미 |
| --- | --- |
| bot.ready / bot.status | 실제 연결 준비와 주기적 상태 |
| task.accepted / task.rejected | 작업 수락 또는 이유를 포함한 거절 |
| task.started / task.progress | 실제 시작과 현재 진행 |
| task.result | 관측, 변경된 수량, 체크포인트와 실행 결과 |
| task.cancelled | 실제 중단과 중단 전 발생한 효과 |
| task.interrupted | 응급 중단과 진행 보존 |
| world.observed | 서버, 차원, 관측 시점과 사실 |
| safety.alert | 위협, 대응, 판단 이유와 지원 필요 |
| rules.applied | 실제 적용한 규칙 버전 |
| bot.stopped / bot.error | 연결 종료 또는 실행 오류 |
| viewer.ready / viewer.stopped | 실제 화면 연결 상태 |

실행 결과는 completed, partial, condition-wait, failed, uncertain을 구분합니다. completed 보고는 중앙 검증을 시작하는 근거이며 목표 완료 여부는 완료 조건과 현재 관측으로 판단합니다.

## 브라우저 API

API prefix는 /api/v1입니다. GET /snapshot과 SSE GET /stream이 동일한 전체 상태 형식을 사용합니다. SSE event 종류는 snapshot, event, command입니다. GET /events는 보존 중인 로그 조회입니다.

명령 API는 봇 등록과 제거, 역할과 정지 상태 변경, 목표 해석과 등록·수정·취소, 마을과 규칙 변경을 제공합니다. 목표 해석은 실행을 시작하지 않고 구조화된 미리보기를 반환합니다. 목표 등록은 기본 예약이며 명시적인 executionMode로 즉시 전환할 수 있습니다.

각 명령은 commandId를 반환합니다. 유효성 검증과 영속 기록 후 accepted, 적용 진행 중 applying, 실제 확인 후 applied, 실패 시 failed를 표시합니다. HTTP 응답이나 IPC send 반환만으로 applied를 표시하지 않습니다. GET /commands/:id로 상태를 확인합니다.

POST/DELETE /bots/:id/viewer는 화면 연결을 제어하고 /viewer/:id/*는 봇별 화면을 중계합니다. 브라우저는 실제 준비된 viewer URL을 받은 뒤 연결합니다.

동일 Idempotency-Key와 동일 본문은 기존 명령을 반환하고, 같은 키의 다른 본문은 충돌로 거절합니다. 동시 규칙 수정은 현재 버전 검사로 처리합니다. 지원하지 않는 작업이나 해석되지 않은 항목은 명확한 오류 또는 미리보기 수정 항목으로 반환합니다.
