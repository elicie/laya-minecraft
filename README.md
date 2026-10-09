# Laya Minecraft 실험

위치: `/home/elicie/Dev/minecraft`

Laya 다국어 체크포인트를 한국어 마크 명령에 파인튜닝하고 Mineflayer에 연결한 Java 1.21.1 실험용 봇입니다.
현재는 **명령 분류·식량 판단·다섯 작업의 다음 행동 선택에 각각 학습한 Laya**를 사용하고, 재료 준비·제작 순서와 실행에는 우리 봇 코드를 사용합니다.
기본 설정은 파인튜닝한 `minecraft-ko-v1`을 localhost:8082에서 호출하며, 한국어 표현 변환을 끄고 원문을 모델에 전달합니다. 기존 Ollaya 원본은 8081에서 유지합니다.

개발 범위는 우리가 만든 봇 코드와 Laya 판단·학습입니다. Mineflayer와 외부
라이브러리는 배포 원본을 유지하며 소스 패치나 실행 중 함수 교체를 하지 않습니다.
`crafting.js`는 공개 제작 창 API로 재료를 배치하고 서버의 결과를 확인하는 우리
코드입니다. 기존 Mineflayer 설치 후 제작 동기화 패치는 제거했습니다.
`npm run test:integrity`로 Mineflayer 4.39.0 배포 파일의 해시를 검사합니다.
`npm run test:crafting-live`는 25566의 임시 서버에서 반복 2×2 제작, 작업대
도구·철검·빵·화로·상자 제작, 케이크 제작 후 빈 양동이 회수, 취소와 실제 서버
인벤토리를 검증합니다. 테스트 재료는 해당 임시 월드에만 제공합니다.

## 실행

Minecraft EULA를 읽고 동의한 경우에만 서버 실행:

```bash
cd /home/elicie/Dev/minecraft
ACCEPT_MINECRAFT_EULA=true ./server-start.sh
docker logs -f minecraft-laya-server
```

서버는 일반 난이도의 생존 모드이며 localhost와 Tailscale 주소 `100.82.139.118:25565`에만 노출됩니다.
봇 계정용으로 `online-mode=false`를 사용하므로 신뢰하는 개인 Tailscale 환경에서만 사용합니다.
Java Edition 1.21.1 클라이언트로 접속합니다. 공개 서버용 설정은 아닙니다.

2026-10-07 월드를 새로 생성하고 자연 지형의 평원 `(224, 64, 264)`을
시작 위치로 설정했습니다. 주변 17×17칸의 지면 높이가 같으며 나무까지
약 14블록, 물까지 20블록입니다. 일반 지형·동굴·광석·네더·엔드는 유지됩니다.
기존 월드와 월드에 연결된 봇 상태는 `backups/world-20261007T061937Z/`에
보관했습니다. 이전 월드의 농장·건물·사망 위치·목표 진행은 새 월드로 옮기지
않았습니다. 실제 높이 검사 결과는 `artifacts/plains-spawn.json`에 있습니다.

`.env`의 `MC_OWNERS`에 본인 게임 닉네임을 적고 실행:

```bash
./run.sh
```

허용 닉네임이 비어 있으면 게임 채팅은 받지 않으며 봇 터미널 입력만 가능합니다.
기존 서버를 사용하려면 `.env`의 `MC_HOST`, `MC_PORT`, `MC_VERSION`, `MC_AUTH`를 수정합니다.
계정 인증 서버는 `MC_AUTH=microsoft` 및 봇이 사용할 계정의 로그인 과정이 필요합니다.

## 명령

게임 채팅:

- `laya 따라와`
- `laya 이리 와`
- `laya 나무 캐 줘` (총 8개 확보)
- `laya 나무곡괭이 만들어`
- `laya 돌곡괭이 만들어`
- `laya 철곡괭이 만들어`
- `laya 인벤토리 보여줘`
- `!stop` (모델을 거치지 않고 즉시 중지)

명령 분류를 건너뛰는 명시적 명령: `laya !wood`, `laya !wooden_pickaxe`, `laya !stone_pickaxe`, `laya !iron_pickaxe`, `laya !status`.
터미널에서는 `laya` 접두사 없이 입력합니다.

## 검증

```bash
export PATH=/home/elicie/tools/node22/bin:$PATH
npm run check
npm test
```

`npm test`는 `.env`의 모델 엔드포인트에 실제 요청하여 7개 기본 명령과 실행 기준 확률을 확인합니다. 이 문장들은 학습에도 등장하므로 회귀 검사이며 일반화 평가가 아닙니다.
이는 게임 내 이동·채굴·제작 성공 검증을 대신하지 않습니다.

채집은 불러온 지형의 48칸 안에서 후보를 고르고, 실패 위치를 제외하며 도구와 내구도를 확인합니다.
탐색은 방문 구역과 자원 좌표를 저장하고 위험 블록과 주변 적을 피하는 경로를 시도합니다.
자동 목표는 재료 부족 시 탐색 후 재시도합니다. 복잡한 동굴과 먼 구조물은 수동 보조가 필요할 수 있습니다.

`logs/events.jsonl`에 원문 명령, 변환된 명령, Laya 확률, 실행 결과, 소요 시간을 기록합니다.
게임에서 `laya 정답 철곡괭이`처럼 말하면 해당 사용자의 마지막 모델 판단에 교정 정답을 붙입니다. 로그만으로 모델이 자동 학습되지는 않습니다.

서버 중지: `docker stop minecraft-laya-server`
서버 재개: `docker start minecraft-laya-server`
봇 중지: 터미널에서 Ctrl+C

공식 문서:
- https://github.com/PrismarineJS/mineflayer
- https://github.com/PrismarineJS/mineflayer-pathfinder
- https://github.com/ollaya-dev/ollaya/blob/main/docs/api.md
- https://www.minecraft.net/eula

## 실제 학습 및 교정 흐름

첫 실험: `training/runs/minecraft-ko-v1/report.json`

