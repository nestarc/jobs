# `@nestarc/jobs` v0.3.1 이후 P0–P4 유지보수 작업 계획

- 상태: `ACTIVE` — Jobs 0.4.0 공개 릴리스 완료, 외부 후속 M22/M24/TEN-ECO-NEXT 유지
- 작성일: 2026-09-02 (Asia/Seoul)
- 공개 main 기준: `origin/main@555b1cca2fe4d0c906913df6221fb35ce5a987c0`
- 공개 release 기준: `v0.4.0@563612539401f49fa6b1ab0c9c265f79e8f61741`
- 조사 checkout: `codex/ten-m21-jobs-modern@d3d757e6a7285fa890cea23978954adade950073`
- 최초 조사 tree hash: 당시 checkout과 당시 공개 main(405e799) 모두 `19c88ba35be9f80ca81af563fe2ee722766e9da3`
- 패키지: `@nestarc/jobs@0.4.0`
- 목적: 조사에서 확인한 P0–P4 작업을 **한 세션에 한 작업, 한 PR** 단위로 나누고, 새 세션이 이미 끝난 handler/TEN-M21 작업이나 과거 계획을 다시 실행하지 않도록 한다.

> [!NOTE]
> **2026-09-05 최종 릴리스 인계:** 사용자의 유지보수 검토 문서 전체 실행 요청으로 계획/구현을 PR #2에서 함께 통합했고 npm 0.4.0 및 GitHub Release를 공개했다. 아래 과거 bootstrap 대기·local-only·0.3.1 candidate 및 Next exact action 기록은 역사다. 최신 상태와 원본 workflow 실패 및 복구의 정확한 증거는 [릴리스 검토 §6](./2026-09-05-maintenance-release-review.md#6-최종-완료-기록--2026-09-05)을 따른다. 새 별도 리뷰어는 요구하지 않았다.

> [!IMPORTANT]
> 새 작업은 fetch한 `origin/main`에서 시작한다. 조사 checkout은 공개 main과 tree가 같지만 commit lineage가 다르다. npm `0.3.1` tag는 현재 main보다 앞선 release commit이므로 현재 source tree와 게시 tarball을 같은 bytes로 간주하지 않는다.

> [!IMPORTANT]
> 이 파일은 작성 직후 `untracked` 상태다. 구현보다 먼저 `JOBS-PLAN-01`로 이 문서만 review/merge해야 clean checkout과 여러 세션이 같은 상태를 공유할 수 있다. 문서가 `origin/main`에 들어가기 전에는 다른 task를 `IN_PROGRESS`로 바꾸지 않는다.

> [!CAUTION]
> 조사 전부터 [`handler-discovery-initialization-plan-2026-08-23.md`](./handler-discovery-initialization-plan-2026-08-23.md)가 수정 중이었다. 이 문서의 어떤 작업도 그 파일을 restore, overwrite, format, stage, commit하지 않는다. 그 계획은 handler discovery와 published-only 검증이 완료됐다는 읽기 전용 역사 기준선이다.

> [!NOTE]
> 2026-09-05 사용자가 `JOBS-M02 → JOBS-M05 → JOBS-M01` 구현·검증으로 범위를 확대했다. 아래 세 작업의 `DONE`과 `JOBS-M06`의 `READY`는 **로컬 구현 후보 기준**이며, 공개 main에 merge되거나 배포됐다는 뜻이 아니다. `JOBS-PLAN-01`은 여전히 미merge 상태다. 다른 세션은 branch-local 상태를 shared claim 또는 main 완료 증거로 사용하지 않는다. 상세 인계는 §9를 따른다.

> [!NOTE]
> 2026-09-05 후속 요청으로 `JOBS-M03`과 필수 선행 `JOBS-M04`의 로컬 구현·검증을 완료했다. 시작 checkout은 이전 M01/M02/M05 구현을 포함한 `main@1f4c486`이며 clean 상태였다. 이 문서는 이제 tracked이지만 fetched `origin/main@405e799`에는 여전히 없다. M03/M04의 `DONE`도 로컬 후보 기준이며, shared claim·PR·merge·release 완료를 뜻하지 않는다. 가장 최근 인계는 §9의 M04 → M03 기록을 따른다.

> [!NOTE]
> 2026-09-05 사용자 요청으로 `JOBS-M06–M09`를 같은 세션에서 구현·검증했다. 시작점은 M01–M05를 포함한 clean `main@f222389`이다. 아래 네 작업의 `DONE` 및 새로 열린 후속 작업의 `READY`는 **로컬 후보 기준**이다. fetched `origin/main@405e799`에는 이 계획 및 구현이 아직 없으며 shared claim·PR·merge·release 완료를 뜻하지 않는다. 가장 최근 인계는 §9의 M06–M09 기록을 따른다.

> [!NOTE]
> 2026-09-05 사용자가 이 문서의 남은 실행 명세 전체 진행과 완료 후 문서 갱신을 요청했다. 기존 M01–M09를 포함한 clean `main@7cb3398`에서 로컬 구현을 이어 진행했다. 한 세션/한 작업 및 bootstrap 대기 제한은 이번 전체 실행 요청으로 대체한다. **로컬 code/docs/test 완료와 공개 merge·관리자 설정·publish 완료를 구분한다.** 현재 실행 결과는 §9의 “전체 유지보수 실행 인계”가 최신이며, 과거 Next exact action을 재실행하지 않는다. P4는 원래 명세대로 연구 backlog다.
>
> M11은 시작 시 실행 표에만 DONE이었고 명세/코드/검증 근거는 없었다. 이번에 실제 retention 구현과 테스트를 추가한 뒤 상태를 맞췄다. M12/M22/M24의 외부 조건, JOBS-PLAN-01 review/merge, JOBS-REL-01 및 TEN-ECO-NEXT는 완료로 표시하지 않는다.

## 0. 문서 운영 계약

### 0.1 우선순위

| 우선순위 | 의미                                                                                                                             | 실행 원칙                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `P0`     | 성공으로 접수한 작업의 유실, 상태 역전, 동일 job의 동시 attempt, cross-tenant 축약 또는 source lineage 위조를 만드는 재현된 문제 | 다른 기능보다 먼저 수정하고 release 후보를 명시한다. 독립 P0는 별도 PR로 병렬 가능하다. |
| `P1`     | fairness/concurrency, 입력, serialization, producer role, retention, 릴리스 신뢰·의존성 하한 문제                                | P0 뒤에 한 계약씩 진행한다.                                                             |
| `P2`     | backend fault recovery, 테스트 도구, packaging, 호환성, 문서와 운영 정책                                                         | 핵심 상태 모델을 보존하며 보강한다.                                                     |
| `P3`     | chaos/property/performance, 구조와 package surface 장기 개선                                                                     | behavior contract가 고정된 뒤 진행한다.                                                 |
| `P4`     | 새 backend/분산 기능/major 생태계 연구                                                                                           | backlog만 유지하고 현재 release를 막지 않는다.                                          |

### 0.2 상태

| 상태          | 의미                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `READY`       | 선행 조건이 충족되어 바로 시작할 수 있다.                                                                                  |
| `IN_PROGRESS` | 한 세션이 소유 중이다. shared issue/PR에 owner·시작 ref·시각을 기록하며 branch-local 문서 변경만으로는 lock이 되지 않는다. |
| `BLOCKED`     | 표의 선행 작업 또는 외부 release/settings가 필요하다.                                                                      |
| `DECISION`    | 이 작업 안에서 호환성·semver·운영 정책 ADR을 먼저 확정한다.                                                                |
| `EXTERNAL`    | 다른 저장소 또는 GitHub/npm 관리자 권한에서 수행한다.                                                                      |
| `DONE`        | code/docs/test와 필요한 release/settings 증거까지 완료됐다.                                                                |
| `SUPERSEDED`  | 다른 task에 흡수되어 재실행하지 않는다.                                                                                    |
| `BACKLOG`     | P4 연구 후보이며 실행 큐가 아니다.                                                                                         |

### 0.3 새 세션 시작 절차

1. 이 문서와 `git status --short --branch`를 읽고 기존 dirty handler plan을 확인한다.
2. 사용자 변경을 reset/restore/delete/stage하지 않는다.
3. `git fetch --tags origin main:refs/remotes/origin/main` 후 remote main, release tag, npm `latest`, current main CI를 다시 조회한다.
4. 기준이 바뀌었으면 구현보다 이 문서의 ref·상태·완료 증거를 먼저 갱신한다.
5. `JOBS-PLAN-01` merge 뒤 현재 dirty checkout에서 branch를 전환하지 말고, `origin/main` 기준 별도 Codex worktree 또는 새 빈 경로의 git worktree에서 `codex/jobs-mxx-<slug>`를 만든다.
6. 한 세션은 현재 최저 미완료 priority의 가장 낮은 번호 `READY` 또는 `DECISION` 하나만 선택한다. shared issue/PR에 task ID, owner, start ref, 시작 시각을 먼저 기록하고 나서 `IN_PROGRESS`로 바꾼다. stale claim은 owner/PR/session이 실제로 종료됐음을 확인한 뒤에만 회수한다. 여러 세션의 병렬 P0는 수정 파일이 겹치지 않을 때만 허용한다. P0 merge 뒤 `JOBS-REL-01`의 직접 선행 `JOBS-M12`, `JOBS-M13`, `JOBS-M17`은 unrelated 작업보다 먼저 당길 수 있고, 선행이 모두 끝나면 `JOBS-REL-01`을 실행한다.
7. 해당 작업의 첫 RED를 먼저 재현한다. 실패 원인이 다르면 기록하고 범위를 조용히 확장하지 않는다.
8. 작업별 검증 프로필, start ref 대비 path-scoped diff, artifact/Redis 증거를 남긴다. `git add -A`를 쓰지 않고 dirty handler 문서가 index에 없는지 확인한다.

시작용 최소 명령:

```bash
git status --short --branch
git fetch --tags origin main:refs/remotes/origin/main
git rev-parse origin/main
git rev-parse v0.3.1^{}
git log -1 --oneline origin/main
gh release view v0.3.1 --json tagName,targetCommitish,publishedAt
npm view @nestarc/jobs version dist.integrity time --json
node -p "require('./package.json').version"
```

`gh` 인증이 없으면 release/CI 조회 실패를 0건으로 해석하지 말고 public GitHub API/Actions page로 fetched SHA를 확인하거나 “외부 검증 미완료”로 인계한다. source test는 별도 worktree에서 프로필 A로 실행한다.

### 0.4 세션 종료 인계 형식

```text
Task: JOBS-Mxx
State: DONE | BLOCKED | IN_PROGRESS | DECISION | EXTERNAL
Start ref / end ref:
Changed files:
Contract / semver decision:
First RED command and failure:
Final commands and exact results:
Redis / packed / external evidence:
Unverified paths and reason:
Remaining risk:
Next exact action:
```

unit test가 통과했거나 code가 작성됐다는 이유만으로 `DONE` 처리하지 않는다. Redis, packed consumer, release/settings가 acceptance에 있으면 실제 결과가 필요하다.

## 1. 2026-09-02 기준선

### 1.1 저장소와 배포 상태