- 원본: `convaiinnovations/laya`, multilingual, revision `aa8c91ca088ec597df95a0d1c76b3063cb2ae5e8`.
- 데이터: 직접 작성한 합성 예문 180개 중 144개 학습, 36개 확률 보정. 별도 평가 54개.
- 목표: 한국어/영어 명령을 9가지 행동으로 분류. 인코더와 기존 판단 헤드 모두 파인튜닝, soft cross-entropy 10 epochs.
- 원문 평가: 30/54 (55.6%) → 46/54 (85.2%). 원문을 영어로 바꾸는 규칙은 평가와 학습 모델 실행에 사용하지 않음.
- 이 결과는 작은 합성 명령 평가이며 실제 게임 성공률이 아님. 따라오기/이리오기 구분, 일부 곡괭이 표현에 여전히 실패. 확률 보정도 36개라 제한적.
- `smoke-test.js`의 7문장은 기본 동작 회귀 검사이며 별도 일반화 성능에 포함하지 않음.

교정 가능한 정답: `따라오기`, `이리와`, `나무`, `나무곡괭이`, `돌곡괭이`, `철곡괭이`, `상태`, `중지`, `기타`.
예: `laya 정답 돌곡괭이`. 모델이 마지막으로 해석한 명령의 정답을 저장하며 행동을 다시 실행하지 않습니다.
봇 터미널에서는 `정답 돌곡괭이`만 입력합니다. 게임 접속 전에는 판단 기록 ID로도 교정 가능:

```bash
/home/elicie/tools/node22/bin/node feedback.js <decision-id> 돌곡괭이
```

정답은 `training/data/corrections.jsonl`에 저장합니다. 고정 평가 문장은 교정 학습에 들어가지 않도록 차단합니다.
다음 학습은 새 이름으로 실행합니다. 기본값은 원본+기존 seed+교정 예문 전체를 학습하여 이전 지식을 함께 복습합니다.

```bash
./train.sh --name minecraft-ko-v2
```

평가 파일을 정답 암기에 사용하거나 실패 문장을 그대로 학습으로 옮기지 마세요.
차후 평가 결과를 반복해서 보고 개선한다면 새로운 미사용 최종 평가셋도 따로 마련해야 합니다.
학습 결과는 별도 체크포인트로 보존하며 실행 모델을 자동 교체하지 않습니다.
검토 후 `~/.config/systemd/user/minecraft-laya-model.service`의 체크포인트 경로를 바꾸고 daemon-reload/restart합니다.
기존 이름으로 학습하면 덮어쓰기 대신 거부합니다.

```bash
systemctl --user status minecraft-laya-model
journalctl --user -u minecraft-laya-model -n 30
systemctl --user restart minecraft-laya-model
```

프로젝트 Python 환경은 `.venv`, Laya 소스는 `vendor/laya`에 고정한 git checkout입니다.
용량 중복을 피하기 위해 기존 ComfyUI 환경의 torch/transformers 패키지를 `.pth`로 읽어 사용합니다.
ComfyUI 패키지를 변경하지 않았지만 그 환경을 삭제하거나 업그레이드하면 이 학습 환경도 재검증해야 합니다.
GPU 학습과 게임 내 기본 동작 검증은 별도로 수행했습니다. 모델 평가 점수는 명령 분류 성능입니다.

### 게임 상태를 보고 식량 행동을 선택하는 Laya

`minecraft-food-v1`은 명령 분류 모델과 별도 체크포인트입니다. 체력·허기,
먹을 식량·생재료·밀, 관측한 동물·익은 작물·농장 상태, 실패한 행동을 받아
섭취·조리·빵 제작·사냥·농사·탐색·성장 대기·목표 계속·회복 대기 중 하나를
고릅니다. `survival-policy.js`가 모델을 호출하고 실행 가능 여부와 확률을
검증합니다. `food-manager.js`가 기존 스킬을 실행하고 결과를 확인합니다.
모델이 응답하지 못하거나 검증에 실패하면 기본 복구 경로를 사용하며,
이 경우 웹과 로그에 Laya의 선택으로 표시하지 않습니다.

실제 학습 결과: `training/runs/minecraft-food-v1/report.json`.
직접 작성한 합성 상태 540개 중 432개 학습, 108개 확률 보정으로 인코더와
판단 헤드를 8 epochs 지도학습했습니다. 별도 합성 평가 108개에서는
13/108 (12.0%) → 108/108 (100%)였습니다. 좁은 식량 판단 과제의 합성 평가이며
Minecraft 생존 성공률이나 전체 행동 계획 능력의 측정은 아닙니다.
기존 한국어 명령 모델과 Qwen 목표 해석 모델은 유지합니다.

`minecraft-laya-policy.service`가 localhost:8083에서 이 모델을 제공합니다.
웹 **Laya 상황 판단 · 식량**에서 현재 관측 상태의 판단과 정답 교정을 확인합니다.
**현재 상황 판단**은 실제 행동을 실행하지 않습니다. **정답 저장**은 해당
상태에 대해 사람이 선택한 정답을 `training/data/food/corrections.jsonl`에
저장합니다. 고정 평가 상태와 당시 실행 불가능했던 행동은 교정으로 받지 않습니다.
다음 학습은 기존 합성 예문과 교정 데이터를 함께 사용합니다.

```bash
.venv/bin/python training/food-run.py --name minecraft-food-v2 --epochs 8
```

새 체크포인트를 별도로 평가·검토한 후 서비스의 `--checkpoint` 경로와
웹의 평가 보고서 경로를 새 버전으로 바꾸고 서비스를 재시작해야 합니다.
기존 결과는 덮어쓰지 않으며 교정 저장만으로 실행 모델이 바뀌지 않습니다.

`logs/policy-experiences.jsonl`에는 에피소드 ID, 관측 상태, 실제 선택,
실행 후 상태, 성공·오류·취소·사망, 확률, 소요 시간, 임시 보상 분해를 저장합니다.
보상은 허기 회복·식량 증가를 더하고 피해·사망·실패·시간을 빼는 실험용 값입니다.
자동 정답으로 취급하지 않으며, 현재 이 보상으로 모델 가중치를 갱신하는
강화학습은 구현하지 않았습니다. 안전한 식량 선택과 재고 확보는 먼저
지도학습 및 실제 플레이 교정으로 개선하고, 장기 행동의 강화학습은 별도
테스트 월드에서 보상 편법과 생존 실패를 검증하며 추가하는 방향입니다.

### 농사·건축·채집·탐색·전투의 지도학습

`minecraft-activity-v1`은 다섯 종류의 목표에서 다음 행동을 선택하는 별도
Laya 체크포인트입니다. 기존 명령 분류·식량 모델은 유지합니다.
`activity-manager.js`가 실제 게임 관측을 만들고, `activity-policy.js`가
Laya를 호출하여 실행 가능한 행동과 확률을 확인합니다. 실행 직전에도
관측이 바뀌었는지 검증합니다. 준비물의 실제 획득, 경로 이동, 블록 배치,
타격은 기존의 우리 스킬 코드가 담당합니다. Mineflayer 소스는 변경하지 않습니다.

| 목표 | 학습된 행동 선택과 실행 연결 |
| --- | --- |
| 농사 | 괭이·밀 씨앗 준비, 농사·수확, 성장 대기, 물·작물 탐색, 수확량 확인 |
| 건축 | 부지 조사, 다음 배치에 부족한 재료 확보, 건축, 실제 구조·가구 완성 확인 |
| 채집 | 채굴 도구 준비, 관측한 후보 채집, 실패 후보를 피해 탐색, 실제 재고 확인 |
| 탐색 | 미방문 지형 조사, 요청 자원의 실제 좌표 확인 |
| 전투 | 무기 준비, 대상 대기, 적대 몹 전투, 위험 시 퇴각, 서버 확인 처치 수 집계 |

공통 행동에는 식량 회복과 중지가 있습니다. 허기 회복은 식량 판단용 Laya에
연결합니다. 플레이어와 중립 몹은 자동 경비 대상에서 제외합니다. 모델이
완료를 선택해도 실제 목표 재고·수확량·건물 상태가 확인되어야 완료합니다.
오래 기다리는 농장도 근처 위험이 생기면 다시 판단합니다.

실제 학습 보고서: `training/runs/minecraft-activity-v1/report.json`.
직접 작성한 합성 상태 720개 중 576개 학습, 144개 확률 보정으로 인코더와
판단 헤드를 8 epochs 지도학습했습니다. 별도 합성 평가 180개에서는
65/180 (36.1%) → 177/180 (98.3%)였습니다. 전투 준비물 확보 판단 3개에서
오류가 남았습니다. 실행 불가능한 선택은 기본 복구 경로로 바꾸며 로그와
웹에 모델의 선택과 구분해 표시합니다. 이 평가는 좁은 합성 상황 분류이며
실제 Minecraft 목표 완료율이나 전체 생존 능력의 측정이 아닙니다.

모델은 `minecraft-laya-activity.service`로 localhost:8084에서 실행합니다.
자동 목표로 다섯 작업을 실행하면 Laya가 판단하며, 다른 목표의 실행 방식은
기존 흐름을 사용합니다. 엔더드래곤 전체 계획이나 임의 건축 설계를 새롭게
학습한 모델은 아닙니다.

웹 **Laya 다음 행동**의 선택 상자와 **상황 판단**은 현재 게임 상태를
선택한 목표에 대입하는 미리보기입니다. 저장된 목표와 실제 행동을 바꾸지
않습니다. **정답 저장**은 당시 실행 가능한 행동의 교정 정답을
`training/data/activity/corrections.jsonl`에 저장합니다. 고정 평가 상태는
교정 학습에 들어갈 수 없습니다. 실행 전후 상태·준비물·인벤토리·실패·취소는
`logs/activity-experiences.jsonl`에 보관하지만 자동 정답으로 사용하지 않습니다.

```bash
.venv/bin/python training/activity-run.py --name minecraft-activity-v2 --epochs 8
```

다음 학습에는 기존 예문과 명시적으로 교정한 데이터만 들어갑니다. 새 모델의
평가·실행 검증 후 서비스 체크포인트 경로와 웹 보고서 경로를 함께 바꿔야
적용됩니다. 교정 저장만으로 가중치를 갱신하거나 강화학습을 실행하지 않습니다.
직접 검증하고 검토한 실제 실패 예시는 `training/data/activity/reviewed.jsonl`에
별도로 저장합니다. 검토자·이유·증거 파일과 해시가 필요하며, 로그를 자동
정답으로 변환하지 않습니다. 이번 검증에서 농사 시작 전 괭이 준비를 놓친
사례 한 개를 검토해 보관했습니다. 아직 실행 모델 v1의 가중치에는 반영하지
않았으며 다음 학습에서 기존 예문·웹 교정과 함께 사용합니다.

`npm run test:activity-live`는 25566의 임시 검증 서버만 사용합니다. 준비한
재료와 지형으로 실제 모델의 행동 선택, 괭이 제작, 파종·수확·재파종,
건축·가구, 적대 몹 처치, 원목 재고 증가와 실제 이동·철 좌표 발견을 확인합니다.
테스트 준비물은 목표 실행 사이에만 제공하며 목표 실행 중 재료를 주입하지
않습니다. 모든 준비물의 자율 획득이나 임의 생존 월드에서의 완주 검증은 아닙니다.
`tests/activity-safety-live.cjs`는 같은 임시 서버의 NoAI 크리퍼 상황에서 실제
학습 모델의 퇴각 선택과 안전거리 이동을 확인합니다.

## 웹 관전 · 명령 · 교정 화면

같은 Tailscale에서 **http://100.82.139.118:3000/** 로 접속합니다.
서버 자체에서는 http://127.0.0.1:3000/ 도 가능합니다.