- npm `latest`와 GitHub Release는 `@nestarc/jobs@0.3.1`, release commit `7a17344`다. npm publish 시각은 2026-08-23T15:08:57.943Z다.
- [GitHub Release v0.3.1](https://github.com/nestarc/jobs/releases/tag/v0.3.1)의 provenance attestation은 annotated tag가 가리키는 release commit을 증명한다. npm manifest에는 `gitHead`가 없으므로 attestation/ref/digest를 기준으로 쓴다.
- current public main `405e799`에는 [PR #1 modern Outbox consumer verification](https://github.com/nestarc/jobs/pull/1)이 merge됐고 [main CI run 33294387914](https://github.com/nestarc/jobs/actions/runs/33294387914)의 22개 job이 성공했다.
- 조사 checkout `d3d757e`와 public main tree는 동일하다. TEN-M21 commit을 다시 merge/cherry-pick하지 않는다.
- current main candidate tarball은 release 뒤 CI/docs 변경 때문에 게시된 `0.3.1` bytes와 다르다. version이 같다는 이유로 둘을 동일 artifact로 취급하지 않는다.

조사 시작 시 기존 사용자 변경은 다음 하나였다.

```text
 M docs/handler-discovery-initialization-plan-2026-08-23.md
```

이 계획 파일은 별도의 새 파일로만 추가한다.

### 1.2 fresh 검증

조사 환경 Node `24.11.1`, npm `11.6.2`에서 실행했다.

| 검증                                | 결과                                |
| ----------------------------------- | ----------------------------------- |
| `npm test -- --runInBand`           | 20 suites, 151 tests PASS           |
| `npm run lint`                      | PASS                                |
| `npx tsc -p tsconfig.json --noEmit` | PASS                                |
| `npm run build`                     | PASS                                |
| `npm audit --omit=dev --json`       | production 0                        |
| `npm audit --json`                  | 10 total: high 3, moderate 6, low 1 |

`npm run test:coverage`는 Redis fixture까지 포함하므로 `REDIS_URL` 없이 실행하면 의도적으로 실패한다. 그 실행에서 보이는 65%대 임시 수치를 회귀로 기록하지 않는다. 최신 green main artifact 기준은 다음과 같다.

| 범위           | statements | branches | functions |  lines |
| -------------- | ---------: | -------: | --------: | -----: |
| global         |     91.47% |   82.66% |    96.93% | 93.73% |
| BullMQ backend |     92.34% |   84.98% |    94.25% | 94.12% |

현재 threshold는 global 85/70/85/85이며 coverage 재현에는 Redis가 필수다.

### 1.3 선언과 자동 증거

| 축            | 공개 선언                      | 현재 자동 증거                                 | 유지보수 결론                                                      |
| ------------- | ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| Node          | 20/22/24                       | unit 20/22/24, Redis/consumer matrix           | Node 20 EOL 이후 정책은 `JOBS-M18`에서 결정한다.                   |
| NestJS        | 10/11                          | lifecycle, Redis, packed consumer 10/11        | Nest 12는 proof 전 peer에 추가하지 않는다.                         |
| BullMQ        | optional `^5.74.1`             | locked 5.74.1 Redis matrix                     | advisory-safe minimum/latest-v5 matrix는 `JOBS-M13`이 소유한다.    |
| Outbox        | optional `^0.2.0`              | exact 0.2.1/Nest 11.2.1/Prisma 7.10.0 consumer | TEN-M21 anchor는 보존하고 후속 exact candidate gate를 별도로 둔다. |
| core consumer | BullMQ/Outbox 없이 설치 가능   | Node×Nest packed consumer                      | optional peer 비설치를 계속 검증한다.                              |
| release       | verify에서 tgz 생성 후 publish | provenance와 artifact download                 | existing-version digest 검증과 권한 경계가 남았다.                 |

Node lifecycle 판단은 [Node.js 공식 release schedule](https://github.com/nodejs/Release#release-schedule)을 기준으로 한다.

### 1.4 확인된 상태/전달 의미

- Jobs delivery는 at-least-once다. identity/dedupe는 duplicate enqueue를 줄이지만 exactly-once handler side effect를 보장하지 않는다.
- Outbox `SENT`는 Jobs enqueue가 생성 또는 dedupe acknowledgement 됐다는 의미다. Jobs `succeeded/failed/dead_letter`와 합치지 않는다.
- response loss 뒤 Outbox가 PENDING/PROCESSING이어도 stable record ID의 job이 이미 존재할 수 있다.
- lifecycle callback은 best-effort observer이며 queue 상태를 바꾸거나 durable compliance audit가 되지 않는다.
- In-memory backend는 프로세스 메모리이므로 shutdown에서 성공 접수한 queued work를 조용히 유실하면 안 된다.

### 1.5 완료되어 다시 열지 않는 범위

- Jobs `0.3.0` BullMQ identity/idempotency, first-party Outbox publisher, response-loss reconciliation, backend matrices
- Jobs `0.3.1` application-bootstrap handler discovery, singleton/static dependency-tree fail-fast, Nest 10/11 startup/shutdown ordering
- `TEN-M19`, `TEN-M21` published/local provenance와 fully-published ecosystem 검증
- current main의 exact Outbox `0.2.1` / Nest `11.2.1` / Prisma `7.10.0` packed consumer gate
- v0.3 identity reservation/hash-slot atomic binding, v0.2 adoption, queue-scoped identity, lifecycle observer isolation, basic retry/delay semantics
- synthetic lock-loss tests를 “없음”으로 간주해 다시 쓰지 않는다. `JOBS-M25`는 실제 process/Redis 장애 증거만 추가한다.

`docs/superpowers/plans/**`와 과거 spec의 체크박스는 역사 자료다. 새 backlog는 이 문서만 권위 있게 사용한다.

### 1.6 조사 evidence map

아래 line은 이 기준 tree에서의 시작점이다. 새 세션에서 line이 이동했으면 symbol을 다시 찾고 재현을 우선한다.

| 작업          | 현재 evidence                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JOBS-M01`    | shutdown loop/admission: `src/jobs.module.ts:64-85`; close가 map만 clear하고 admission guard 없음: `src/backend/in-memory-backend.ts:343-349`                                     |
| `JOBS-M02`    | activation과 ID-only ack/fail/cancel: `src/backend/in-memory-backend.ts:169-248`; public backend port: `src/backend/jobs-backend.interface.ts:27-30`                              |
| `JOBS-M03`    | adapter mapping: `src/outbox/outbox-jobs-publisher.ts:65-105`; missing scope→global: `src/backend/in-memory-backend.ts:534-543`, `src/backend/bullmq-backend.ts:1035-1049`        |
| `JOBS-M04`    | configured context/metadata spread와 truthy source override: `src/outbox/outbox-jobs-publisher.ts:68-105`                                                                         |
| `JOBS-M05`    | timeout race, immediate fail/requeue, late invocation suppression: `src/fair-worker.ts:71-100`, `:129-162`                                                                        |
| `JOBS-M06`    | sequential host: `src/jobs.module.ts:76-85`; one worker per type: `:316-329`; BullMQ per-type concurrency: `src/backend/bullmq-backend.ts:451-483`                                |
| `JOBS-M07`    | job ID 이외 central validation 부재: `src/enqueue-validation.ts:1-5`; effective opts pass-through: `src/jobs.service.ts:53-70`; silent numeric normalization: `src/retry.ts:8-28` |
| `JOBS-M08`    | missing tenant→literal `__default__`: `src/jobs.service.ts:71-78`, `:167-176`                                                                                                     |
| `JOBS-M09`    | outer-object-only payload/context checks: `src/context-serializer.ts:7-43`; metadata 무검증 pass-through: `src/jobs.service.ts:64-70`                                             |
| `JOBS-M10`    | module이 항상 consumer host를 구성: `src/jobs.module.ts:121-138`, `:345-385`; missing handler failure: `src/handler-registry.ts:16-23`                                            |
| `JOBS-M11`    | BullMQ add options에 terminal removal 정책 없음: `src/backend/bullmq-backend.ts:243-252`; in-memory unbounded maps: `src/backend/in-memory-backend.ts:49-55`                      |
| `JOBS-M12/17` | release-wide privileges: `.github/workflows/release.yml:8-21`; version-only existing publish skip: `:42-50`                                                                       |
| `JOBS-M14`    | shallow history copy: `src/backend/in-memory-backend.ts:251-258`; mutable entries recorded: `:594-603`                                                                            |
| `JOBS-M15`    | silent fake drain exhaustion: `src/fake-jobs.service.ts:59-71`                                                                                                                    |
| `JOBS-M21`    | exact Outbox 0.2.1 gate: `.github/workflows/verify.yml:166-182`, `scripts/test-modern-outbox-consumer.js`                                                                         |

## 2. 실행 큐

| 순서 | ID             | 우선순위 | 상태       | 크기 | 선행                                                          | 작업                                                                |
| ---: | -------------- | -------- | ---------- | ---- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
|    0 | `JOBS-PLAN-01` | 문서     | `DONE`    | S    | 없음                                                          | 이 계획만 별도 PR로 review/merge                                    |
|    1 | `JOBS-M01`     | P0       | `DONE`  | L    | `JOBS-M02`, `JOBS-M05`                                        | in-memory shutdown admission/drain 계약                             |
|    2 | `JOBS-M02`     | P0       | `DONE`    | L    | 없음                                                          | activation-fenced state machine                                     |
|    3 | `JOBS-M03`     | P0       | `DONE`     | M    | `JOBS-M04`                                                    | Outbox adapter tenant dedupe 격리                                   |
|    4 | `JOBS-M04`     | P0       | `DONE`     | S    | 없음                                                          | Outbox source-owned lineage 봉인                                    |
|    5 | `JOBS-M05`     | P0       | `DONE`  | M    | `JOBS-M02`                                                    | cooperative timeout 뒤 attempt 중첩 방지                            |
|    6 | `JOBS-M06`     | P1       | `DONE`  | L    | `JOBS-M01–02`, `JOBS-M05`                                     | 실제 in-memory pool과 cross-type cap                                |
|    7 | `JOBS-M07`     | P1       | `DONE`    | M    | 없음                                                          | enqueue/config fail-closed validation                               |
|    8 | `JOBS-M08`     | P1       | `DONE`  | S    | `JOBS-M07`                                                    | system shard와 real `__default__` tenant 분리                       |
|    9 | `JOBS-M09`     | P1       | `DONE`  | M    | `JOBS-M07` validator                                          | backend-portable recursive serialization                            |
|   10 | `JOBS-M10`     | P1       | `DONE`    | M    | 없음                                                          | BullMQ producer/worker/both role                                    |
|   11 | `JOBS-M11`     | P1       | `DONE`  | M    | `JOBS-M03`, `JOBS-M07`                                        | terminal record/identity retention                                  |
|   12 | `JOBS-M12`     | P1       | `DONE`    | M    | 없음                                                          | release trust boundary/least privilege                              |
|   13 | `JOBS-M13`     | P1       | `DONE`    | M    | 없음                                                          | advisory-safe BullMQ v5 floor                                       |
|   14 | `JOBS-M17`     | P1       | `DONE`  | S    | `JOBS-M12`                                                    | published artifact identity 검증                                    |
|   15 | `JOBS-M14`     | P2       | `DONE`  | S    | `JOBS-M02`                                                    | immutable history reads                                             |
|   16 | `JOBS-M15`     | P2       | `DONE`    | S    | 없음                                                          | Fake drain limit 명시적 실패                                        |
|   17 | `JOBS-M16`     | P2       | `DONE`  | M    | `JOBS-M02`, `JOBS-M06`                                        | backend fault/worker-loop recovery                                  |
|   18 | `JOBS-M18`     | P2       | `DONE` | M    | 없음                                                          | Node/Nest 현재 support policy                                       |
|  19A | `JOBS-M19A`    | P2       | `DONE`    | S    | 없음                                                          | low-risk lock/security refresh                                      |
|  19B | `JOBS-M19B`    | P2       | `DONE`  | M    | `JOBS-M19A`                                                   | Jest 30/ts-jest migration                                           |
|  19C | `JOBS-M19C`    | P2       | `DONE`  | M    | `JOBS-M19A`                                                   | ESLint/typescript-eslint migration                                  |
|   20 | `JOBS-M20`     | P2       | `DONE`    | S    | 없음                                                          | historical plan/README hygiene                                      |
|   21 | `JOBS-M21`     | P2       | `DONE`  | M    | Outbox `OUT-M01–04B` candidate/published exact ref            | modern Outbox gate generalization                                   |
|   22 | `JOBS-M22`     | P2       | `EXTERNAL`  | M    | `JOBS-M01`, `JOBS-M03–04`, `JOBS-M07`                         | integration state/admin/legacy bridge 계약                          |
|   23 | `JOBS-M23`     | P2       | `DONE`  | S    | `JOBS-M01–13`                                                 | Redis-backed coverage contract                                      |
|   24 | `JOBS-M24`     | P2       | `EXTERNAL`  | M    | `JOBS-M12`                                                    | SECURITY/CODEOWNERS/update automation                               |
|   25 | `JOBS-M25`     | P3       | `DONE`  | L    | `JOBS-M02–05`, `JOBS-M07`, `JOBS-M10–11`, `JOBS-M13`          | actual Redis lease/crash chaos                                      |
|   26 | `JOBS-M26`     | P3       | `DONE`  | M    | `JOBS-M02`, `JOBS-M06`, `JOBS-M11`, `JOBS-M16`                | model/property/soak/performance gates                               |
|   27 | `JOBS-M27`     | P3       | `DONE` | M    | 없음                                                          | package exports/deep-import contract                                |
|   28 | `JOBS-M28`     | P3       | `DONE`  | M    | `JOBS-M02–05`, `JOBS-M07`, `JOBS-M11`, `JOBS-M13`, `JOBS-M16` | BullMQ backend 내부 책임 분리                                       |
|   29 | `JOBS-REL-01`  | release  | `DONE`  | M    | `JOBS-M01–05`, `JOBS-M12–13`, `JOBS-M17`                      | next release version/CHANGELOG/tag/publish                          |
|   30 | `TEN-ECO-NEXT` | 외부     | `EXTERNAL` | L    | `OUT-REL-01`, `JOBS-REL-01`                                   | PostgreSQL Outbox → Redis/BullMQ fully-published crash/restart 검증 |

2026-09-05 전체 실행 요청으로 계획·유지보수 구현을 PR #2에서 함께 공개 main에 반영했고 `JOBS-REL-01`을 완료했다. 실행 표의 DONE은 이번 공개 릴리스 증거를 포함한다. 남은 EXTERNAL과 P4 BACKLOG는 별도로 유지하며 최신 인계는 릴리스 검토 §6을 따른다.

### 2.1 파일과 첫 RED 행동

| ID          | 주 파일/경계                                         | 새 세션의 정확한 첫 행동                                                                                                           |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `JOBS-M01`  | `jobs.module.ts`, in-memory backend/service          | handler 1을 막고 job 2를 queue한 뒤 `app.close()`를 호출해 job 2가 queued로 남고 close 후 enqueue도 성공하는 Nest test를 고정한다. |
| `JOBS-M02`  | backend interface, in-memory lifecycle               | queued job을 `ack()`해 attempt 0 succeeded가 되고 dead_letter 뒤 stale ack가 succeeded로 뒤집는 test를 만든다.                     |
| `JOBS-M03`  | Outbox publisher, both backends                      | tenant A/B의 서로 다른 Outbox ID에 같은 mapping dedupe key를 주고 job 하나로 축약되는 test를 만든다.                               |
| `JOBS-M04`  | Outbox publisher context/metadata                    | source tenant/causation이 null인데 mapping의 위조 reserved field가 job에 남는 test를 만든다.                                       |
| `JOBS-M05`  | fair worker timeout/retry                            | AbortSignal을 무시하는 deferred first attempt가 settle 전인데 retry가 시작되는 동시 invocation test를 만든다.                      |
| `JOBS-M06`  | in-memory host/pool, BullMQ cap docs                 | 두 job type 중 첫 handler를 막았을 때 두 번째 type과 다른 tenant도 시작하지 못하는 test를 만든다.                                  |
| `JOBS-M07`  | central validation, service/backends/options         | `attempts: Infinity`가 세 번 실패해도 queued로 영원히 남는 test와 invalid dedupe scope가 global로 흐르는 test를 만든다.            |
| `JOBS-M08`  | service scheduler identity                           | tenant 없음과 literal `tenantId:'__default__'`가 scheduler snapshot 한 shard로 합쳐지는 test를 만든다.                             |
| `JOBS-M09`  | payload/context/metadata codec                       | nested Date/Map/function/BigInt/cycle을 memory와 JSON path에 보내 결과/오류가 다른 table test를 만든다.                            |
| `JOBS-M10`  | module role/worker bootstrap                         | handler 없는 producer app이 durable queue job을 consume해 handler-not-found로 실패시키는 Redis two-app test를 만든다.              |
| `JOBS-M11`  | Bull add options, identity cleanup, memory retention | terminal jobs N개 후 Redis/memory record·payload·identity 수가 계속 증가하는 bounded fixture를 만든다.                             |
| `JOBS-M12`  | release/verify workflow/settings                     | reusable verify가 top-level write/OIDC를 상속하지 않아야 한다는 workflow policy test를 만든다.                                     |
| `JOBS-M13`  | peers/dev lock/Redis matrix                          | packed manifest의 minimum safe BullMQ v5 assertion을 먼저 바꿔 current range에서 RED를 만든다.                                     |
| `JOBS-M14`  | history snapshots                                    | 반환 history entry/status/Date/error를 mutate한 뒤 다음 read가 오염되는 test를 만든다.                                             |
| `JOBS-M15`  | fake drain                                           | 1001 ready jobs에서 default 1000 iteration drain이 성공 resolve하면서 1개를 남기는 test를 만든다.                                  |
| `JOBS-M16`  | fair worker/host error isolation                     | `moveToActive`, `ack`, `fail`이 각각 throw하는 fake backend로 scheduler inflight 또는 전체 loop가 영구 정지하는 test를 만든다.     |
| `JOBS-M17`  | release existing-version check                       | registry version은 같지만 candidate/published SRI가 다른 fixture에서 release가 success skip하는 정책 test를 만든다.                |
| `JOBS-M18`  | engines/peers/CI/README                              | Node 22/24와 exact Nest 12 packed/Redis spike 결과를 ADR 입력으로 기록한다.                                                        |
| `JOBS-M19A` | lockfile/advisories                                  | prod/dev/optional-peer advisory 경로를 분류하고 compatible patch update 하나만 선택한다.                                           |
| `JOBS-M19B` | Jest/ts-jest                                         | Jest 30 exact install에서 첫 unit/config failure를 기록한다.                                                                       |
| `JOBS-M19C` | ESLint/typescript-eslint                             | exact compatible flat-config toolchain에서 첫 lint/config failure를 기록한다.                                                      |
| `JOBS-M20`  | old plans/README                                     | handler dirty plan을 제외하고 현재 release와 모순되는 버전/unchecked historical 지시를 목록화한다.                                 |
| `JOBS-M21`  | verify/consumer script                               | hardcoded 0.2.1 anchor를 보존한 채 다른 exact tgz/spec와 expected version을 입력하는 negative fixture를 만든다.                    |
| `JOBS-M22`  | service docs, legacy bridge                          | Outbox/Jobs 상태를 같은 “delivered”로 표시하는 잘못된 예와 legacy bridge의 lineage 부재를 contract table로 만든다.                 |
| `JOBS-M23`  | coverage config/workflow                             | Redis 없는 coverage를 정상 결과로 보고하지 않는 assertion과 critical branch 목록을 먼저 만든다.                                    |
| `JOBS-M24`  | repository policy                                    | supported release line/private report path와 owner를 먼저 확정한다.                                                                |
| `JOBS-M25`  | Redis identity lease                                 | producer를 reservation 전/후 SIGKILL하고 Redis disconnect/restart를 일으키는 first failing chaos case를 만든다.                    |
| `JOBS-M26`  | state model/property/bench                           | terminal monotonicity와 at-most-one-live-identity invariant를 randomized trace에 적용한다.                                         |
| `JOBS-M27`  | manifest/packed consumers                            | root 외 실제 deep import inventory와 accidental import consumer를 만든다.                                                          |
| `JOBS-M28`  | large BullMQ backend                                 | existing Redis contract tests를 internal extraction 전 mutation-safe baseline으로 고정한다.                                        |

### 2.2 `JOBS-PLAN-01` — 계획 bootstrap

- 이 파일 하나만 path-scoped stage한 plan-only PR을 만든다. code, lockfile, 다른 docs를 함께 넣지 않는다.
- `git diff --cached --name-only`에 이 파일만 있고 기존 dirty handler plan이 index에 없음을 확인한다.
- reviewer가 public main/release 분리, P0 evidence, merge lane, Redis/destructive-test guard를 확인한다.
- reviewer 승인 뒤 merge될 최종 commit에서 이 row를 `DONE`으로 바꾼다. 따라서 `origin/main`에는 `READY` 상태의 bootstrap row가 노출되지 않으며 별도 상태-only PR을 만들지 않는다.
- merge 뒤 clean `origin/main` worktree에서 이 문서를 읽을 수 있음을 확인한다.
- 현재 요청은 문서 생성까지만 소유하므로 commit/push/PR은 별도 승인된 세션에서 수행한다.

## 3. P0 작업 명세

### `JOBS-M01` — in-memory shutdown admission/drain 계약

- 상태: `P0 / DONE` (로컬 후보); 완료 근거: §9의 2026-09-05 인계
- 문제(수정 전): shutdown은 `running=false` 후 현재 sequential loop만 기다리고 queued work를 drain하거나 backend를 닫지 않는다. close 중/후 enqueue도 성공하여 영원히 queued인 nondurable job을 반환한다.

완료 조건:

- [x] lifecycle을 `open → closing → closed`로 원자적으로 관리한다.
- [x] close 시작 뒤 enqueue는 stable typed `jobs_backend_closed` 또는 동등한 public error로 거부한다.
- [x] close 전에 성공 접수한 active/queued work는 기본 graceful drain, 명시적 abort/report 등 선택한 계약 없이 조용히 남지 않는다.
- [x] shutdown deadline을 두면 남은 job IDs/count와 결과를 관측 가능하게 하고 성공 close로 위장하지 않는다.
- [x] worker drain 뒤 backend resources를 정확히 한 번 close한다.
- [x] enqueue↔close race, active+queued, delayed/retrying, close twice, post-close enqueue test가 있다.
- [x] Nest 10/11 module lifecycle 회귀가 통과한다.

이 작업은 `JOBS-M05`가 정의한 실제 outstanding invocation ownership을 사용한다. timeout 뒤 handler가 남아 있는데 logical loop만 끝났다는 이유로 graceful shutdown을 완료하지 않는다.

검증: 프로필 A/C. Semver: typed close error 추가는 patch 가능하나 shutdown default를 크게 바꾸면 pre-1.0 minor. 비범위: process memory job의 crash durability.

### `JOBS-M02` — activation-fenced InMemory 상태 머신

- 상태: `P0 / DONE` (로컬 후보); 완료 근거: §9의 2026-09-05 인계
- 문제(수정 전): `ack/fail/cancel`이 job ID만 받고 prior state/attempt owner를 확인하지 않아 queued ack, zero-attempt success, terminal reversal, stale retry completion이 가능하다.

완료 조건:

- [x] legal state transition matrix와 terminal monotonicity를 문서/contract test로 고정한다.
- [x] `moveToActive`가 activation ID/lease version 또는 동등한 attempt ownership을 반환한다.
- [x] ack/fail은 matching active attempt만 전이할 수 있다.
- [x] queued/terminal/stale/opposite completion은 typed conflict 또는 idempotent no-op로 명확히 구분한다.
- [x] cancel/replay/admin과 active attempt race가 terminal state를 되돌리지 않는다.
- [x] attempt count와 history가 단조 증가하며 queued fail이 retry budget을 소비하지 않는 모순이 없다.
- [x] custom backend migration과 capability/versioning 전략을 남긴다.

검증: 프로필 A/C, `JOBS-M26`의 향후 model invariant 입력. Public `JobsBackend` signature가 깨지면 `0.4.0` minor. 비범위: BullMQ 내부 lock 재구현.

### `JOBS-M03` — Outbox adapter의 tenant-safe dedupe

- 상태: `P0 / DONE` (로컬 후보); 선행 `JOBS-M04` 포함 완료. 근거: §9의 M04 → M03 인계
- 문제(수정 전): adapter는 tenant를 기본 필수로 하면서 mapping dedupe를 그대로 넘기고, 두 backend는 missing scope를 global로 처리한다. tenant A/B 같은 key에서 B Outbox row도 terminal acknowledgement 되지만 A job 하나만 남을 수 있다.

완료 조건:

- [x] tenant-bearing Outbox event에서 scope 누락은 adapter 경계에서 `tenant`로 확정하거나 fail-closed한다.
- [x] cross-tenant global dedupe는 명시적 `scope:'global'` 또는 더 강한 이름의 opt-in만 허용한다.
- [x] generic `JobsService` dedupe 기본값은 이 task에서 바꾸지 않는다.
- [x] tenant A/B 동일 key가 InMemory와 BullMQ에서 각각 job을 만든다.
- [x] explicit global positive case는 의도대로 한 job으로 축약된다.
- [x] suppressed Outbox publish가 enqueue acknowledgement일 뿐 handler 성공이 아님을 문서화한다.
- [x] record ID는 canonical job/idempotency identity로 계속 보존한다.

검증: 프로필 A/B/D. Semver: correctness patch 가능; global opt-in shape가 바뀌면 `0.4.0`. 비범위: exactly-once와 generic API default.

### `JOBS-M04` — Outbox source-owned lineage 봉인

- 상태: `P0 / DONE` (로컬 후보); 완료 근거: §9의 M04 → M03 인계
- 문제(수정 전): mapping context/metadata를 먼저 spread하고 source 값이 truthy일 때만 덮어써 global event/null lineage에서 mapping의 stale/위조 reserved field가 남는다.

완료 조건:

- [x] context의 `tenantId`, `outboxEventId`, `correlationId`, `causationId`를 mapping 입력에서 제거한 뒤 source로 재구성한다.
- [x] metadata의 source/event/type/tenant/correlation/causation/aggregate/partition/idempotency/header/occurredAt 예약 필드도 같은 규칙을 쓴다.
- [x] source 값이 없으면 mapping의 stale 값도 결과에 남지 않는다.
- [x] 명시적 `target.tenant` 함수만 tenant 재매핑을 소유한다.
- [x] 사용자 정의 비예약 context/metadata는 보존한다.
- [x] source object를 mapping function이 mutate해 canonical identity를 바꾸지 못하게 snapshot/order를 고정한다.

검증: 프로필 A/D. Semver: patch. 비범위: Tenancy runtime dependency와 arbitrary business metadata validation.

### `JOBS-M05` — cooperative timeout 뒤 동일 job attempt 중첩 방지

- 상태: `P0 / DONE` (로컬 후보); 완료 근거: §9의 2026-09-05 인계
- 문제(수정 전): Promise.race timeout 즉시 scheduler slot을 풀고 retry를 예약하며 signal을 무시한 원래 invocation은 계속 side effect를 낼 수 있다. retry가 시작하면 동일 job attempts가 동시에 실행되고 tenant cap도 실제 work를 세지 못한다.

완료 조건:

- [x] 같은 job의 이전 invocation이 settle되기 전 자동 retry가 시작되지 않는다.
- [x] timeout은 AbortSignal과 lifecycle timeout 결과를 기록하되 logical state와 실제 invocation ownership을 분리하지 않는다.
- [x] settlement grace/no-overlap/detached escalation 중 선택한 정책과 영원히 settle하지 않는 handler의 운영 복구를 문서화한다.
- [x] shutdown은 logical tick뿐 아니라 실제 outstanding invocation 계약을 따른다.
- [x] signal 준수, late resolve, late reject, never settle cases의 event order/attempt count가 일관된다.
- [x] at-least-once를 유지하고 forced cancellation/exactly-once를 주장하지 않는다.

검증: 프로필 A/C. Semver: safety patch 가능. 비범위: worker thread/process 강제 종료와 BullMQ timeout 지원.

## 4. P1 작업 명세

### `JOBS-M06` — 실제 in-memory pool과 cross-type concurrency cap

- 상태: `P1 / DONE`; 선행 `JOBS-M01`, `JOBS-M02`, `JOBS-M05` 로컬 완료; 로컬 code/docs/test 완료, §9 M06–M09 인계 참조
- 문제(수정 전): auto host가 job type별 worker tick을 순차 await하여 실제 total concurrency가 1이다. `tenantCap:10`이 처리 병렬도 계약처럼 보이지만 한 hung type이 모든 tenant/type을 막는다. 반면 BullMQ concurrency는 job type마다 적용되어 total이 types×concurrency다.

완료 조건:

- [x] global pool size, per-tenant cap, per-type cap의 의미를 public contract로 고정한다.
- [x] bounded in-memory execution pool에서 다른 tenant/type은 cap 안에서 진행한다.
- [x] same tenant cap과 fairness weight가 실제 active invocation을 센다.
- [x] BullMQ의 per-worker/total concurrency 의미와 차이를 문서화하고 필요하면 global bound option을 추가한다.
- [x] shutdown drain, timeout ownership, worker-loop error가 pool slot을 누수하지 않는다.

검증: 프로필 A/C. Public option 추가는 minor. 비범위: distributed BullMQ tenant fairness.

### `JOBS-M07` — centralized fail-closed enqueue/config validation

- 상태: `P1 / DONE`; 로컬 code/docs/test 완료, §9 M06–M09 인계 참조

완료 조건:

- [x] attempts/concurrency는 positive safe integer다.
- [x] delay/timeout/TTL/backoff는 finite하고 허용 범위다; Invalid Date와 overflow를 거부한다.
- [x] job type/job types, job ID, idempotency/dedupe key는 exact non-empty/length contract를 갖는다.
- [x] dedupe scope/mode와 backoff type은 runtime exact enum이며 invalid 값이 global/other mode로 fall through하지 않는다.
- [x] direct backend와 JobsService/defaults 경로가 동일한 stable error를 사용한다.
- [x] side effect/identity reservation 전에 validation한다.

검증: 프로필 A/B/D. Previously accepted invalid input 거부는 `0.4.0`에 묶는 것을 기본으로 한다.

### `JOBS-M08` — system shard와 real tenant identity 분리

- 상태: `P1 / DONE`; 선행 `JOBS-M07`; 로컬 code/docs/test 완료, §9 M06–M09 인계 참조

완료 조건:

- [x] missing tenant는 internal tagged system shard를 사용하고 user string `__default__`와 충돌하지 않는다.
- [x] public event/context에는 missing tenant가 계속 `undefined`로 보인다.
- [x] enqueue/retry/replay/setWeight/snapshot에서 동일 encoding을 쓴다.
- [x] real tenant ID validation과 reserved namespace 정책을 문서화한다.

검증: 프로필 A/C.

### `JOBS-M09` — backend-portable recursive serialization

- 상태: `P1 / DONE`; 선행 `JOBS-M07` validator 구조; 로컬 code/docs/test 완료, §9 M06–M09 인계 참조

완료 조건:

- [x] payload/context/metadata의 JSON-safe 또는 명시적 structured contract를 선택한다.
- [x] nested BigInt/function/symbol/Map/Set/custom prototype/cycle/Invalid Date, depth/size를 enqueue side effect 전에 동일하게 처리한다.
- [x] InMemory와 BullMQ가 같은 valid value를 같은 semantic value로 전달하고 invalid value에 같은 error family를 낸다.
- [x] reserved envelope keys와 AbortSignal non-enumerable runtime field 계약을 보존한다.

검증: 프로필 A/B/D. 비범위: business payload schema library 내장.

### `JOBS-M10` — BullMQ producer/worker/both 역할

- 상태: `P1 / DONE`

로컬 완료 근거: §9 전체 유지보수 실행 인계. 공개 merge/release와 분리한다.

완료 조건:

- [x] module mode를 producer-only, worker-only, both 중 명시한다.
- [x] producer-only는 BullMQ Worker를 만들거나 durable job을 소비하지 않는다.
- [x] worker mode는 intended handler 부재를 bootstrap에서 fail-fast하고 dynamic registration escape를 명시한다.
- [x] two-process Redis test에서 producer app이 handler 없는 job을 실패시키지 않는다.
- [x] current default의 호환/마이그레이션과 semver를 ADR로 정한다.

검증: 프로필 A/B/D. Option/default 변화는 minor.

### `JOBS-M11` — terminal record와 identity retention

- 상태: `P1 / DONE`; 선행 `JOBS-M03`, `JOBS-M07`

로컬 완료 근거: §9 전체 유지보수 실행 인계. 공개 merge/release와 분리한다.

완료 조건:

- [x] InMemory와 BullMQ에 bounded retention option/cleanup contract를 둔다.
- [x] payload/context/metadata/PII 보존 기간과 operator 책임을 문서화한다.
- [x] terminal record 삭제가 active idempotency/dedupe mapping을 orphan/release해 재실행시키지 않는다.
- [x] Outbox retry+operator recovery horizon보다 짧은 retention에 경고 또는 validation을 제공한다.
- [x] long-run fixture에서 record/history/identity memory·Redis key count가 정책 안에 머문다.

검증: 프로필 A/B/C. 비범위: Jobs가 Outbox DB를 역조회하는 의존성.

### `JOBS-M12` — release trust boundary와 least privilege

- 상태: `P1 / EXTERNAL`

완료 조건:

- [x] reusable verify는 `contents:read`만 가지고 OIDC/write를 받지 않는다.
- [x] npm publish job만 `id-token:write`, GitHub Release job만 `contents:write`를 가진다.
- [ ] protected main의 matching immutable tag/manifest만 publish한다.
- [x] privileged third-party/official Actions는 reviewed commit SHA 또는 approved allowlist를 쓴다.
- [ ] main/tag ruleset, required checks, force-push/tag 이동 차단, npm environment review/deployment policy를 관리자 설정 증거와 함께 기록한다.
- [ ] 관리자 설정 변경 전 read-only before-state와 대상 repo/environment를 캡처하고 명시적 권한 범위 안에서만 변경한다. 권한이 없으면 `EXTERNAL`로 인계한다.

검증: 프로필 E. Settings가 남으면 task를 `EXTERNAL`로 인계하고 부분 DONE 처리하지 않는다.

로컬 workflow/policy 검증은 완료했으나 main 보호·tag 불변성·npm environment/trusted publisher 설정 증거는 없다. 정확한 before-state와 적용할 정책은 [release-settings-required.md](./release-settings-required.md)에 있다.

### `JOBS-M13` — advisory-safe BullMQ v5 floor

- 상태: `P1 / DONE`

로컬 완료 근거: §9 전체 유지보수 실행 인계. 공개 merge/release와 분리한다.

완료 조건:

- [x] 검증한 첫 safe v5와 latest-compatible v5를 exact Redis matrix로 실행한다.
- [x] peer lower bound, dev dependency, lockfile, packed assertion을 같은 값으로 맞춘다.
- [x] BullMQ 미설치 core consumer가 계속 통과한다.
- [x] production audit zero를 유지하고 optional peer advisory exposure를 문서화한다.
- [x] lower-bound 상승의 migration/semver를 기록한다.

검증: 프로필 A/B/D/E. BullMQ 6은 P4다.

### `JOBS-M17` — published artifact identity

- 상태: `P1 / DONE` (로컬 code/policy/negative artifact 검증); 실제 publish는 M12/REL gate 대기
- pack-once graph를 보존하되 existing version rerun에서 candidate tgz digest와 registry integrity/attestation subject를 비교한다.
- 같은 version의 다른 bytes면 GitHub Release까지 hard fail한다.
- allowlist/size/version/CHANGELOG도 검증한다. 프로필 D/E.

## 5. P2 작업 명세

### `JOBS-M14` — immutable history reads

- 상태: `P2 / DONE` (로컬); §9 참조

history array뿐 아니라 entry, Date, error/metadata까지 deep snapshot해 caller mutation이 저장 상태를 바꾸지 못하게 한다. 프로필 A.

### `JOBS-M15` — Fake drain exhaustion의 명시적 실패

- 상태: `P2 / DONE` (로컬); §9 참조

iteration limit 도달 시 성공 resolve하지 않고 result 또는 typed `jobs_drain_limit_exceeded`를 반환한다. 1001 ready jobs, infinite retry, future-delayed-idle을 구분한다. 프로필 A.

### `JOBS-M16` — backend fault와 worker-loop recovery

- 상태: `P2 / DONE` (로컬); §9 참조

`moveToActive/ack/fail/getJob` throw와 commit-then-throw를 fault backend로 검증한다. unknown commit은 자동 반대 전이로 덮지 않고 reconciliation하며 scheduler lease를 안전하게 release/requeue한다. 단일 tick 오류가 auto loop를 영구 종료하지 않게 error hook/backoff를 둔다. 프로필 A/C.

### `JOBS-M18` — Node/Nest 현재 지원 정책

- 상태: `P2 / DONE` (로컬); §9 참조

Node 20 EOL 이후 22/24 기본화와 제거 시점을 ADR로 정한다. exact Nest 12 strict install/module/Redis/packed consumer proof 전 peer를 넓히지 않는다. engines/peers/README/CI/release가 같은 표를 사용한다. Node 26은 LTS 전 candidate lane만 허용한다. 프로필 A/B/D/E.

### `JOBS-M19A/B/C` — dev toolchain audit waves

- 상태: 세 작업 모두 `P2 / DONE` (로컬); 호환 lock refresh → Jest 30 → supported ESLint flat config 순서로 적용했다. 최신 테스트 수와 exact tuple은 §9를 따른다.

- `M19A`: compatible lock refresh/override로 high-risk 경로를 우선 줄이고 exception에 owner/reason/expiry를 둔다.
- `M19B`: Jest 30과 compatible ts-jest/config migration을 독립 PR로 한다.
- `M19C`: ESLint/typescript-eslint compatible flat config migration을 독립 PR로 한다.

각 후보는 lint/typecheck/전체 unit/Redis/coverage/packed matrix를 실행한다. 151은 조사 시점의 역사 수치이며 현재 suite 수는 §9를 따른다. `npm audit fix --force`, Nest/BullMQ 지원 제거, TypeScript 7 동시 migration은 금지한다.

### `JOBS-M20` — historical docs와 README 위생

- 상태: `P2 / DONE` (로컬); §9 참조

v0.1/v0.2 superpowers plans에 `HISTORICAL/COMPLETED/SUPERSEDED`와 재개 금지 banner를 넣고 이 문서를 가리킨다. README의 `0.3.0` 고정 limitation/release 예시는 current-version-neutral하게 만든다. 기존 dirty handler plan은 어떤 변경에도 포함하지 않는다.

### `JOBS-M21` — modern Outbox gate generalization

- 상태: `P2 / DONE` (로컬); §9 참조

TEN-M21 exact 0.2.1 lane은 historical anchor로 그대로 둔다. 이번 실행에서 게시 Outbox 0.3.0을 확인했고, 같은 Jobs candidate의 0.2.1/0.3.0 strict consumer를 모두 검증했다. optional peer는 `^0.2.1 || ^0.3.0`이다. 별도 manifest/input lane이 exact package spec/tarball, expected version, integrity/lock을 받아 minimum/latest-compatible producer contract를 검증하게 한다. floating `latest`는 금지한다. 프로필 D/E.

### `JOBS-M22` — integration 상태, admin plane, legacy bridge

- 상태: `P2 / EXTERNAL` — 저장소 내 구현/문서/검증은 완료, 외부 완료 조건은 §9 참조

- Outbox `SENT`, Jobs terminal states, response-loss, `unmapped:'ignore'` 의미를 표로 고정한다.
- Jobs get/replay/discard가 trusted control plane임을 명시하고 tenant-facing expected-tenant helper 또는 filter contract를 제공한다.
- 패키지가 RBAC를 import하지 않고 caller authorization 책임을 예제로 보인다.
- `JobsOutboxBridge`는 compatibility-only/deprecated로 남기고 first-party Outbox 사용자를 `createOutboxJobsPublisher()`로 안내한다. runtime 제거는 하지 않는다.
- co-located Outbox poller는 `onApplicationShutdown`까지 publish할 수 있지만 Jobs는 `onModuleDestroy`에서 먼저 admission/backend를 닫을 수 있는 ordering gap을 Nest 10/11 module test로 고정한다. Outbox가 먼저 poll을 멈추거나 shutdown publish가 retriable Outbox 상태로 남는 소유권을 두 패키지 문서와 `TEN-ECO-NEXT`에 명시하고, shutdown 때문에 retry budget이 terminal `FAILED`까지 소진되지 않게 한다.

### `JOBS-M23` — Redis-backed coverage contract

- 상태: `P2 / DONE` (로컬); §9 참조

Redis 없는 coverage 실패를 명확히 안내한다. global/BullMQ critical branch threshold는 실제 P0/P1 error/race test로 여유 있게 올리고 artifact summary에 exact tuple/ref를 기록한다. 수치만 위한 line test는 금지한다.

### `JOBS-M24` — repository security/ownership/update policy

- 상태: `P2 / EXTERNAL` — 저장소 내 구현/문서/검증은 완료, 외부 완료 조건은 §9 참조

`SECURITY.md`, supported versions/private reporting, CODEOWNERS, Dependabot/Renovate grouping, Redis TLS/ACL, untrusted producer boundary, payload size/PII/redaction/retention guidance를 추가한다. Action pinning은 `JOBS-M12`와 중복 구현하지 않는다.

### `JOBS-REL-01` — next release gate

- 상태: `release / BLOCKED`; 선행 `JOBS-M01–05`, `JOBS-M12–13`, `JOBS-M17`
- `JOBS-M01–05`의 semver 메모를 종합해 patch/minor version을 결정하고 manifest/lock/README/CHANGELOG를 맞춘다.
- `JOBS-M12`, `JOBS-M17`의 least-privilege/pack-once workflow와 safe BullMQ v5 floor인 `JOBS-M13`을 release commit에 포함한다.
- 모든 선행 작업이 merge된 release commit에서 프로필 A/B/D/E, 프로필 C의 `JOBS-M01–05` P0 subset, exact P0 regression을 실행한 candidate tgz를 한 번만 만들고 그 exact artifact만 publish한다. 아직 선행이 아닌 `JOBS-M06`/`JOBS-M16` 시나리오를 release 완료 조건으로 암묵적으로 끌어오지 않는다. 이전 task branch artifact를 재사용하지 않는다.
- release commit이 fetched protected main에 포함되고 matching immutable tag가 같은 commit을 가리키는지 확인한다.
- npm integrity/provenance/attestation과 GitHub Release를 확인하고 candidate digest를 작업 기록에 남긴다.
- `TEN-M21`을 재개하거나 `TEN-ECO-NEXT`를 package publish 선행 조건으로 만들지 않는다.

## 6. P3와 P4

### P3 유지보수

- `JOBS-M25`: actual lease TTL expiration, producer SIGKILL before/after reserve/add, Redis disconnect/restart, stalled worker recovery를 검증한다. loopback-only disposable Redis와 unique namespace/project만 사용하고, 세션이 spawn해 PID를 기록한 process만 kill하며 shared Redis를 `FLUSH`/restart하지 않는다. 기존 synthetic lock-loss test를 대체하지 않고 확장한다.
- `JOBS-M26`: randomized reference state machine으로 terminal monotonicity, attempt monotonicity, at-most-one live identity, no partial composite mapping을 검증하고 retention/concurrency soak와 benchmark baseline을 둔다.
- `JOBS-M27`: actual deep import inventory 후 explicit `exports` 도입 여부를 ADR로 결정한다. 도입 시 CJS/root/types/package.json/optional-peer packed consumers와 migration을 둔다.
- `JOBS-M28`: P0–P2 Redis contract 고정 후 큰 BullMQ backend를 identity lock, codec, lifecycle, resource ownership 내부 모듈로 나눈다. public behavior/export를 바꾸지 않는다.

### P4 연구 후보

| ID         | 후보                                                     | 승격 전 필수 산출물                                                     |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `JOBS-B01` | BullMQ distributed tenant fairness/global cap/rate limit | BullMQ Pro Groups vs custom dispatcher ADR, failover/cost/metrics spike |
| `JOBS-B02` | BullMQ 6                                                 | v5 safe floor 안정화 후 exact migration matrix                          |
| `JOBS-B03` | Node 26 LTS                                              | 2026-10-28 이후 official LTS와 packed/Redis evidence                    |
| `JOBS-B04` | dual ESM/CJS, TypeScript 7                               | package consumer/interop ADR                                            |
| `JOBS-B05` | durable history/DLQ/timeout administration               | backend capability와 retention/source-of-truth 설계                     |
| `JOBS-B06` | cron/flows/new backend/dashboard                         | product RFC와 operational ownership                                     |
| `JOBS-B07` | SBOM/Scorecard/reproducible build                        | threat model과 CI cost/verification 설계                                |
| `JOBS-B08` | multi-target Outbox fan-out/exactly-once                 | partial success saga/record model; loop implementation 금지             |

P4는 현재 release의 acceptance가 아니다.

## 7. 검증 프로필

### 프로필 A — core

```bash
export JOBS_START_REF="$(git rev-parse origin/main)"
npm ci
npm run --if-present clean
npm run lint
npx --no-install tsc -p tsconfig.json --noEmit
npm run build
npm test -- --runInBand
npm audit --omit=dev
npm pack --dry-run
git diff --check "$JOBS_START_REF"...HEAD
git diff --check
git diff --cached --check
git status --short
```

전용 worktree에서 실행하고 `git status --short`의 모든 파일을 설명한다. untracked file은 diff check에 잡히지 않으므로 formatter/checker를 path에 직접 실행한 뒤 path-scoped `git add`만 사용한다. `git add -A`를 쓰지 않고 기존 dirty handler 문서가 index에 없음을 확인한다.

### 프로필 B — Redis/BullMQ

compose file은 고정 host port `16379`를 쓴다. Redis 프로필은 한 번에 한 세션만 실행하고, 포트가 사용 중이면 소유자를 확인하기 전 시작·종료하지 않는다.

```bash
export JOBS_COMPOSE_PROJECT=jobs-mxx-unique
lsof -nP -iTCP:16379 -sTCP:LISTEN || true
docker compose -p "$JOBS_COMPOSE_PROJECT" -f docker-compose.redis.yml up -d --wait
REDIS_URL=redis://127.0.0.1:16379 npm run test:redis
REDIS_URL=redis://127.0.0.1:16379 npm run test:coverage
```

`lsof` 결과에 모르는 process가 있으면 중단한다. 세션이 직접 시작한 정확한 compose project만 종료한다.

```bash
docker compose -p "$JOBS_COMPOSE_PROJECT" -f docker-compose.redis.yml down
```

### 프로필 C — lifecycle/concurrency/fault

- enqueue↔close race와 active+queued+delayed drain
- stale activation ack/fail/cancel/replay
- signal-ignore timeout/late settle/never settle
- cross-type/tenant cap과 shutdown pool drain
- commit-before-throw backend fault/reconciliation

barrier, fake clock, explicit eventual assertion을 사용하고 arbitrary sleep에 의존하지 않는다.

### 프로필 D — packed consumers

```bash
npm pack --dry-run
OUTBOX_PACKAGE=@nestarc/outbox@0.2.1 npm run test:consumer:modern
```

modern consumer script가 Jobs를 별도 temp directory에 직접 build/pack하고 그 tarball을 설치한다. 외부에서 만든 candidate tgz를 검증해야 하는 task는 tarball path와 digest를 보존하는 전용 fixture/release artifact를 사용하며 위 script가 같은 artifact를 쓴다고 가정하지 않는다. 각 task에서 strict peer install, `npm ls --all`, core optional-peer absence, runtime smoke, `tsc --strict --skipLibCheck false --noEmit`를 추가한다.

### 프로필 E — release/security

```bash
npm audit --omit=dev
npm audit
```

candidate/published tgz digest와 SRI, attestation subject/ref, tag/main ancestry, workflow permission, ruleset/npm environment 증거를 추가한다.

`npm audit --omit=dev`는 hard zero gate다. 전체 `npm audit`는 `JOBS-M19A–C` 완료 전까지 baseline/delta와 승인된 dev-only 예외를 기록하는 evidence이며 일반 P0/P1의 자동 hard-fail 조건이 아니다.

## 8. 교차 패키지와 release 순서

```text
Outbox ── publisher record ──> Jobs Outbox adapter ──> Jobs backend/worker
   │                               │                         │
   └ claim·lease·SENT 소유          └ mapping/lineage 소유      └ identity/execution 소유
```

- Outbox는 Jobs를 모르고 Jobs가 optional adapter를 소유한다.
- Tenancy는 validator/context runner를 애플리케이션에서 제공할 수 있지만 Jobs runtime dependency가 아니다.
- 구현은 병렬 가능하다: Outbox claim fencing과 Jobs P0 adapter/state tasks는 서로 package source/candidate tgz로 끝낸다.
- Jobs release가 새 Outbox P0 계약을 소비할 때의 권장 순서는 Outbox patch/minor → exact published Outbox 또는 candidate tgz로 `JOBS-M21` 검증 → Jobs patch/minor다. Jobs 자체 P0만 고치는 독립 release에는 `OUT-REL-01`을 hard dependency로 두지 않으며, 사용한 Outbox exact version/digest를 release evidence에 남긴다.
- `TEN-ECO-NEXT`는 두 package 게시 뒤 PostgreSQL + Redis/BullMQ에서 transaction commit/rollback, enqueue 성공 뒤 Outbox SENT 전 process loss, restart dedupe, tenant A/B same-key isolation, correlation/causation을 검증한다.
- 이 외부 chaos fixture는 loopback-only disposable DB/Redis, unique compose project/database/namespace를 사용한다. 세션이 spawn해 PID를 기록한 process만 kill하고 shared service를 drop/flush/restart하지 않으며 자신이 만든 resource만 정리한다.
- `TEN-ECO-NEXT`는 package PR의 `DONE`과 순환하지 않는다. `TEN-M21` ID를 재사용하지 않는다.

## 9. 작업 기록

| 날짜       | Task        | 상태   | ref/PR                                       | 검증 결과                                                                 | 다음 정확한 행동                                                           |
| ---------- | ----------- | ------ | -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 2026-09-02 | 계획 기준선 | `DONE` | `origin/main@405e799`, `v0.3.1@7a17344` 조사 | unit 151, lint/typecheck/build, audits, main Redis/coverage evidence 기록 | `JOBS-PLAN-01`로 이 문서만 먼저 review/merge; 기존 dirty handler plan 보존 |
| 2026-09-05 | `JOBS-M01` 사전 확인 | `BLOCKED` | fetched `origin/main@405e799`, local `HEAD@d3d757e` | main/release/npm/CI 재조회 완료; M02/M05 미구현 확인; 구현 및 검증 프로필 미실행 | 선행 작업 M02 → M05 → M01로 범위 확장할지 사용자 답변 대기 |
| 2026-09-05 | `JOBS-M02` | `DONE` (로컬) | `405e799` 기준 미커밋 후보 | activation regression 8건; Nest 10/11 전체 178 PASS | 로컬 변경 review 및 main 반영 |
| 2026-09-05 | `JOBS-M05` | `DONE` (로컬) | `405e799` 기준 미커밋 후보 | timeout ownership regression 4건; Nest 10/11 전체 178 PASS | 로컬 변경 review 및 main 반영 |
| 2026-09-05 | `JOBS-M01` | `DONE` (로컬) | `405e799` 기준 미커밋 후보 | backend close 4건 + module lifecycle 16건; 프로필 A/C PASS | 로컬 변경 review 및 main 반영; 이후 남은 P0 M04 → M03 |
| 2026-09-05 | `JOBS-M04` | `DONE` (로컬) | `1f4c486` 기준 미커밋 후보 | reserved lineage·callback mutation 회귀; 프로필 A/D PASS | M03과 함께 로컬 후보 review 및 main 반영 |
| 2026-09-05 | `JOBS-M03` | `DONE` (로컬) | `1f4c486` 기준 미커밋 후보 | unit 188 / Redis 44 / coverage 232 PASS; packed core·Outbox PASS | 계획 bootstrap 및 P0 후보 main 반영; M12 → M17, M13 release 선행 검토 |
| 2026-09-05 | `JOBS-M06` | `DONE` (로컬) | `f222389` 기준 미커밋 후보 | bounded pool·cross-type tenant/type cap·timeout/fault/shutdown; Nest 10/11 전체 231 PASS | 네 작업 로컬 후보 review 및 main 반영 |
| 2026-09-05 | `JOBS-M07` | `DONE` (로컬) | 동일 | 중앙 입력/default/config 검증, A/B/D PASS | M11/M16/M22 로컬 선행 충족; 공개 main 완료 여부 재확인 |
| 2026-09-05 | `JOBS-M08` | `DONE` (로컬) | 동일 | Symbol system shard, retry/replay/weight/event 회귀; A/C PASS | 네 작업 로컬 후보 review 및 main 반영 |
| 2026-09-05 | `JOBS-M09` | `DONE` (로컬) | 동일 | recursive normalization, Redis 46 / coverage 277 / packed core·Outbox PASS | release 선행 M12 → M17 및 M13은 여전히 별도 작업 |


### 2026-09-05 — JOBS-M01 시작 전 선행 조건 확인

- 당시 요청 범위: `JOBS-M01` 구현 및 완료 후 문서 갱신. 사전 확인 시점에는 선행 조건 미충족으로 `BLOCKED`였으며, 이후 사용자 승인과 아래 구현·검증으로 해소했다.
- `git fetch --tags origin main:refs/remotes/origin/main` 성공. 최신 main은 여전히 `405e799367023bb5e868588c85e4ff1fca51d4c0`, release tag의 commit은 `7a173442caea6d7d50b09c9fe01a643cd1afb288`이다.
- GitHub Release `v0.3.1` 게시 시각은 `2026-08-23T15:09:01Z`. 최신 main [CI run 33294387914](https://github.com/nestarc/jobs/actions/runs/33294387914)은 fetched SHA에서 `completed/success`다.
- npm `latest`는 `0.3.1`; registry integrity는 `sha512-KgEA3/zWU4cyW3t+UXCAlHfPh/YZTfNl93i7E7oYCB2yHRYbR6RquBPa2tGDZX3oXPO5uV5sc3ogHZwYSi1Eyg==`다.
- 선행 `JOBS-M02` 미구현: `JobsBackend.ack/fail`은 job ID만 받고 `InMemoryBackend`는 matching activation 소유권을 검증하지 않는다.
- 선행 `JOBS-M05` 미구현: `FairWorker.tick`은 timeout의 `Promise.race`가 끝나면 실패/재시도 처리와 scheduler slot 반환을 수행하며, 실제 handler invocation의 settlement는 기다리지 않는다. 따라서 logical loop 대기만으로 M01의 graceful drain 완료를 증명할 수 없다.
- 이 계획 파일은 여전히 untracked이며 fetched main에 없다. `JOBS-PLAN-01`도 완료되지 않았다. 이번 확인에서는 shared claim, stage, commit, push, PR 생성 또는 merge를 수행하지 않았다.
- First RED / 프로필 A·C / Nest 10·11 lifecycle 회귀: 미실행. 선행 계약과 구현 범위를 확정하기 전이므로 source를 변경하거나 완료로 표시하지 않았다.
- 변경 파일: 이 계획 문서만 갱신했다. 기존 dirty `docs/handler-discovery-initialization-plan-2026-08-23.md`는 보존했다.
- 이후 사용자 답변: 선행 작업을 포함한 M02 → M05 → M01 진행을 승인했다. 구현·검증 결과는 아래 완료 인계를 따른다.


### 2026-09-05 — JOBS-M02 → JOBS-M05 → JOBS-M01 완료 인계

- Task / State: `JOBS-M02`, `JOBS-M05`, `JOBS-M01` 모두 `DONE` (로컬 code/docs/test 완료).
- Start ref: fetched `origin/main@405e799367023bb5e868588c85e4ff1fca51d4c0`.
- End ref: `codex/jobs-m01-shutdown`의 위 ref 기준 미커밋 변경. 구현·검증 worktree는 `/private/tmp/jobs-m01-shutdown`이며, 검증한 변경을 원래 작업 경로에도 반영했다. 원래 checkout의 branch/HEAD와 기존 dirty handler 계획은 보존했다.
- 작업 범위: 사용자가 선행 M02/M05까지 승인하여 순차 구현했다. remote shared claim, commit, push, PR, merge, release는 수행하지 않았다. 작업 간 소유 계약은 아래에 분리해 기록하며, bootstrap 및 main 반영은 별도 후속 작업이다.

#### 계약과 semver 결정

| Task | 구현 계약 | 회귀 증거 |
| --- | --- | --- |
| M02 | activation UUID와 matching active state를 검증하는 `ack/fail/markFailed`; 무효·queued·terminal·stale completion은 `jobs_activation_conflict`; terminal cancel은 no-op; same-ID replay는 lifetime attempt를 보존하고 새 retry budget/backoff 기준을 둔다. | `activation-fencing.test.ts` 8건과 기존 backend/DLQ/service 계약 테스트 migration |
| M05 | timeout 즉시 `job.timed_out` 및 AbortSignal; 실제 invocation settlement까지 active 상태와 scheduler slot을 유지하고 이후에만 실패/재시도; worker가 outstanding ID와 idle wait를 제공한다. | `timeout-ownership.test.ts` 4건: late resolve/reject, never-settle 구간, cooperative abort |
| M01 | `open → closing → closed`; admission 및 replay 차단; active/queued/future-delayed/retrying drain; 기본 30초 deadline과 remaining IDs/count 오류; 실제 invocation 종료 후 backend 단일 close | `in-memory-close.test.ts` 4건, `jobs.module.in-memory.test.ts` 전체 16건 중 신규 shutdown 11건 |

- Public backend `ack/fail/markFailed` signature와 `activationFencing` opt-in, lifecycle event union, same-ID replay accounting, shutdown 기본 동작이 바뀌므로 **0.4.0 minor**로 결정했다. package/lock version은 `0.3.1`을 유지하며 실제 version bump/publish는 `JOBS-REL-01`이 소유한다.
- Custom backend는 fresh token 발급과 active/token 원자 검증을 구현한 뒤 `activationFencing: true`를 선언해야 한다. 미선언 backend는 FairWorker 생성 시 fail-closed한다. BullMQ의 자체 worker lock/manual API unsupported 계약은 유지된다.
- Shutdown deadline은 성공 close가 아니다. `JobsShutdownError`의 `code`, `reason`, `remainingJobIds`, `remainingCount`를 관측하며, admission은 닫힌 채 drain이 계속된다. never-settle handler는 협조적 settlement 또는 메모리 유실을 인지한 프로세스 종료가 필요하다. 취소는 실제 JavaScript 실행을 강제 종료하지 않는다.
- 단독 backend는 worker를 구동하지 않으므로 pending record가 있으면 close가 실패하고 내용을 보존한다. 외부 worker 소유자는 `waitForIdle()`을 기다린 뒤 close해야 한다. 성공 close는 in-memory record/history/identity resources를 해제한다.
- 즉시 settle하는 재시도에도 drain loop가 timer에 실행 기회를 주도록 하며, finite 100회 retry fixture에서 deadline이 전체 retry 완료 전에 실패를 보고함을 확인했다.
- Delayed job은 실행 가능 시각 이전이어도 pending 집계에 포함한다. Nest 10/11 모두 feature dependency destroy 전에 drain하며, 동시 close 두 번과 완료 후 재호출에서도 backend close는 한 번이다.

#### RED와 최종 검증

| 구분 | 명령 / 결과 |
| --- | --- |
| M02 First RED | `npm test -- --runInBand test/integration/activation-fencing.test.ts`: 4 FAIL. queued ack가 attempt 0에서 succeeded로 resolve; activation token 없음; cancelled/replayed job의 late ack 허용 |
| M05 First RED | `npm test -- --runInBand test/integration/timeout-ownership.test.ts`: 4 FAIL. signal-ignore invocation이 남아도 tick resolve/slot 반환; timeout event 없음 |
| M01 First RED | `npm test -- --runInBand test/integration/in-memory-close.test.ts`: 2 FAIL. accepted queued work가 close로 삭제되고 post-close enqueue도 resolve |
| 추가 발견 | 미래 delayed 상태를 due-only `isWaiting`으로 pending 집계하면 조기 close가 됨을 active+queued+delayed+retry module 회귀에서 확인하고 수정 |
| Nest 11 기존 테스트 보정 | handler 호출 관찰과 backend ack 완료 사이 race를 확인. `waitForIdle()` 후 terminal 상태를 확인하도록 수정 |
| 설치 | `npm ci --cache /private/tmp/jobs-m01-npm-cache --no-audit --no-fund` PASS; Nest 11 검증 뒤 동일 lockfile의 `npm ci --offline`로 Nest 10 복원 |
| 프로필 A / Nest 10.4.22 | `npm run --if-present clean` (script 없음), `npm run lint`, `npx --no-install tsc -p tsconfig.json --noEmit`, `npm run build`, `npm test -- --runInBand` 모두 PASS; **23 suites / 178 tests** |
| Nest 11.2.1 | `npm install --no-save --package-lock=false --no-audit --no-fund @nestjs/common@11.2.1 @nestjs/core@11.2.1 @nestjs/testing@11.2.1`; 동일 전체 unit **23 suites / 178 tests**, lint/typecheck/build PASS |
| Production audit | `npm audit --omit=dev --json`: **total 0**, PASS |
| Pack | `npm pack --dry-run --json`: PASS. `0.3.1` source candidate이며 게시된 `0.3.1` tarball과 동일 artifact라는 주장을 하지 않음 |
| Diff / 기존 파일 보존 | start ref 대비 path-scoped 변경 확인, `git diff --check`와 cached diff check PASS; 신규 TypeScript 파일 Prettier 직접 검사; 기존 dirty handler plan 미수정·미stage |

- 환경: Node `24.11.1`, npm `11.6.2`; Nest tuple은 common/core/testing 모두 위 exact version이다. package.json과 package-lock.json은 변경하지 않았다.
- 변경 파일: `src/backend/in-memory-backend.ts`, `src/backend/jobs-backend.interface.ts`, `src/errors.ts`, `src/fair-worker.ts`, `src/jobs.module.ts`, `src/lifecycle.ts`, `src/types.ts`; 기존 테스트 `test/contract/backend-contract.ts`, `test/integration/{backend-v0.2-status,idempotency-dlq,jobs.module.in-memory,jobs.service}.test.ts`; 신규 테스트 `test/integration/{activation-fencing,in-memory-close,timeout-ownership}.test.ts`; `README.md`, `CHANGELOG.md`, 이 계획 문서.
- Redis / packed consumer / release/settings: 미실행. 이 세 작업의 acceptance는 프로필 A/C와 Nest 10/11 lifecycle이며 B/D/E 및 publish는 요구하지 않는다. `npm pack --dry-run`만으로 packed runtime 검증 또는 배포 완료를 주장하지 않는다. Redis backend 구현은 변경하지 않았다.
- Remaining risk: in-memory crash durability 없음; signal-ignore handler는 deadline 후에도 남을 수 있음; host의 기존 sequential 처리와 fault recovery는 각각 M06/M16 범위다. co-located Outbox shutdown ordering 조정은 M22 범위다.
- Next exact action: 계획 bootstrap과 이 로컬 후보를 review/PR 절차로 main에 반영한다. 공개 main에서 완료 여부를 재확인한 뒤 남은 P0 `JOBS-M04 → JOBS-M03`을 진행한다. M06은 이 로컬 후보의 선행 조건만 충족됐으며 남은 P0보다 먼저 착수하지 않는다.


### 2026-09-05 — JOBS-M04 → JOBS-M03 완료 인계

- Task / State: `JOBS-M03` 및 필수 선행 `JOBS-M04`, 모두 `DONE` (로컬 code/docs/test 완료).
- 요청 범위: 사용자의 M03 실행 요청을 완료하기 위해 같은 adapter의 선행 M04도 먼저 구현했다. 문서 bootstrap과 main merge를 기다리는 대신 기존 로컬 후보를 이어 구현했으며, shared 완료 상태를 주장하지 않는다.
- Start ref: `main@1f4c4865c37568437bbcfab41115681a7377cae8` (M01/M02/M05 구현 포함). 최초 `git status --short`는 clean. 기존 handler 계획 문서는 읽기 전용으로 보존했다.
- End ref: `codex/jobs-m03-tenant-dedupe`의 위 ref 기준 미커밋 후보. 전용 worktree `/private/tmp/jobs-m03-tenant-dedupe`에서 검증한 7개 파일을 원래 작업 경로에 반영했다. 원래 branch/HEAD는 보존했다. stage, commit, push, shared claim, PR, merge, publish는 수행하지 않았다.
- 외부 기준 재확인: fetch 성공, main `405e799367023bb5e868588c85e4ff1fca51d4c0`, release tag `7a173442caea6d7d50b09c9fe01a643cd1afb288`, npm latest `0.3.1` 유지. GitHub Release 시각 `2026-08-23T15:09:01Z`, [main CI 33294387914](https://github.com/nestarc/jobs/actions/runs/33294387914) `completed/success`. npm integrity도 앞선 기준선과 동일하다.

#### 계약과 semver 결정

- M04: mapping callback 실행 전에 source 필드를 snapshot한다. nested headers를 복제하고 Date occurrence time을 문자열로 보존한다. context 4개 및 metadata 12개 예약 필드를 mapping에서 제거한 뒤 source로 재구성한다. source 값이 없으면 stale mapping 값도 제거하며, custom 필드는 보존한다. tenant 재매핑은 명시적 `target.tenant` 함수만 소유한다.
- M03: mapping dedupe가 있고 scope가 생략되면 resolved tenant가 있는 경우 `tenant`, tenant 없는 optional event는 `global`로 확정한다. 명시적 `global` 및 `tenant` 설정은 보존하며 tenant 없는 명시적 tenant scope는 거부한다. 공유 mapping options를 mutate하지 않는다. generic `JobsService`와 두 backend의 기본값/구현은 변경하지 않았다.
- 원본 record ID를 canonical `jobId`/`idempotencyKey`로 보존한다. dedupe로 축약된 Outbox 이벤트는 별도 job이 없을 수 있으며, 성공 publish/Outbox SENT는 enqueue acknowledgement이지 handler 성공이 아니다. README에 해당 의미를 명시했다.
- Semver: M03/M04 자체는 correctness **patch**이며 global opt-in의 public shape를 변경하지 않았다. 기존 M01/M02/M05의 `0.4.0` minor 결정은 유지한다. package/lock version은 `0.3.1` 그대로이며 실제 version bump는 `JOBS-REL-01` 범위다.

#### RED와 최종 검증

| 구분 | 명령 / 결과 |
| --- | --- |
| First RED | `npm test -- --runInBand test/integration/outbox-jobs-publisher.test.ts`: **6 FAIL / 8 PASS**. M03 tenant B job 유실 및 remap dedupe 2건, M04 stale lineage 및 tenant/options/payload callback의 canonical identity 변조 4건 |
| M04 단독 수정 뒤 | 같은 명령 **2 FAIL / 12 PASS**; M04 회귀는 통과하고 M03 tenant dedupe 2건만 실패 |
| Redis First RED | `REDIS_URL=redis://127.0.0.1:16379 npm run test:redis -- -t 'keeps Outbox tenants'`: **1 FAIL / 2 PASS / 41 skipped**. scope 누락 시 2개 대신 1개 job; explicit tenant/global은 기대대로 동작 |
| Adapter 최종 회귀 | `npm test -- --runInBand test/integration/outbox-jobs-publisher.test.ts`: **16 PASS**. 기본/explicit tenant/global, same-ID redelivery, explicit remap, optional tenantless, generic default, callback mutation 포함 |
| 설치 | `npm ci --cache /private/tmp/jobs-m03-npm-cache --no-audit --no-fund`: PASS |
| 프로필 A | `npm run --if-present clean` (script 없음), `npm run lint`, `npx --no-install tsc -p tsconfig.json --noEmit`, `npm run build`: PASS. `npm test -- --runInBand`: **23 suites / 188 tests PASS** |
| 프로필 B | `REDIS_URL=redis://127.0.0.1:16379 npm run test:redis`: **1 suite / 44 tests PASS**. 신규 3건은 concurrent A/B publish, backend 재생성/redelivery 및 실제 handler 실행 검증 |
| Coverage | `REDIS_URL=redis://127.0.0.1:16379 npm run test:coverage`: **24 suites / 232 tests PASS**. global statements/branches/functions/lines **92.24/85.04/97.16/94.42%**; BullMQ **92.56/84.98/94.25/94.36%**, threshold PASS |
| Production audit | `npm audit --omit=dev --json --cache /private/tmp/jobs-m03-npm-cache`: **total 0**, PASS |
| Pack dry run | `npm pack --dry-run --json --cache /private/tmp/jobs-m03-npm-cache`: PASS. 최초 기본 npm cache 쓰기 EPERM은 전용 `/private/tmp` cache로 해소 |
| 프로필 D / modern | `OUTBOX_PACKAGE=@nestarc/outbox@0.2.1 npm_config_cache=/private/tmp/jobs-m03-npm-cache npm run test:consumer:modern`: PASS. exact Outbox **0.2.1**, Nest **11.2.1**, Prisma **7.10.0**, strict peer install, graph/digest assertions, `tsc --strict --skipLibCheck false --noEmitOnError`, runtime smoke. 신규 tenant/global dedupe 및 source lineage 검증 포함 |
| Packed fixture 보정 | 최초 strict compile에서 실제 Outbox의 required `headers: Record<string, string>` 및 optional/unknown job context 타입과 fixture의 불일치를 발견. headers `{}`와 typed optional context 접근으로 수정하여 최종 PASS; production API 타입은 변경하지 않음 |
| 프로필 D / core | `/private/tmp/jobs-m03-core-BjDqi5`에서 동일 digest tarball + exact Nest **10.4.22** strict peer install, `npm ls --all`, BullMQ/Outbox 모두 `MODULE_NOT_FOUND`, Nest enqueue/shutdown runtime smoke 및 `tsc --strict --skipLibCheck false --noEmit`: PASS |
| Diff / 보존 | start ref 대비 7개 파일 path-scoped 변경 확인, `git diff --check`, `git diff --cached --check`: PASS. handler 계획·package.json·package-lock.json은 미수정·미stage |

- 환경: Node `24.11.1`, npm `11.6.2`; source unit/Redis는 Nest `10.4.22`, BullMQ `5.74.1`. Nest 11은 위 packed gate로 검증했으며 Node 20/22 및 전체 Nest 11 Redis matrix는 이 세션에서 재실행하지 않았다.
- Redis evidence: 비어 있는 host port `16379`를 확인하고 전용 compose project `jobs-m03-20260905` / `redis:7.2-alpine`을 시작했다. 테스트마다 UUID namespace만 정리했고 검증 후 자신이 시작한 compose project만 `down`했다. 여기서 restart는 backend instance 재생성이다. Redis server/process chaos는 M25 범위다.
- Packed artifact: `/private/tmp/jobs-m03-core-BjDqi5/nestarc-jobs-0.3.1.tgz` 보존. SHA-256 `b576d2a6f7ff2ddefd7d6d5f644424f0cd11ba80295a11bd23a20afec954025c`, SRI `sha512-eSCSS7H42CK8Gd5XzhAd0pYjlsTuZlCBzE7qbp/O3Y/MrXjqNLWexlNHCIRZezDLfAb/hZHSmqpZOVTzyiorsg==`. modern gate가 별도로 pack한 artifact와 digest 일치. 게시 Jobs `0.3.1` bytes와는 다르다.
- Published Outbox `0.2.1` SRI: `sha512-VfxGSeRgKk9MVFCCbvzym2nk6I+qfkoFzY1B04I7y40nZSMaXn4Nh0t+FDgH4OT90ZYZDrGJVQbwNNmzEDkKcw==`. modern gate 로그 `/private/tmp/jobs-m03-modern-consumer.log`, core dependency tree `/private/tmp/jobs-m03-core-BjDqi5/dependency-tree.txt`.
- 변경 파일: `src/outbox/outbox-jobs-publisher.ts`, `test/integration/outbox-jobs-publisher.test.ts`, `test/redis/bullmq-backend.redis.test.ts`, `test/consumer/modern-outbox.ts`, `README.md`, `CHANGELOG.md`, 이 계획 문서.
- Remaining risk: 이미 global dedupe로 축약되어 SENT가 된 이벤트는 자동 복구되지 않는다. 기존 global 예약이 남은 상태의 과거 이벤트 재전달/롤아웃은 별도 운영 판단이 필요하며, exactly-once side effects와 기존 유실의 자동 복구를 보장하지 않는다. arbitrary mapping option 입력 검증은 M07, 일반 serialization은 M09 범위다.
- Next exact action: bootstrap 및 P0 로컬 후보를 review/PR 절차로 main에 반영한다. release 직접 선행 `JOBS-M12 → JOBS-M17` 및 `JOBS-M13`을 검토한 뒤 `JOBS-REL-01`을 진행한다. 위의 과거 인계에서 남아 있던 M04 → M03 재실행 지시는 이 기록으로 대체한다.

### 2026-09-05 — JOBS-M06–M09 완료 인계

- Task / State: `JOBS-M06`, `JOBS-M07`, `JOBS-M08`, `JOBS-M09` 모두 `DONE` (로컬 code/docs/test 완료).
- 요청 범위: 사용자가 네 작업 모두 진행 및 완료 후 이 문서 업데이트를 지시했다. 문서의 한 세션/한 작업 제한 및 bootstrap 대기 대신 기존 M01–M05 로컬 후보를 이어 구현했다. public 완료나 shared claim을 주장하지 않는다.
- Start ref: clean `main@f22238929fdda0da4c85142171667cfbfda44425` (M01–M05 포함).
- End ref: 같은 commit 기준 `codex/jobs-m06-m09`의 미커밋 후보. 전용 worktree `/private/tmp/jobs-m06-m09`에서 검증한 파일을 원래 `/Users/ksy/Documents/GitHub/jobs`에 반영했다. 원래 branch/HEAD를 보존했다. stage, commit, push, shared claim, PR, merge, publish는 수행하지 않았다.
- 외부 기준: fetch 성공, `origin/main@405e799367023bb5e868588c85e4ff1fca51d4c0`, `v0.3.1@7a173442caea6d7d50b09c9fe01a643cd1afb288` 유지. GitHub Release 게시 시각 `2026-08-23T15:09:01Z`, [main CI 33294387914](https://github.com/nestarc/jobs/actions/runs/33294387914) `completed/success`. npm latest `0.3.1`, integrity는 앞선 기준선과 동일하다.

#### 확정 계약과 semver

| Task | 구현 계약 | 검증 증거 |
| --- | --- | --- |
| M06 | 모듈 전체 `concurrency.poolSize=10`, cross-type `tenantCap=10`, 각 타입 `typeCap=poolSize`; 공유 budget을 scheduler pick 전에 예약하고 실제 invocation settlement 후 반환한다. 타입 간 순환 선택과 타입 내부 weighted/min-share dispatch를 유지한다. | 두 타입·다섯 job을 barrier로 묶어 global 3/tenant 1/type 2 상한 및 shutdown drain 확인. timeout 뒤 동일 tenant 차단·다른 tenant 진행·settle 후 retry 확인. backend move failure에서 inflight 0 및 remaining ID/worker_error 확인. 기존 fairness/activation/shutdown 회귀 유지. |
| M07 | service raw/effective defaults, module registration 및 두 direct backend에서 동일 `jobs_invalid_input` 검증. attempts/concurrency positive safe integer, timer-safe finite durations, 유효 Date/horizon, identifier 길이, exact enum을 side effect 전에 확인한다. | invalid options/tenant/identifier/defaults/null config 거부, invalid enqueue 후 같은 identity를 정상 생성할 수 있음. Redis waiting/delayed/active 0 확인. backoff overflow가 0으로 돌아가지 않고 timer 최대값에서 포화. |
| M08 | 내부 Symbol key로 system shard와 모든 real tenant string을 분리한다. public picked/snapshot/context/events는 missing tenant를 `undefined`로 표시하고 weight API도 undefined를 받는다. | real `__default__` weight 0 상태에서 system job retry/replay 진행, 별도 shard snapshot, weight 재활성화 및 terminal/start event tenant 확인. |
| M09 | plain-record root의 재귀 JSON 정규화와 snapshot. nested Date→ISO, object undefined 생략, array holes/undefined→null, -0→0. 비JSON 값·custom prototype·accessor·cycle 거부, envelope/metadata 각각 1 MiB 보수적 traversal budget 및 depth 64. | payload/context/metadata nested invalid matrix, source mutation isolation, 예약 키·getter 미호출·non-enumerable signal, Redis instance 재생성 후 record 및 handler value parity, packed core/Outbox strict 타입·runtime 검증. |

- **0.4.0 minor**에 포함한다. default pool이 기존 실질 serial 동작을 바꾸므로 호환 설정은 `poolSize: 1`이다. `ShardSnapshot`/`PickedJob.tenantId`의 undefined 허용과 invalid input/serialization 거부도 migration 대상이다. package.json/package-lock.json의 version은 `0.3.1`을 유지하며 bump/publish는 `JOBS-REL-01`이 소유한다.
- BullMQ `workerConcurrency=10`은 각 job-type Worker별 값이며 한 process의 N개 type은 최대 N×concurrency다. shared Jobs global cap/tenant fairness/distributed bound를 추가하지 않고 차이를 명시했다.
- Duration 계약: delay/TTL/backoff는 `[0, 2147483647]` ms, timeout은 `[1, 2147483647]` ms, shutdown timeout은 이 범위의 정수다. scheduledFor는 valid Date이며 미래 horizon이 같은 상한 이내여야 한다. Job type은 최대 256 UTF-16 code units/colon 금지, ID/key/tenant는 최대 1024, 모두 non-blank이며 원문을 trim/coerce하지 않는다. Dedupe/backoff의 기존 valid defaults와 schedule precedence는 보존한다.
- Generic dedupe의 missing scope는 계속 global이며 Outbox adapter의 tenant-safe default는 보존한다. Missing tenant를 `__default__`로 바꾸는 compatibility alias는 두지 않는다.
- Worker backend 오류는 capacity를 반환하고 automatic dispatch를 중단하며 shutdown에서 pending IDs와 worker_error를 보고한다. unknown commit reconciliation과 자동 loop 복구는 M16의 책임으로 남긴다. actual invocation이 settle하지 않으면 timeout 후에도 slot을 보유하고 shutdown deadline이 실패한다.
- Payload/context/metadata의 nested Date를 쓰던 handler는 ISO 문자열로 타입·로직을 이전해야 한다. Buffer/class/Map/Set은 producer에서 명시적으로 portable record/string으로 바꾼다. Raw backend envelope의 context가 authoritative다. Replay metadata도 재귀 validation 후 적용한다.

#### RED 및 최종 검증

| 구분 | 명령 / 정확한 결과 |
| --- | --- |
| M07/M09 First RED | 시작 ref를 `/private/tmp/jobs-m06-baseline`에 export하고 신규 `maintenance-input.test.ts`를 적용: **28 FAIL / 0 PASS**. 잘못된 attempts/duration/enum/config 및 nested nonportable 값이 성공 접수되고 Date가 그대로 남음. 로그 `/private/tmp/jobs-m06-input-red.log`. 최초 fixture compile typo는 수정 후 이 behavioral RED를 확보했다. |
| M06/M08 First RED | `npm test -- --runInBand test/integration/maintenance-pool.test.ts`: **3 FAIL**. 첫 type barrier가 나머지 type을 차단, system/real default shard 충돌, lifecycle missing tenant에 sentinel 노출. 로그 `/private/tmp/jobs-m06-pool-red.log`. |
| 설치 | 전용 cache를 사용하는 `npm ci` PASS. 초기 restricted network 설치 오류 후 동일 lockfile로 설치 완료. Nest 11 검사 후 `npm ci --offline --cache /private/tmp/jobs-m06-install-cache`로 Nest 10 복원. |
| 프로필 A / Nest 10.4.22 | `npm run --if-present clean` (script 없음), `npm run lint`, `npx --no-install tsc -p tsconfig.json --noEmit`, `npm run build` PASS. `npm test -- --runInBand`: **25 suites / 231 tests PASS**. 로그 `/private/tmp/jobs-m06-unit.log`. |
| 프로필 C / Nest 11.2.1 | common/core/testing exact 11.2.1을 `--no-save --package-lock=false`로 설치. lint/typecheck/build 및 전체 unit **25 suites / 231 tests PASS**. 로그 `/private/tmp/jobs-m06-nest11-unit.log`. |
| 프로필 B | 전용 Redis의 `npm run test:redis`: **1 suite / 46 tests PASS**, 신규 2건은 다중 invalid case/identity 미예약 및 normalized handler parity를 포함. 로그 `/private/tmp/jobs-m06-redis.log`. |
| 최종 coverage | `REDIS_URL=redis://127.0.0.1:16379 npm run test:coverage`: **26 suites / 277 tests PASS**. global statements/branches/functions/lines **92.64/86.13/98.00/94.51%**, BullMQ **92.62/84.30/95.40/94.41%**, threshold PASS. 로그 `/private/tmp/jobs-m06-coverage.log`. |
| Production audit / dry pack | `npm audit --omit=dev --json`: **total 0 PASS**. `npm pack --dry-run --json`: PASS. 실제 최종 candidate도 build/pack 및 strict 설치 검증. |
| 프로필 D / modern | `OUTBOX_PACKAGE=@nestarc/outbox@0.2.1 npm run test:consumer:modern`: PASS. exact Outbox **0.2.1**, Nest **11.2.1**, Prisma **7.10.0**, strict peer graph/digest 및 strict tsc/runtime. 새 JSON/invalid input fixture 포함. 로그 `/private/tmp/jobs-m06-modern.log`. |
| 프로필 D / core | `/private/tmp/jobs-m06-core-BASYXo`에서 최종 tarball + exact Nest **10.4.22**, strict peer install/`npm ls --all`, BullMQ·Outbox `MODULE_NOT_FOUND`, `tsc --strict --skipLibCheck false --noEmitOnError`, Nest 2-slot parallel/system shard/JSON/signal/shutdown smoke PASS. 설치 lock integrity와 artifact SRI 일치. |
| 검토 / 파일 보존 | 시작 ref 대비 path-scoped diff, `git diff --check`, cached diff check PASS; 신규 TS도 Prettier 직접 검증. handler 계획·package.json·package-lock.json 미수정·미stage. |

- Packed fixture에서 취소된 선두 job이 있으면 기존 fake drain이 뒤의 ready job 전에 종료하는 동작을 관찰했다. 신규 portability fixture를 별도 fake instance로 분리해 기존 Outbox gate와 독립시켰다. production fake drain을 이번 범위에서 변경하지 않았으며 이 관찰은 M15 후속 검토에 남긴다.
- 환경: Node **24.11.1**, npm **11.6.2**, source/Redis Nest **10.4.22**, BullMQ **5.74.1**. Node 20/22 및 전체 Nest 11 Redis matrix는 이 세션에서 재실행하지 않았다. Nest 11은 전체 unit/lifecycle와 packed modern으로 검증했다.
- Redis: 미사용 loopback port `16379` 확인 후 전용 compose project `jobs-m06-m09-20260905`의 `redis:7.2-alpine` 사용. UUID queue namespace만 정리하고 완료 후 자신이 생성한 compose project만 `down`했다. Redis process/server chaos는 실행하지 않았다.
- 최종 artifact: `/private/tmp/jobs-m06-core-BASYXo/nestarc-jobs-0.3.1.tgz`. SHA-256 **`a6a099636f8e247d7219137fb15399c577a1523b5875064f23d320083920379c`**, SRI **`sha512-Dvn5Mtgr8cuoDMORGUOQP7QKxkzShJZjzqYZwhhbHiGowf3Wpf4Ylss4UU1jrqhZ2QFV0LSSd93TQ30aP9yv6Q==`**. modern gate에서 독립적으로 pack한 candidate와 digest 일치. 게시 Jobs 0.3.1 artifact와 동일 bytes가 아니다.
- 변경 파일: source `src/{enqueue-validation,context-serializer,portable-value,execution-budget,errors,fair-worker,jobs.module,jobs.service,retry,scheduler,types}.ts`, 두 backend; source tests `src/{context-serializer,retry,scheduler}.test.ts`; 신규 integration `maintenance-input.test.ts`, `maintenance-pool.test.ts`; 기존 integration `idempotency-dlq`, `jobs.module.in-memory`, `jobs.service`; Redis fixture; consumer `modern-outbox.ts`, 신규 `maintenance-core.ts`; README, CHANGELOG, 이 계획 문서.
- Remaining risk: in-memory crash durability 없음; hung invocation이 cap을 보유하며 pool 전체가 소진되면 진행할 수 없음; weight는 elapsed execution time이 아닌 dispatch 기회에 적용됨; BullMQ에는 cross-type/global tenant bound 없음. backend fault recovery는 M16, retention은 M11, fake drain limit은 M15에서 처리한다.
- Next exact action: 계획 bootstrap 및 M01–M09 로컬 후보를 review/PR 절차로 공개 main에 반영한다. M11/M16/M22는 로컬 선행만 충족되어 `READY`로 바꿨으며 shared 완료를 재확인해야 한다. release 직접 선행 `M12 → M17` 및 `M13`은 여전히 미완료다. 이번 M06–M09를 재실행하지 않는다.


### 2026-09-05 — 전체 유지보수 실행 인계

- 요청: 이 문서의 남은 실행 명세 전체 구현·검증 후 문서 업데이트. P4는 명세의 BACKLOG 정책을 유지했다.
- Start ref: clean `main@7cb3398` (M01–M09 포함). `origin/main@405e799367023bb5e868588c85e4ff1fca51d4c0`, Jobs release `v0.3.1@7a173442caea6d7d50b09c9fe01a643cd1afb288` 재확인.
- End ref: 동일 branch/HEAD 기준 로컬 미커밋 후보. stage/commit/push/PR/merge/tag/publish 및 관리자 설정 변경은 수행하지 않았다. 기존 handler 계획은 변경하지 않았다.
- 상태 의미: 아래 DONE은 로컬 구현·문서·요구된 실행 가능한 검증 증거다. 원래 §0.2의 공개 완료 조건을 충족했다는 뜻이 아니다. 외부 settings/리뷰/publish가 필요한 행은 EXTERNAL/BLOCKED를 유지했다.

#### 작업별 결과와 결정

| Task | 로컬 결과 | 남은 조건 |
| --- | --- | --- |
| M10 | producer/worker/both, default both, producer 무소비, worker enqueue 거부, bootstrap handler fail-fast, dynamicRegistration opt-in. 별도 producer process + worker app Redis proof. | 공개 review/merge |
| M11 | 두 backend의 opt-in terminal retention, recovery horizon 검증, operator quiescence, batch cleanup. terminal/history/payload/identity 삭제와 live replay mapping 보존. | cleanup cadence·PII 분류·legacy shared reservation은 운영자 책임 |
| M12 | verify read-only, npm job만 OIDC, GitHub Release job만 contents write, 공식 Actions SHA pin, ancestry/tag/manifest policy. | **EXTERNAL**: main 보호 없음, rulesets [], npm environment protection 없음. 기존 관리자의 보호 설정·npm trusted publisher 확인 필요; 새 담당자 지정은 불필요 |
| M13 | BullMQ peer ^5.76.2, dev/lock exact 5.76.2, exact latest-v5 5.81.4 Redis matrix; optional peer 미설치 core proof. | 소비자는 자체 peer lock 갱신 필요 |
| M14 | history entry/Date/error deep snapshot. | 없음 |
| M15 | drain limit typed jobs_drain_limit_exceeded, 1001 ready/infinite replenishment/future idle/cancelled head 구분. | 없음 |
| M16 | caller activation token으로 move 재확인, settled handler 결과 보존, uncertain ack→fail 금지, fenced conflict getJob reconciliation, 50ms retry 및 onWorkerError. Shutdown도 pending reconciliation을 기다림. | old custom backend가 caller token 복구를 지원하지 않으면 unknown ownership은 자동 실행하지 않고 보고 |
| M17 | pack-once consumer graph, same-version different-bytes hard fail, allowlist/size/manifest/CHANGELOG, provenance subject/ref/source SHA 검증과 npm signatures gate. | 실제 새 버전 publish/attestation은 REL gate |
| M18 | 0.4 후보 Node 22/24, Nest 10/11 유지. exact Nest 12.0.1 strict 설치 ERESOLVE를 기록하고 지원을 넓히지 않음. | Nest 12의 runtime/module/Redis proof는 설치 차단으로 미실행; 향후 별도 후보 |
| M19A | compatible lock refresh로 high 3→0. production audit 0. | Nest 10 compatibility fixture moderate 4 예외: owner @ksyq12, expiry 2026-10-05 |
| M19B | Jest 30.5.1, @types/jest 30.0.0, ts-jest 29.4.12 exact. | 없음 |
| M19C | ESLint 10.10.0 / @eslint/js 10.0.1 / typescript-eslint 8.69.0 flat config. | 없음 |
| M20 | v0.1/v0.2 plan historical banners, README fixed-release 예시 정리. | handler 역사 문서는 보존 |
| M21 | 별도 exact spec/version/SRI manifest gate와 JOBS_TARBALL 입력; 0.2.1 anchor 유지, 게시 0.3.0 strict proof 및 ^0.2.1 || ^0.3.0 peer. | 없음 |
| M22 | Outbox/Jobs 상태표, getJobForTenant filter, caller RBAC 예제, legacy bridge deprecated, Nest late-shutdown publisher regression. | **EXTERNAL**: 게시 Outbox 0.3.0 poller가 onApplicationShutdown에서만 정지하고 timeout 뒤에도 callback이 남을 수 있음. stop/drain 보장 및 retry budget 비소진의 두 패키지 proof 필요 |
| M23 | Redis 없는 coverage 즉시 실패, critical branch threshold 인상, exact tuple/ref/dirty summary. | 실제 GitHub artifact 업로드는 공개 CI 이후 |
| M24 | SECURITY/CODEOWNERS/Dependabot 및 Redis TLS/ACL·producer/admin·PII/retention 정책. | **EXTERNAL**: private vulnerability reporting API enabled=false; inbox 동작과 설정 적용 확인 필요 |
| M25 | 실제 producer SIGKILL before reserve/after reserve/after add, 60초 real lease expiry, stalled worker, disposable Redis disconnect/restart. | SAVE 후 graceful Redis restart이며 전원 손실 durability나 shared Redis 장애 proof가 아님 |
| M26 | 6 seeded × 500-step reference traces, attempt/terminal monotonicity, composite identity conflicts, retention soak, fairness/performance baseline. | 고정 머신 latency regression budget은 향후 운영 baseline 축적 필요 |
| M27 | deep-import inventory 및 ADR. restrictive exports는 별도 migration까지 보류; CJS/root/types/package.json/기존 deep import packed proof 보존. | 외부 deep-import 사용처 inventory는 향후 exports 승격 조건 |
| M28 | BullMQ codec/identity-lock/lifecycle/resources 내부 분리; root export/runtime behavior 보존. | 없음 |

#### 재현된 RED와 수정 중 발견한 계약

- M10/M14/M15 최초 behavioral RED: 신규 maintenance-remaining 테스트 **5 FAIL** (producer가 Worker 시작, missing handler bootstrap 성공, history mutation, drain 한도 silent success, cancelled head 뒤 ready job 남음). fixture 작성 중의 타입 오류와 구분해 `/private/tmp/jobs-remaining-red.log`에 보존.
- M16 최초 behavioral RED: operation recovery **3 FAIL**. move/fail 오류 뒤 active/pending 상태가 복구되지 않고 ack 오류는 fail로 흘러 성공 resolve했다. `/private/tmp/jobs-recovery-red.log`.
- M12 policy RED: release top-level contents/id-token write 상속이 read-only assertion을 위반. `/private/tmp/jobs-release-policy-red.log`.
- Jest 30 exact 설치 뒤 첫 전체 unit은 통과했다. 존재하지 않는 RED를 만들지 않았다. ESLint 9 첫 lint는 flat config 부재로 실패했으며 변환 후 통과; 재설치 경고로 최종 지원 버전을 다시 선택했다.
- Outbox 0.3.0 첫 strict install은 이전 ^0.2.0 peer로 ERESOLVE. 범위 후보 확장 뒤 strict compile은 required nextAttemptAt 누락으로 실패. 공유 fixture를 보정한 뒤 0.2.1/0.3.0 두 gate를 통과했다.
- BullMQ 5.81.4 첫 build는 새 IRedisClient 타입의 scan/eval 선언 차이로 실패했다. ioredis 구조적 경계를 명시하고 default compatibility proxy에서 실제 Redis 회귀를 통과했다.
- 최초 Redis restart chaos에서 테스트 client 재연결과 finally quit 오류가 원인을 가렸고, 새 client로 재연결·cleanup을 고쳐 전체 rerun했다. 프로덕션 Redis 복구 실패로 잘못 기록하지 않는다.
- 최종 검토에서 ack commit-then-throw 뒤 logical pending가 비어 shutdown이 reconciliation 전에 종료할 수 있음을 발견했다. pendingRecoveryJobIds를 shutdown 소유권에 포함하고 단일 handler/성공 event/반대 fail 없음 회귀를 추가했다.

#### 최종 검증 증거

최종 실행 결과와 artifact digest를 아래 표 및 [maintenance-evidence-2026-09-05.json](./maintenance-evidence-2026-09-05.json)에 기록했다. 로그는 `/private/tmp/jobs-maintenance-*`에 있으며 JSON에는 파일별 SHA-256을 보존했다.

| 검증 | 결과 |
| --- | --- |
| 설치/lint/typecheck/build | offline `npm ci` **PASS** (437 packages), lint/typecheck/build **PASS**, 변경·신규 TS Prettier 및 `git diff --check` PASS. ESLint **10.10.0**, @eslint/js **10.0.1**, typescript-eslint **8.69.0**, Jest **30.5.1**, ts-jest **29.4.12**, TS **5.9.3**, js-yaml **4.3.1**. |
| Node 24 / Nest 10 unit | Node **24.11.1**, Nest **10.4.22**, BullMQ **5.76.2**: **30 suites / 254 tests PASS**. `complete-unit.log`. |
| Node 22 / Nest 10 unit/Redis | Node **22.23.2**: 최종 unit **30 suites / 254 tests PASS**, floor Redis **2 suites / 48 tests PASS**. `complete-node22-unit.log`, `node22-redis.log`. |
| Nest 11 / Node 22·24 / floor Redis | Nest **11.2.1**, BullMQ **5.76.2**, Node **22.23.2 / 24.11.1**: 각 **2 suites / 48 tests PASS**. `nest11-node22-redis.log`, `nest11-floor-redis.log`. |
| latest compatible BullMQ 5.81.4 | Nest **11.2.1**, Node **24.11.1**, BullMQ **5.81.4**: build 및 Redis **48 tests PASS**, 최종 unit **254 tests PASS**. `latest-v5-redis.log`, `nest11-final-unit.log`. Nest **12.0.1** 별도 spike는 strict ERESOLVE로 지원 확장 보류. |
| Redis-backed coverage | 최종 source tuple Node **24.11.1** / Nest **10.4.22** / BullMQ **5.76.2**: **32 suites / 302 tests PASS**. 전체 statements/branches/functions/lines **92.51 / 87.50 / 97.82 / 94.54%**, 모든 global/BullMQ/internal threshold PASS. `complete-coverage.log` 및 `coverage/evidence.json`. |
| packed core / Outbox 0.2.1 / Outbox 0.3.0 | 아래 **동일 final tgz**로 core Node24/Nest10.4.22, Node22/Nest11.2.1 및 Outbox **0.2.1 / 0.3.0** 각각 strict install/peer graph/tsc/runtime **PASS**. core optional BullMQ·Outbox 미설치, root/types/package.json/deep import 유지. `complete-core10.log`, `complete-core11-node22.log`, `complete-outbox021.log`, `complete-outbox030.log`. |
| policy / real chaos / benchmark | policy **6 tests PASS**. 기존 게시 0.3.1과 후보의 bytes 불일치 **의도한 차단 확인**. actual repo policy는 unprotected main으로 **의도한 차단 확인**. real lease 60초·producer SIGKILL 3지점·stalled worker·전용 Redis restart **PASS**. fairness 편차 **0%**, enqueue overhead **23.7µs**, e2e **37.3µs**, 처리량 **30,605 / 30,549 jobs/s** (머신별 baseline). |
| production/full audit | 최종 production **0**, full **4 moderate / 0 high / 0 critical**. Nest10 개발 fixture 예외는 @ksyq12, 만료 **2026-10-05**. `complete-audit-prod.json`, `complete-audit-full.json`. |

- 최종 artifact: `/private/tmp/jobs-maintenance-complete/nestarc-jobs-0.3.1.tgz` (**89,725 bytes**). SHA-256 **`cdc5ba0641859957b29d1d156bf4d921e25a3ce6fdfd2ad3c8cceadb8c39801f`**, SRI **`sha512-gotnYauHFwt85sBdhBULgn9eBHALf9wzwAsl3SBDpgouDAlay2s05jYedd2RdbxZXZJV66RepsOOt+MvCPQJlQ==`**. 허용 경로/일반 파일/크기/manifest/CHANGELOG 검증 PASS. 새 `SECURITY.md`도 포함했다. version 필드는 0.3.1이지만 게시 artifact와 다른 로컬 후보이며 직접 publish하면 안 된다.
- CI coverage도 별도 producer child가 사용하는 dist를 먼저 build하도록 보정했고 정책 회귀로 순서를 검증했다. 최종 패키지 뒤 변경은 비배포 workflow/tests/인계 문서뿐이다.
- Redis: 이 작업의 전용 `jobs-maintenance-20260905` project와 UUID namespace만 사용했으며 최종 검증 후 해당 container/network를 `docker compose down`으로 제거했다. 다른 Redis/PID를 변경하지 않았다.
- 기존 handler 계획은 HEAD 대비 변경 없음, index 비어 있음. stage/commit/push/PR/merge/tag/publish 및 관리자 설정 변경 없음.
- 담당자 지정은 필요 없다. 기존 관리 계정으로 확인 가능한 작업이며, 이번 구현에서 추가했던 별도 독립 리뷰어 필수 조건은 문서·release policy에서 제거했다.

#### 남은 외부 게이트와 다음 행동

1. [release-settings-required.md](./release-settings-required.md)의 before-state/정책을 기존 저장소·npm 관리 권한으로 확인한다. 별도 담당자나 추가 독립 리뷰어 지정은 요구하지 않는다. 비공개 신고 채널을 활성화하고 동작 증거를 확보한다. 이 항목들은 코드 작성이나 local tests로 DONE 처리하지 않는다.
2. 계획 bootstrap과 로컬 후보를 protected main의 review/merge 흐름으로 반영한다. current local lineage는 공개 main과 다르므로 조사 branch를 그대로 release tag 대상으로 삼지 않는다.
3. Jobs의 next version은 **0.4.0 minor** 결정이다. package/lock version은 아직 0.3.1이며 registry의 게시 bytes와 다르다. M12 외부 조건과 모든 merge가 끝난 release commit에서만 bump/CHANGELOG/tag 및 최종 pack-once publish를 수행한다. 이번 로컬 tgz를 직접 publish하지 않는다.
4. M22의 upstream Outbox stop/drain 및 shutdown retry budget 계약을 확정한다. 그 뒤 Jobs 새 버전 게시와 함께 TEN-ECO-NEXT의 PostgreSQL + Redis fully-published 검증을 수행한다. 현재 Outbox latest 0.3.0의 존재만으로 이 cross-package 작업을 완료 처리하지 않는다.
5. P4 B01–B08은 연구 backlog로 유지한다. BullMQ 6/Node 26 LTS/dual ESM/new backend/exactly-once fan-out을 이번 source 후보에 섞지 않는다.


### 2026-09-05 — 0.4.0 공개 릴리스 완료 인계

- JOBS-PLAN-01/M12/M17/JOBS-REL-01 DONE. PR #2 → release source `563612539401f49fa6b1ab0c9c265f79e8f61741`, annotated v0.4.0, npm latest 0.4.0.
- Main/tag/npm 보호 정책 실제 적용 및 read-only effective-rule 검증 PASS. 원본 publish run 33946102143에서 OIDC publish 성공; signature fixture ERESOLVE를 PR #8에서 수정한 뒤 recovery run 33946723677이 원본 artifact의 registry bytes/provenance/signatures를 검증하고 GitHub Release 생성을 완료했다. 원본 run 전체가 green이라는 뜻은 아니다.
- Source/Redis/coverage/Node 22·24/Nest 10·11/BullMQ floor·latest/Outbox 0.2.1·0.3.0/실제 chaos 및 benchmark 증거를 갱신했다. 정책/복구 회귀 총 13건 PASS.
- M24 private reporting enabled=true와 관리자 inbox 접근을 확인했으나 실제 보고서 0건이어서 수신 acceptance는 EXTERNAL. M22 upstream stop/drain 및 TEN-ECO-NEXT 두 패키지 PostgreSQL+Redis 검증도 EXTERNAL. P4는 BACKLOG 유지.
- 상세 결과와 다음 행동은 [릴리스 검토 문서](./2026-09-05-maintenance-release-review.md) 및 [release evidence JSON](./maintenance-release-evidence-2026-09-05.json)에 기록했다. 과거 로컬 0.3.1 tgz를 게시하거나 기존 v0.3.1/v0.4.0 태그를 이동하지 않는다.