- 서버가 없어도 모델의 **판단만 테스트**, 확률 확인, 정답 교정을 사용할 수 있습니다.
- 마크 서버 실행 후 **봇 연결**을 누르면 웹 서비스가 봇을 실행합니다. 실패하면 15초마다 재접속합니다.
- 봇 접속 후 1인칭 관전, 체력·허기·인벤토리·좌표, 작업 로그를 표시합니다.
- **실행**은 게임 행동, **판단만 테스트**는 모델 분류만 수행합니다.
- **정답 저장**은 최근 판단의 교정 데이터를 저장하며 즉시 학습하거나 행동을 다시 실행하지 않습니다.
- **즉시 중지**는 작업을 멈추고, **연결 해제**는 봇 접속과 재시도를 종료합니다.
- 따라오기/이리오기는 플레이어 선택칸으로 대상 지정이 가능합니다.
- 웹에서 봇을 실행하는 동안 `./run.sh`로 같은 봇을 중복 실행하지 마세요.

웹 서비스는 `minecraft-laya-web.service`이며 로그인 사용자 서비스로 자동 시작합니다.
관전 렌더러는 봇 접속 시 localhost:3008에 생성하고, 같은 웹 주소의 `/view/`로 프록시합니다.
3000 포트는 localhost와 위 Tailscale IP에만 바인딩합니다.
허용 호스트에 `gti12-1:3000`도 추가해 `http://gti12-1:3000/`에서 접속할 수 있습니다.

```bash
systemctl --user status minecraft-laya-web
systemctl --user restart minecraft-laya-web
journalctl --user -u minecraft-laya-web -n 30
```

브라우저 화면은 Prismarine Viewer가 게임 상태를 재구성한 것이며 실제 Minecraft 클라이언트 영상 스트리밍은 아닙니다.
실제 게임 접속 전에는 관전 화면이 대기 상태입니다.

## 사망 후 자동 복구

사망하면 현재 작업을 취소하고 사망 좌표·차원·소지품·진행 중이던 목표 단계를
저장합니다. Mineflayer의 기본 자동 리스폰을 그대로 사용하고, 실제 `spawn`
이벤트를 받은 뒤 주변 위험을 확인합니다. 근처 적이 있으면 먼저 퇴각합니다.
같은 차원에서 사망 지점이 96블록 이내이고 드롭을 회수할 시간이 남아 있으면
접근해 실제 인벤토리 증가와 남은 드롭을 확인합니다. 회수 경로는 최대 두 번
시도하며, 위험·다른 차원·거리·소실 가능성 때문에 회수하지 못한 이유를 남깁니다.
그 뒤 사망 전 자동 진행이 켜져 있었다면 같은 목표와 단계로 이어갑니다.
체력 부족으로 중지된 직후 사망한 경우에도 이전 목표를 보존합니다.

웹의 **사망 후 복구**에서 리스폰·위험 회피·회수·목표 재개 상태를 확인합니다.
사망 직후에도 **즉시 중지** 또는 **자동 중지**로 복구를 취소할 수 있습니다.
다른 목표를 받았거나 자동 목표 없이 사망한 경우 이전 목표를 임의로 시작하지
않습니다. 2분 안에 세 번 사망하면 목표를 보존하고 30~120초 동안 안전 대기합니다. 주변 적과 체력을 다시 확인한 뒤 같은 목표를 재개하며, 반복 사망 지점의 회수는 생략합니다.
이 처리는 우리 봇의 복구 로직이며, 새 모델을 학습한 변경은 아닙니다.

`npm run test:death-live`는 실제 `bot.js`를 별도 서버 25566에서 실행하고,
체력 부족 중지 → 사망 → 리스폰 → 사과 5개와 돌곡괭이 회수 → 동일 목표
재개 및 사망 직후 중지를 검증합니다. `BOT_LOG_DIR`로 월드 상태와 로그를
분리하며, 실제 사용자 월드에는 테스트용 관리자 명령을 실행하지 않습니다.
검증 기록은 `artifacts/death-recovery-live.json`에 보관합니다.
웹 검증: `tests/web-smoke.cjs` (Playwright 경로는 `PLAYWRIGHT_PATH` 환경변수로 지정 가능).
전송 검증: `tests/viewer-proxy.cjs`는 명시적인 가상 봇으로 HTTP/WebSocket 경로만 확인합니다.

## 자동 진행

웹의 **자동 진행 → 목표 실행**에 원하는 결과를 입력합니다.
예: `나무 32개 채집해줘`, `밀 농장 계속 관리해줘`, `작은 집 지어줘`, `재료 모아서 철 무기 만들어줘`.
게임/터미널에서는 `!auto` 뒤에 목표를 적습니다. 여러 작업은 순서대로 실행하고 필요한 재료와 도구를 계산합니다.
자주 쓰는 표현은 규칙으로 해석하고, 나머지는 Qwen3.5:9b가 검증 가능한 작업 목록으로 변환합니다.
Laya는 기본 명령 분류, 식량 판단, 농사·건축·채집·탐색·전투의 다음 행동 선택을 담당합니다. 생존 판단 전체를 학습한 모델은 아닙니다.
작업이 막히면 후보를 바꾸거나 탐색해서 재시도하고, 여섯 차례 복구 실패 시 목표를 저장한 채 대기합니다.
체력이 위험하면 작업을 중단하고 목표를 보존합니다. 사망 후에는 리스폰·위험 확인·회수를 거쳐 같은 목표를 자동 재개합니다. 수동으로 멈춘 목표는 **저장된 목표 이어가기**로 다시 시작하며, `!stop`으로 즉시 중지합니다.
서버나 봇을 재시작해도 저장한 목표는 유지하지만 자동 실행을 재개하지 않습니다.
경로 이동 시 일부 자연 블록을 제거할 수 있고 3칸을 넘는 낙하는 피합니다.

### Qwen planning model runtime

A separate local Ollama service (`minecraft-ollama.service`, user systemd) serves
`http://127.0.0.1:11434`. Its executable is
`/home/elicie/tools/ollama/bin/ollama` and model storage is `models/ollama/`.
The requested model is `qwen3.5:9b`; this runtime is separate from Ollaya/Laya.
Context is limited to 8192 tokens and one parallel request. Downloading the model
alone does not connect it to the Minecraft planner or train it on gameplay.

Check models with `/home/elicie/tools/ollama/bin/ollama list` and inspect service
logs with `journalctl --user -u minecraft-ollama`.

### Automatic goals and survival campaign

`missions.js` is the current executor. Common Korean requests are parsed with
explicit rules; other sentences use Qwen3.5:9b structured output. Validated goals
form a persistent ordered queue. Example: `!auto 상자 만들고 조약돌 16개 보관해줘`
creates a chest, acquires any missing cobblestone, then deposits 16 blocks.
`!auto 이어가기` resumes a stopped queue. New goals replace the queue; `!stop`
cancels the model request and invalidates running actions. A disconnected/restarted
bot does not automatically restart a saved mission. The earlier `qwen-planner.js`
and `survival-plan.js` remain for compatibility with basic tool commands/tests.

- `acquisition.js`: registry recipe selection, recursive material/tool acquisition,
  furnace smelting and mob drops. Ingredient reservations are checked again when
  subrecipes consume materials. Every target is checked against actual inventory.
  Registry items without a registered acquisition route report the missing route.
- `survival-skills.js` / `combat.js`: food, cooking, equipment selection that
  preserves better worn armor, prioritized hostile combat, attack cooldowns,
  shield approach, low-health/multiple-enemy retreat and creeper bow attacks.
  Neutral mobs are excluded from automatic defense; players cannot be attacked.
  Kills require server death events. Complex ranged combat remains experimental.
- `world-skills.js` / `farming.js`: wheat, carrot, potato and beetroot plots,
  water/soil survey, bucket irrigation, mature-only harvest and replanting;
  chest deposit/withdraw, sleep and death-drop recovery. Continuous farm goals
  inspect every 30 seconds while crops grow normally. Non-wheat crops require
  initial seed/produce stock or a nearby mature crop; seeds cannot be invented.
- `structures.js`: cabin (5×5), house (7×7), warehouse (7×5 with chests), tower
  (5×5 with ladder), short bridge (3×9), European castle (15×15 with four towers,
  ladders, crenellated walls, courtyard, gate and furnished keep). Empty or natural vegetation sites are
  surveyed, limited earth leveling/filling performed, and up to 12 cells placed
  per batch. Doors, three windows and suitable furniture/lighting are part of
  completion; the larger house has a stepped gable roof. Material palettes use
  observed wood types. Scaffolding may remain; arbitrary architecture and large
  terrain leveling are not implemented.
- `resource-collector.js` / `exploration.js`: exact inventory targets, matching
  drop pickup, tool/durability and bag-space checks, temporary exclusion of failed
  candidates, visited sectors and observed resource coordinates. A resource
  search completes only when actual loaded-world coordinates are found.
- `campaign.js` and `endgame.js`: persistent progression through tools, food, iron
  equipment, obsidian/portal, Nether travel, fortress/blaze search, pearls (combat
  or barter), eyes, eye-direction triangulation, portal activation and End combat.
  Ranged combat, scaffold access and iron-bar removal are experimental. Dragon
  success requires the server entity-death event; disappearance is not success.
  The whole campaign has NOT been verified end to end. Exploration only sees
  loaded chunks; difficult routes may need manual assistance.

Each action is bounded and cancellation-aware. After six failed work/recovery
attempts, the queue pauses with the error and retains its position. Low health
also pauses. Survival is a continuous goal. Completion is based on game state,
not on model prose. Historical campaign achievements and current readiness are
shown separately. State files are `logs/mission.json`, `logs/campaign.json`,
`logs/structures.json`, `logs/endgame.json`, `logs/farms.json` and
`logs/exploration.json`; these belong to this project's
current Minecraft world and must be archived/reset when switching worlds.

Food recovery interrupts any queued goal when hunger falls below 18/20 and keeps
the original request and queue position. It eats only safe food actually present
in inventory. Otherwise it cooks raw meat/fish/potatoes, makes bread from existing
wheat, retrieves cooked furnace output, hunts animals, or harvests/manages a farm.
Blocked hunting/farming routes fall back to surface food exploration; missing
cooking materials use resource exploration. Growing crops wait for a scheduled
check without consuming failure retries, and newly available food wakes that wait.
Once fed, the bot continues the original goal. These routes still depend on
reachable terrain and available animals, crops and crafting resources.

The server world was reset on 2026-10-06 at the user's request, with the old world
and world-specific bot state archived to `backups/world-20261006T171633Z/`.
The recreated server uses normal survival difficulty and a new random world.

The web dashboard shows ordered goals, material dependencies, verified structure
block counts, campaign stages, actual inventory/equipment/durability, and live
first-person viewing. Farm plots/growth/water, nearby threats, gathering targets,
visited sectors and discovered resource coordinates are also displayed, along
with the current food recovery phase, available safe food and cooking source.
The 1.21.1 catalog supplies item recipes/textures. Inventory
slots are inspection-only. Commands execute on the server, not through vision.

Validation: `npm run check`, `npm run test:planner`. On the previous survival world,
wood/stone tools, iron mining/smelting/sword, stone hoe, chest creation/deposit and
all 96 blocks of a cabin were verified. New endgame features remain experimental.
In the isolated validation world, actual server interactions verified wheat
tilling/planting on 24 plots, mature harvest and replanting, bucket filling/new
irrigation/carrot planting on 24 plots, a cabin's 98 structural blocks and 7
furniture/lighting blocks, armored melee with a server-confirmed husk death,
four-log collection, visited-sector persistence and cancellation. Administrative
fixtures supplied materials/mature crops; this does not prove autonomous gathering
of all farm or building prerequisites in the new survival world.
`tests/live-dashboard.cjs` checked the running bot's viewer, six activity panels,
inventory and desktop/mobile layout with no page errors or mobile overflow.
Gameplay logs are
saved for review; they do not retrain a model automatically. Existing Laya training
scores measure command classification, not Minecraft success rate.

Advanced goal examples: `밀 농장 계속 관리해줘`, `밀 16개 수확해줘`,
`나무 32개 채집해줘`, `철광석 찾아줘`, `주변 경비해줘`, `넓은 집 지어줘`.
Use `!auto` before these in the terminal/game, or enter them in the web automatic
goal field. Continuous goals run until stopped; use a new goal or `!stop` to change.

`npm run test:advanced-live` is deliberately restricted to an isolated validation
server on port 25566 named `minecraft-laya-validation`. Its administrative fixture
setup clears that test area, supplies materials and matures crops. It verifies
server interactions, not autonomous acquisition of all building materials, and
must never target the user's main survival world.

`npm run test:food-live` uses the same isolated server restriction. Fixtures supply
raw mutton, wood fuel, an existing furnace and a queued goal's item, then induce
hunger. Assertions verify actual furnace cooking, consumption, server hunger
updates and resuming the preserved goal after eating. It does not prove autonomous
acquisition of every cooking prerequisite in arbitrary terrain.
The food test now calls the actual trained `minecraft-food-v1` service on 8083,
asserts Laya selected cooking and eating rather than fallback, and records
state/action/outcome transitions and provisional rewards in
`artifacts/food-policy-live.json`. These experiences are not automatic correct labels.
On 2026-10-07 the main survival bot also hunted sheep, cooked two mutton, ate them
and recovered from 11/20 hunger to 20/20 before continuing its saved dragon goal.
No food or cooking materials were injected into that world for this verification;
the observed inventory and goal events are in `artifacts/food-recovery-main.json`.

## 목표 사이의 자율생활

목표가 완료되거나 작물 성장·경로 복구를 기다리는 동안 식량 비축·섭취,
돌곡괭이 준비, 익은 농장 수확, 목재와 드롭 회수, 거점 복귀와 생활권 탐색을
이어갑니다. 실패한 생활 행동은 잠시 제외하고 다른 활동을 선택합니다.
자동으로 진행 중이던 목표가 막히면 요청과 현재 단계를 보존하고 생활 활동
후 재시도합니다. 명시적으로 멈춘 목표는 자동 재시도하지 않습니다.

웹의 자율생활 버튼 또는 `자율생활 켜기` / `자율생활 끄기`로 제어합니다.
생활 활동 중 새 목표를 입력하면 현재 활동을 취소하고 새 목표부터 처리합니다.
`!stop`과 웹의 중지 버튼은 목표와 자율생활을 모두 중단합니다. 생활 활동의
실제 시작·결과·이동 좌표·인벤토리와 목표 재시도는 이벤트에 기록합니다.
회복이 필요하거나 모든 이동 경로가 막히면 위험과 자원 관측을 계속하며
재확인 시간을 관리합니다.

`npm run test:routine-live`는 별도 25566 월드에서 실제 제작 이후 이동,
새 명령 우선 처리, 생활 토글의 목표 보존, 실제 사망 후 생활 재개, 전체 중지를
검증합니다. 이 기능은 우리 봇 코드 개선이며 Laya 가중치를 새로 학습하지 않았습니다.
유럽풍 성은 `유럽풍 성 지어줘` 또는 `!auto 성을 지어줘`로 실행합니다.
15×15 고정 설계이며 네 모서리 탑·사다리·성벽 흉벽·성문·안뜰과 박공지붕 본관,
침대·상자·작업대·화로·조명을 포함합니다. 웹 설계 선택과 단계별 진행률에서
확인할 수 있습니다. 부지·진행은 기존 건물처럼 저장하고 사망 후 이어짓습니다.
궁전·성당·아파트와 임의 크기·양식 생성은 지원하지 않습니다.

미니맵은 공개 `blockAt` 관측으로 봇 주위 지형을 일정 간격으로 샘플링하고
북쪽 고정 방향으로 표시합니다. 위치·방향, 플레이어·적·동물, 농장·건물·사망
위치를 함께 표시하고 확대·축소할 수 있습니다. 미관측 청크는 어둡게 표시하며
지표 전체를 미리 알아내는 지도는 아닙니다. 지형은 2블록 간격, 높이는 봇 주위
관측 구간을 사용하므로 동굴과 매우 높은 지형에서는 상세 지표 지도와 다를 수 있습니다.

`npm run test:castle-live`는 별도 25566 월드에서 재료를 미리 제공하고 실제 성 건축,
사망 후 같은 성 이어짓기, 구조·가구 완공과 미니맵 관측을 검증합니다. 이번 추가는
우리 코드 개선이며 Laya 모델 가중치는 재학습하지 않았습니다.
`npm run test:castle-inspection-live`는 완공 후 성문·본관 출입과 공개 컨트롤을 통한
실제 탑 사다리 오르기를 확인하고 실제 월드 관전 이미지를 저장합니다.

`집으로 가`, `기지로 돌아가`, `거점 복귀해줘`, `!home`은 저장된 집으로 귀환합니다.
완성된 집은 출입문을 지나 실내로, 미완성 집은 건축 부지로 돌아갑니다.
`성으로 돌아가`는 저장된 성을 선택합니다. 집이 없으면 이유를 알리고 건축을 시작하지 않습니다.
웹 명령 영역의 ‘집으로 가기’ 버튼으로도 입력할 수 있습니다. 완성된 집을 우선하고,
완성된 집이 없으면 넓은 집·작은집·성 순으로 등록된 부지를 선택합니다.
`npm run test:home-live`는 완성된 25566 시험 성에서 실제 명령·문 통과·실내 도착을 검증합니다.

## 집 설계와 이어짓기

작은집과 넓은 집은 조약돌 기초, 목재 바닥, 원목 기둥, 여섯 창문 블록, 현관, 속이 빈 박공지붕과 침대·상자·작업대·화로·횃불을 포함합니다. 웹 설계 미리보기는 같은 좌표 설계로 그리며, 회전과 내부 보기를 제공합니다. 미리보기는 실제 완공 화면이 아닙니다.

건축 상태는 월드에서 실제 관측한 블록과 가구로 계산합니다. 청크 밖에 있는 건물은 미관측으로 표시하고, 다시 접근한 뒤 재료와 진행을 판단합니다. 이동 중에는 기록된 기초와 건물 블록을 보호하며, 출입문은 우리 코드의 공개 이동·블록 사용 API로 통과합니다. 죽거나 재료가 부족해도 부지와 설계를 저장하고, 재개할 때 이미 설치한 부분을 건너뜁니다. 기존에 짓던 이전 설계는 보존하고, 아직 블록을 하나도 놓지 않은 계획만 새 설계로 전환합니다.

`npm run test:house-death-live`는 25566 별도 월드에서 재료를 미리 준비한 뒤 실제 집짓기 중 사망, 아이템 회수, 같은 목표·부지·진행 보존, 완공과 지붕 내부·문·침대 방향을 검증합니다. 일반 생존 월드에서 모든 재료를 스스로 확보하는 성공률을 의미하지 않습니다. 이 변경은 봇 코드 개선이며 Laya 재학습은 아닙니다.


## 식량 계획과 자율 방어

식량이 없거나 비축 목표보다 적으면 Qwen3.5:9b가 보유 재료, 익은 농장 작물,
주변에 실제로 관측한 동물 중에서 확보할 음식과 순서를 선택합니다. 예를 들어
밀 수확 → 빵 제작 → 섭취 또는 돼지 사냥 → 고기 회수 → 조리 → 섭취입니다.
웹의 식량 상태에는 선택한 음식, 단계와 이유를 표시합니다. 계획은 실행 전에
다시 관측해 확인하고, 찾지 못한 음식·동물·좌표를 만들어내면 거부합니다.
Qwen 요청은 백그라운드에서 진행합니다. 허기가 낮으면 보유 음식 섭취,
보유 밀·생재료 처리, 익은 작물 수확을 먼저 실행하므로 추론을 기다리다 굶지 않습니다.

익은 작물 수확에는 괭이를 요구하지 않습니다. 긴급 식사용 수확은 빵 한 개에
필요한 밀 3개 등을 먼저 확보한 뒤 식사로 돌아가고, 경작·재파종은 이후에 처리합니다.
체력이 낮아도 식량 확보와 섭취는 허용하고, 배고픈 동안 도구·목재 작업을 미룹니다.

무기는 현재 사용할 수 있는 검·도끼를 우선 활용합니다. 없으면 보유 철 또는
조약돌로 검을 제작하고, 해당 재료가 없으면 나무검부터 준비합니다. 자율생활은
허기·체력이 회복되고 무기가 있는 상태에서 가까운 단일 근접 적을 상대합니다.
크리퍼·다수 적·낮은 체력은 퇴각하며, 처치는 서버의 실제 사망 이벤트로 확인합니다.

`npm run test:nutrition-live`는 별도 25566 시험 월드에서 실제 Qwen의 음식 선택,
괭이 없는 수확·빵 제작·허기 회복, 무기 제작·장착·처치를 확인합니다. 작물·판자·
작업대와 적은 시험 환경에 미리 준비합니다. 실제 월드의 전반적인 생존 성공률을
뜻하지 않습니다. 이 기능은 봇 코드와 Qwen 추론 연결이며 Laya 가중치 재학습은 아닙니다.

## 목표 실행 중 피격 대응

우리 봇의 `threat-response.js`가 0.2초마다 피격과 실제 관측한 가까운 적을
확인합니다. 채집·이동·제작·건축 등 진행 중인 작업을 공개 API로 취소하고,
기존 작업이 이동 제어와 제작 창을 정리한 뒤 방어 또는 후퇴를 실행합니다.
목표, 작업 순서, 같은 단계 번호와 이미 모은 재료·설치한 블록은 보존합니다.
위험으로 취소한 행동은 목표 실패나 지도학습용 실패 결과로 기록하지 않습니다.

체력 14 이상, 허기 18 이상, 사용 가능한 검·도끼가 있고 가까운 단일 근접
적이면 방어합니다. 크리퍼·원거리 적·다수 적 또는 준비가 부족한 상황에서는
후퇴합니다. 적과 거리를 확보한 뒤 식사·체력 회복·추가 피격 여부를 확인하고
원래 목표의 같은 단계부터 자동으로 이어갑니다. 회복용 식량 확보 도중에도
다시 적이 접근하면 작업을 취소합니다. 수동 중지·새 명령·사망·연결 종료는
이전 작업의 자동 재개를 취소하며, 사망은 별도 리스폰 복구로 넘깁니다.
리스폰 후 저체력·저허기 상태에서도 식량을 확보해 회복을 시도합니다.

웹의 전투 항목과 활동 기록에 방어·후퇴·식사·안전 확인·작업 재개 상태,
보존한 목표와 단계 번호를 표시합니다. 피격 반응은 즉시 대응할 수 있는
우리 코드의 상태 제어이며 Mineflayer 수정이나 Laya 가중치 재학습이 아닙니다.

`npm run test:threat-live`는 별도 25566 월드에서 production `bot.js`를 실행해
실제 채굴 중 정상 AI 허스크의 공격과 서버 확인 처치, 크리퍼 접근에 따른
실제 후퇴, 같은 목표 재개와 수동 중지 후 재개 취소를 검증합니다. 지형·목재·
검·빵은 시험용으로 준비하고, 후퇴 시험의 크리퍼는 고정 배치합니다.
길이 막힌 지형의 탈출이나 모든 전투의 생존을 보장하는 검증은 아닙니다.
# vLLM Laya deployment and ten-bot fleet

Laya inference now runs through the local vLLM CUDA fork at `http://127.0.0.1:8091`. Command, food and activity checkpoints keep their trained weights and question schemas. Full implementation and measurements: [vLLM Laya production guide](../vllm-laya/docs/laya-production.md).

The server is configured for sixteen players and a 4G Java heap. Start the prepared server and ten independent bots:

```bash
ACCEPT_MINECRAFT_EULA=true ./server-start.sh
PATH="/home/elicie/tools/node22/bin:$PATH" BOT_COUNT=10 npm run fleet
```

Fleet identities are `LayaBot01` through `LayaBot10`; their logs and persistent state are separated under `logs/fleet/`. Ctrl-C stops the fleet. The dashboard continues to control its original single bot. Ten production bots were tested together in the disposable world on port 25566, including vLLM decisions and follower movement; long survival campaigns were not part of that test.

## 12명 마을 운영

`npm run village`는 [config/village.json](config/village.json)의 경비병 2명,
건축가 4명, 농부 2명, 관리자 1명, 축산 담당 1명, 사냥꾼 2명을 실행합니다.
12개 봇은 GPU 한 개에서 동작하는 기존 vLLM/Laya 서버를 공유하고
자기 역할·인벤토리·상태를 전달합니다. 기본 `npm run fleet`도 12개 봇을
실행합니다. 서버의 현재 게이트웨이 동시 처리 한도는 32개, 모델별 배치
동시 처리 한도는 16개로 설정되어 있습니다.
역할별 판단은 범용 `laya:multilingual`의 선택형 추론을 사용합니다.
새 역할 모델을 학습한 것은 아니며, 낮은 확신·잘못된 선택·서버 오류는
현재 실행 가능한 기본 행동으로 복구합니다.

| 역할 | 닉네임 | 현재 맡는 작업 |
|---|---|---|
| 경비병 2명 | LayaGuard01~02 | 별도 순찰 경로, 보유 장비로 가능한 적 방어, 위험 시 회피 |
| 건축가 4명 | LayaBuilder01~04 | 작은집·넓은집·창고·전망대의 각자 부지, 재료 확보·건축·파손 보수 |
| 농부 2명 | LayaFarmer01~02 | 서로 다른 밀밭의 파종·수확·재파종, 빵 제작과 창고 보급 |
| 관리자 1명 | LayaManager01 | 실제 창고 재고 확인, 개발·식량·방어·축산 우선순위 선택 |
| 축산 1명 | LayaRancher01 | 주변 성체 가축 두 마리에 먹이주기, 새끼 관측, 16마리 번식 한도 |
| 사냥꾼 2명 | LayaHunter01~02 | 좌우로 나눈 마을 바깥 구역에서 관측한 동물 사냥, 고기 조리·고기와 가죽 등의 창고 보급 |

관리자 봇의 첫 접속 위치가 마을 중심입니다. 중심은 `logs/fleet/village.json`에
서버 주소·차원과 함께 저장하고 재시작해도 유지합니다. 새 서버·새 마을은
별도의 `FLEET_LOG_DIR`을 지정하세요. 초기 건물 4동과 농지 2곳을 겹치지 않게
배정하며, 설정한 상대 좌표는 평탄하고 접근 가능해야 합니다. 부적합한 부지는
오류를 기록하고 기다립니다. 임의 지형을 평탄화하거나 새 부지를 계속 늘리는
확장 계획, 축사 건설·가축 유인, 다른 플레이어와의 전투는 현재 구현에 포함되지 않습니다.

창고가 완성되면 농부가 잉여 수확물·빵을 보급하고 축산 담당과 다른 봇이
확인된 재고를 사용합니다. 창고 사용은 한 번에 한 봇에 배정합니다.
마을에서 관측한 각 축종의 성체 두 마리와 새끼는 식량 사냥 대상에서 보호합니다.
사냥꾼의 전용 사냥은 마을 중심 40블록 밖에서만 수행합니다.
재료·물·종자·기초 가축이 없는 환경의 장기 자급 성공률은 별도 검증이 필요합니다.

마인크래프트 서버는 외부 서버를 사용합니다. 서버 주소를 바꿔 실행하세요.
Laya 서버는 이 컴퓨터의 기존 `OLLAYA_URL`을 사용합니다.

```bash
PATH="/home/elicie/tools/node22/bin:$PATH" MC_HOST="SERVER_ADDRESS" MC_PORT=25565 npm run village
```

현재 고정 역할 닉네임은 기존 `MC_AUTH=offline` 연결 방식입니다.
인증 방식은 접속할 서버 설정에 맞아야 합니다.
터미널에서는 `LayaBuilder01 !stop`, `LayaBuilder01 마을 시작`,
`all !stop`, `all 마을 시작`으로 개별·전체 중지와 재개를 제어합니다.
채팅 제어는 `MC_OWNERS`에 등록한 플레이어가 봇 닉네임 뒤에 명령을 붙입니다.
예: `LayaFarmer01 !stop`. Ctrl-C는 모든 봇을 종료합니다.
수동 중지는 저장되며 재접속해도 자동으로 해제되지 않습니다.
역할 상태는 `logs/fleet/status.json`, 봇별 기록은 해당 닉네임 폴더에 저장합니다.

`npm run test:village`는 역할 배정·서버별 중심 저장·부지 겹침 거부·창고 잠금·
역할 동작·회복 우선·추론 중 수동 취소·재시작 중지 보존·종축 보호를 검증합니다.
`npm run test:village-live`는 별도 25566 시험 월드에서 평지·재료·씨앗·식량·
가축을 준비하고 12개 production 봇의 Laya GPU 역할 선택, 순찰, 건축 착수,
파종, 실제 새끼 소 탄생과 전체 중지를 확인합니다.
전체 마을 완공이나 장기 자급·확장 성공을 뜻하는 테스트는 아닙니다.
12명으로 변경한 구성과 사냥꾼 동작은 사용자 요청에 따라 현재 실행·테스트하지 않았습니다.
