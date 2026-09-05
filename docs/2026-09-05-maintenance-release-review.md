# P0–P4 유지보수 구현 및 릴리스 준비 검토

- 검토일: 2026-09-05 (Asia/Seoul)
- 대상 계획: [2026-09-02-p0-p4-maintenance-work-plan.md](./2026-09-02-p0-p4-maintenance-work-plan.md)
- 검토 HEAD: `92932075a61e0433742c0ce370b7a0f37d1294a6`
- fetch 후 origin/main: `405e799367023bb5e868588c85e4ff1fca51d4c0`
- 최종 판정: **R1–R4 및 Jobs 0.4.0 공개 릴리스 완료. M22/TEN-ECO-NEXT와 M24 실제 신고 수신은 외부 후속이며 P4는 BACKLOG 유지.**
- 최종 실행일: 2026-09-05 (Asia/Seoul). §1–4는 최초 검토 기록이고, 최신 완료 상태는 §6을 따른다.

## 1. 완료 범위

M19A/B/C를 각각 세면 M 작업은 30개다. 실행 표의 27개 DONE은 로컬 code/docs/test 기준이며, M12/M22/M24는 EXTERNAL이다. 공개 반영·설정·배포까지 요구하는 계획 §0.2의 DONE으로 확대 해석하면 안 된다.

| 범위 | 검토 결과 |
| --- | --- |
| M01–M05 | admission/drain, activation fencing, timeout ownership, tenant dedupe, source lineage 구현과 관련 회귀 확인. 현재 unit/Redis 포함 검증 PASS. |
| M06–M11 | 실행 pool/cap, validation, system shard, JSON serialization, BullMQ 역할, retention 구현과 회귀 확인. |
| M13–M21, M23, M25–M28 | dependency/toolchain, history/drain/recovery, packaging, coverage, chaos/model 및 내부 분리 코드·문서·기존 실행 증거 확인. M17의 실제 publish 검증은 REL 대기. |
| M12 | workflow 권한 분리는 구현돼 있으나 외부 보호 설정 미적용. 아래 로컬 정책 검사 보완도 필요. |
| M22 | Jobs 측 상태·tenant helper·late shutdown rejection 회귀는 있음. upstream Outbox stop/drain과 shutdown retry budget 보호를 포함한 두 패키지 검증은 미완료. |
| M24 | SECURITY/CODEOWNERS/Dependabot 파일은 있음. GitHub private vulnerability reporting은 실제 API에서도 `enabled=false`. 채널 활성화·수신 확인 미완료. |
| JOBS-PLAN-01 / JOBS-REL-01 | 공개 review/merge 미완료 / release BLOCKED 유지. |
| TEN-ECO-NEXT | 두 패키지 게시 이후 PostgreSQL + Redis fully-published 검증 미완료. 계획상 Jobs 단독 publish의 선행 조건은 아님. |
| P4 B01–B08 | 의도된 연구 BACKLOG. 이번 릴리스 acceptance에서 제외. |

## 2. 릴리스 전 해결할 사항

### R1 — 원격 main 계보 정리

현재 로컬 main은 `ahead 7, behind 1`이다. `origin/main`은 로컬 HEAD의 조상이 아니므로 현재 main을 그대로 일반 push하면 non-fast-forward가 된다. 원격의 `405e799`는 로컬 `83e562d → f10234b → d3d757e`의 squash 결과이며 두 기준 tree는 같다. 실제 유지보수 변경은 그 뒤의 네 커밋 `1f4c486 → f222389 → 7cb3398 → 9293207`이다.

원격 main 기준 통합 branch에 이 변경을 반영하고 CI/review/merge를 거쳐야 한다. 원격 main을 force-push하거나 기존 TEN-M21 변경을 중복 적용하지 않는다. 현재 공개 main의 green CI `33294387914`는 이전 소스의 결과이므로 유지보수 후보의 공개 CI 증거가 아니다.

### R2 — 새 버전 및 release CHANGELOG 준비

`package.json`과 lockfile은 아직 `0.3.1`이고 새 변경은 CHANGELOG의 `Unreleased`에 있다. 계획의 다음 버전 결정은 **0.4.0 minor**다. 현재 tarball의 SRI는 npm에 게시된 0.3.1과 다르다. 기존 0.3.1을 재게시하거나 v0.3.1 태그를 옮기는 방식으로 진행할 수 없다.

최종 통합 후보에서 package/lock을 0.4.0으로 맞추고 `## [0.4.0]` CHANGELOG를 확정해야 한다. 지금의 0.3.1 검토용 tarball은 향후 0.4.0 배포 artifact를 대신하지 않는다.

### R3 — M12 외부 게이트가 실제로 차단됨

GitHub API를 읽기 전용으로 다시 조회한 결과:

- main: `protected=false`.
- repository rulesets: `[]`.
- environment `npm` (ID `16978551472`): `protection_rules=[]`, `deployment_branch_policy=null`, `can_admins_bypass=true`.
- `GITHUB_REPOSITORY=nestarc/jobs node scripts/verify-repository-policy.js`: exit 1, `main must be protected before release`.
- npm trusted-publisher의 repository/workflow/environment 바인딩은 이번 검토에서 확인하지 못함.

[release-settings-required.md](./release-settings-required.md)의 구체적인 main/tag/environment 정책을 적용하고 실제 응답을 기록해야 한다. 새 workflow의 green run에서 필수 check 이름을 확보해야 한다. 별도 담당자 지정이나 추가 독립 리뷰어를 새로 요구하는 검토는 아니다.

### R4 — M12 로컬 정책 검사의 보호 조건 누락

위치: `scripts/verify-repository-policy.js:5`, `:19`.

현재 코드는 main의 `protected === true`만 확인한다. 필수 PR, 필수 상태 검사, force-push/deletion 금지의 실제 설정은 조회·판정하지 않는다. 따라서 관리자가 불완전한 branch protection을 적용해도 태그/environment 조건만 맞으면 release gate가 통과할 수 있다. 이 조건은 release settings 문서의 main 정책보다 약하다.

검토 중 다음 main fixture와 유효한 tag/environment fixture를 `verifyRepositoryPolicy()`에 넣었을 때 예외 없이 통과했다:

```js
{
  protected: true,
  protection: {
    required_pull_request_reviews: null,
    required_status_checks: null,
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: true }
  }
}
```

main의 실제 effective rules/branch protection을 읽어 필요한 PR/check/force-push/deletion 조건을 검증하고, 부분 보호를 거부하는 회귀를 추가해야 한다. 이번 요청은 구현 완료 검토이므로 production 코드와 workflow는 수정하지 않았다.

추가 실행 주의: Outbox 0.3.0 후보 lane은 일반 push 및 현재 release 입력에서 skip된다. 별도 exact manifest 입력으로 실행 가능한 구조이지만, 릴리스 시 최종 artifact의 0.3.0 소비자 증거도 확보해야 한다. 이번 로컬 검토에서는 0.2.1과 0.3.0을 모두 같은 artifact로 실행했다.

## 3. 이번 검토의 재검증 결과

환경: Node `24.11.1`, npm `11.6.2`, source Nest `10.4.22`, BullMQ `5.76.2`.

| 검증 | 결과 |
| --- | --- |
| `npm test -- --runInBand` | 30 suites / 254 tests PASS |
| lint / `tsc --noEmit` / build | 모두 PASS |
| `npm run test:policy` | 6 tests PASS. 위 R4의 누락 조건은 기존 테스트에 포함되지 않음. |
| Redis-backed coverage | 32 suites / 302 tests PASS; statements 92.51%, branches 87.50%, functions 97.82%, lines 94.54%. 모든 threshold PASS. |
| `npm audit --omit=dev` | 0 vulnerabilities |
| 전체 `npm audit` | 4 moderate, 0 high/critical. 기존 Nest 10 개발 fixture 예외와 동일하며 만료일은 2026-10-05. |
| 새 pack / allowlist / manifest | PASS. 기존 maintenance artifact와 SHA-256/SRI/크기 일치. |
| packed core | Node 24 / Nest 10.4.22 strict peer install, compile, runtime, optional peer 비설치 PASS |
| packed Outbox 0.2.1 / 0.3.0 | 각 Nest 11.2.1 / Prisma 7.10.0 strict install/compile/runtime PASS. 동일 Jobs tgz 사용. |
| 기존 evidence 로그 검증 | JSON에 기록된 19개 로그 파일이 모두 존재하고 SHA-256이 모두 일치. |
| `git diff --check` | PASS |

이번 검토에서는 Node 22 전체 matrix, latest BullMQ 5.81.4 Redis, 실제 SIGKILL/60초 lease/Redis restart chaos 및 benchmark를 재실행하지 않았다. 해당 항목은 기존 로그의 무결성을 확인했으며 새 실행으로 주장하지 않는다. GitHub의 최종 통합 commit CI, 실제 새 버전 publish/provenance, upstream Outbox shutdown, PostgreSQL fully-published 검증도 아직 없다.

검토 artifact:

- 경로: `/private/tmp/jobs-release-review-artifact/nestarc-jobs-0.3.1.tgz`
- 크기: 89,725 bytes
- SHA-256: `cdc5ba0641859957b29d1d156bf4d921e25a3ce6fdfd2ad3c8cceadb8c39801f`
- SRI: `sha512-gotnYauHFwt85sBdhBULgn9eBHALf9wzwAsl3SBDpgouDAlay2s05jYedd2RdbxZXZJV66RepsOOt+MvCPQJlQ==`
- npm 게시 0.3.1 SRI: `sha512-KgEA3/zWU4cyW3t+UXCAlHfPh/YZTfNl93i7E7oYCB2yHRYbR6RquBPa2tGDZX3oXPO5uV5sc3ogHZwYSi1Eyg==`

새 로그는 `/private/tmp/jobs-release-review-{coverage,core,outbox021,outbox030,repo-policy}.log` 및 `jobs-release-review-audit-{prod,full}.json`에 있다. 전용 Redis project `jobs-release-review-20260905`는 검증 후 컨테이너와 네트워크를 제거했다. 기존 handler 계획과 구현 파일은 변경하지 않았다.

## 4. 진행 순서

1. R4 정책 검사를 보완하고 R1의 통합 branch/PR에서 새 CI 결과를 확보한다.
2. R3 main/tag/npm 보호 설정과 trusted publisher를 검증하고 공개 main에 통합한다. M24 private reporting도 활성화·수신 확인한다.
3. 0.4.0 manifest/lock/CHANGELOG를 확정한 release 후보로 요구 검증을 실행한다.
4. 최종 commit이 protected main에 포함된 상태에서 matching v0.4.0 태그를 생성한다. 태그 push가 npm publish와 GitHub Release workflow를 시작한다.
5. 최종 workflow가 검증한 단일 tarball의 registry integrity/provenance와 GitHub Release를 확인한 후 REL을 DONE 처리한다. M22/TEN-ECO-NEXT는 별도 외부 완료 증거가 생길 때까지 유지한다.

이번 검토에서는 push, PR 생성, merge, tag, npm publish, GitHub Release 생성 및 관리자 설정 변경을 실행하지 않았다.

## 5. 후속 실행 — 2026-09-05

사용자가 이 검토 문서의 모든 작업 진행을 요청했다. §1–4는 최초 검토 시점의 역사 기록이며, 후속 상태는 이 절을 따른다.

- R1: `origin/main@405e799` 기준 `/private/tmp/jobs-maintenance-040`, branch `codex/jobs-maintenance-040`에서 실제 유지보수 네 커밋만 cherry-pick했다. TEN-M21 squash 중복 및 main force-push 없음. [PR #2](https://github.com/nestarc/jobs/pull/2)에서 통합 중이다.
- R2: package/lock version `0.4.0`, CHANGELOG `## [0.4.0] - 2026-09-05` 준비 완료.
- R4: effective main PR/strict CI/force-push/deletion 규칙을 검증하고 partial/missing/unrelated/disabled/bypass 보호를 거부한다. 원래 재현 입력은 실패하며 완전한 0-review PR 보호는 통과한다. read-only REST에서 누락되는 bypass 정보는 GraphQL로 조회하고, API 오류/불완전 응답은 차단한다. 정책 회귀 11건 PASS.
- Outbox 0.3.0 exact version/SRI 입력을 일반 CI·release에 고정하여 0.2.1 anchor와 함께 같은 Jobs artifact를 검사한다.
- 첫 공개 CI `33945680595`에서 optional peer `@emnapi/core`·`@emnapi/runtime` lock 항목 누락이 발견됐다. npm 11.19.0으로 두 항목을 복구하고 npm 10.9.8 clean install을 통과했다.
- 공개 CI [33945801951](https://github.com/nestarc/jobs/actions/runs/33945801951)는 전체 PASS. Node 22/24, Nest 10/11, floor/latest-v5 Redis, coverage 및 두 Outbox consumer를 포함한다.
- R3: main ruleset `22320000`, immutable tag ruleset `22319849`, admin tag creation ruleset `22319937`, npm environment ID `16978551472`를 적용했다. 실제 관리자 API policy PASS. 상세 설정과 필수 check 출처는 [release-settings-required.md](./release-settings-required.md)에 있다.
- M24: private vulnerability reporting 활성화 및 API `enabled=true` 확인. 실제 수신은 미검증이다. 자동 승인 검토가 private advisory 목록 조회를 민감한 취약점 정보 접근 위험으로 거부했으므로 신고함 내용을 조회하지 않았다.
- 로컬 재검증: unit 30 suites/254 tests, Redis coverage 32 suites/302 tests, lint/typecheck/build PASS. Production audit 0, full audit 4 moderate/0 high/critical로 기존 예외와 동일하다.
- npm 로그인 대신 GitHub OIDC Release workflow로 실제 배포 및 provenance를 검증한다는 사용자 지시를 반영했다.

릴리스 완료 증거와 최종 상태는 실행 후 아래에 추가한다. M22/TEN-ECO-NEXT 및 P4 BACKLOG는 이 Jobs 릴리스와 별도다.

### npm 게시 및 후속 GitHub Release 복구

- [PR #2](https://github.com/nestarc/jobs/pull/2)는 `563612539401f49fa6b1ab0c9c265f79e8f61741`에 squash merge됐다. Protected main CI [33946073721](https://github.com/nestarc/jobs/actions/runs/33946073721) 전체 PASS. `v0.4.0` annotated tag는 이 commit을 가리키며 기존 태그 이동/삭제는 없다.
- 원본 [Release run 33946102143](https://github.com/nestarc/jobs/actions/runs/33946102143)의 전체 verify, 실제 repository/artifact policy 및 npm OIDC publish가 PASS했다. npm `@nestarc/jobs@0.4.0` 게시와 원본 artifact의 SRI/attestation subject/ref/source SHA 일치를 독립적으로 재확인했다.
- 단, 최종 `release` job의 서명 검사용 `npm install @nestarc/jobs@0.4.0`이 floating optional-peer 해석 과정에서 Nest 12를 선택해 ERESOLVE로 실패했다. 서명 불일치나 package runtime 실패가 아니다. 이미 게시된 0.4.0과 태그를 변경하지 않는다.
- 검증용 install에 exact Nest 11.2.1/common/core, reflect-metadata 0.2.2, rxjs 7.8.2와 strict peer 옵션을 적용한 후 **22 registry signatures / 1 attestation 검증 PASS**를 확인했다. 다음 릴리스의 동일 오류를 수정하고, 기존 성공 publish run의 정확한 artifact만 검증하는 `release-recovery.yml`을 추가했다. 복구 workflow에는 npm publish/OIDC 권한이 없고 검증 성공 뒤 GitHub Release만 생성한다.
- 원본 artifact: `/private/tmp/jobs-040-release-artifact/nestarc-jobs-0.4.0.tgz`, **89,723 bytes**, SHA-256 `326a84b7dc47e778bbb75104dbe443f0857ffc3bba71f8b04be34d26a2f80aa1`, SRI `sha512-3OzypjcJmx5f1ImRyXZACU3F0z+PpXPCEwhU8CtIB7b03nqX2T0WCNOcLJFpWG2JK4UvIgfWs8jQjaedFktw9w==`.
- 같은 실제 Release artifact의 로컬 Outbox 0.2.1/0.3.0 strict 소비자도 PASS. 실제 60초 lease/producer SIGKILL 3개 지점/stalled worker와 전용 Redis restart 재실행 PASS. Redis 프로젝트 `jobs-040-20260905`, `jobs-maintenance-040-restart`는 모두 제거했다.
- M24: 사용자가 식별자·상태 조회를 명시적으로 승인한 뒤 관리자 신고함 API가 성공했고 결과는 `[]`였다. 본문/제보자 정보는 출력하거나 저장하지 않았다. 활성화와 수신함 접근은 확인됐지만 실제 신고 전달 증거는 없어 M24의 수신 acceptance는 EXTERNAL로 남는다.
- 저장소 SECURITY.md의 지원 버전·신고 경로를 실제 0.4 게시/활성화 상태로 갱신했다. 이미 게시된 0.4.0 tarball의 SECURITY.md에는 게시 전 0.3/source-candidate 문구가 남아 있으므로 최신 보안 정책은 저장소 SECURITY.md를 따른다. 이 문서 정정 때문에 immutable 태그/registry bytes를 변경하지 않는다.

복구 workflow의 최종 실행 결과는 후속 완료 기록에서 확인한다.


## 6. 최종 완료 기록 — 2026-09-05

### 완료 범위

| 항목 | 최종 결과 |
| --- | --- |
| R1 / JOBS-PLAN-01 | DONE. [PR #2](https://github.com/nestarc/jobs/pull/2)를 보호된 main에 squash merge. Release source `563612539401f49fa6b1ab0c9c265f79e8f61741`. 원격 main의 TEN-M21 squash 계보를 보존했고 force-push 없음. |
| R2 | DONE. package/lock/CHANGELOG 0.4.0 확정, 새 annotated `v0.4.0` 태그. 기존 0.3.1 재게시 또는 태그 이동 없음. |
| R3 / M12 | DONE. main PR·20개 exact Actions check·force-push/삭제 금지, v* 불변성, 관리자 tag 생성, npm 환경 v* 제한 및 admin bypass 금지 적용. 최종 실제 API 검사 PASS. OIDC publish 성공으로 `nestarc/jobs` / `release.yml` / `npm` trusted publisher 동작을 증명했다. |
| R4 | fixed. main `protected=true`만인 입력과 원래 불완전 protection 재현 입력을 거부. 모든 필수 effective rule 및 check, 비활성·무관·bypass 규칙과 API 증거 누락을 검사한다. 정상 0-review PR 보호는 허용. 정책/복구 테스트 총 13건 PASS. |
| M17 / JOBS-REL-01 | DONE. npm latest **0.4.0**, 동일 원본 tarball의 registry SRI/provenance/source lineage 검증 및 **22 registry signatures / 1 attestation PASS**. [GitHub Release v0.4.0](https://github.com/nestarc/jobs/releases/tag/v0.4.0)는 2026-09-05 14:15:55 KST 공개, draft/prerelease 모두 false. |
| Release 후속 실패 | 원본 run은 npm 게시 뒤 서명 fixture의 floating Nest 12 ERESOLVE로 최종 failure. [PR #8](https://github.com/nestarc/jobs/pull/8), main `555b1cca2fe4d0c906913df6221fb35ce5a987c0`에서 exact peer 고정·원본 artifact 전용 recovery 추가. [최종 복구 run 33946723677](https://github.com/nestarc/jobs/actions/runs/33946723677)의 verify-published/release 모두 PASS. 재게시·태그 이동·검증 생략 없음. |
| M24 | 활성화 및 관리자 수신함 접근 확인. `enabled=true`, 사용자 승인 후 식별자/상태 결과 `[]`. 실제 신고가 없어 전달·수신 acceptance는 EXTERNAL. |
| M22 / TEN-ECO-NEXT | EXTERNAL 유지. upstream Outbox stop/drain·shutdown retry budget 보호와 PostgreSQL+Redis fully-published crash/restart 계약의 두 패키지 증거는 이번 Jobs 릴리스에서 새로 만들지 않았다. |
| P4 B01–B08 | 명세대로 BACKLOG, 이번 릴리스 acceptance 제외. |

### 최종 검증 및 artifact 증거

- Release source의 protected-main CI [33946073721](https://github.com/nestarc/jobs/actions/runs/33946073721), 원본 Release의 전체 Verify, 복구 PR의 필수 CI 및 최종 복구 workflow PASS. 원본 Release 전체 run을 green으로 표기하지 않는다.
- 로컬 unit **30 suites / 254 tests**, Redis coverage **32 suites / 302 tests** PASS. coverage statements/branches/functions/lines **92.51 / 87.50 / 97.82 / 94.54%**, 모든 threshold PASS. lint/typecheck/build PASS.
- 실제 Release가 생성한 동일 tarball로 Node 22/24 × Nest 10.4.22/11.2.1 core, Outbox 0.2.1/0.3.0 소비자 PASS. Outbox 두 버전은 로컬에서도 해당 원본 artifact로 strict install/compile/runtime PASS.
- actual producer SIGKILL before-reserve/after-reserve/after-add, 각 real 60초 lease 만료, stalled worker 및 SAVE 후 전용 Redis disconnect/restart PASS. 전원 손실 durability 증거로 확대하지 않는다.
- benchmark: enqueue overhead **14.8µs**, e2e **32.2µs**, single-tenant **32,299 jobs/s**, 100-tenant **30,685 jobs/s**. 고정 머신 회귀 budget이 아닌 이번 실행 baseline이다.
- Production audit **0**, full audit **4 moderate / 0 high / 0 critical**. 기존 Nest 10 개발 fixture 예외(@ksyq12, 만료 2026-10-05)를 유지한다.
- 단일 배포 artifact는 §5의 **89,723 bytes**, SHA-256 `326a84b7dc47e778bbb75104dbe443f0857ffc3bba71f8b04be34d26a2f80aa1`, SRI `sha512-3OzypjcJmx5f1ImRyXZACU3F0z+PpXPCEwhU8CtIB7b03nqX2T0WCNOcLJFpWG2JK4UvIgfWs8jQjaedFktw9w==`. 복구 workflow는 이 원본 run artifact를 다운로드했으며 새 pack을 하지 않았다.
- 기계 판독 기록: [maintenance-release-evidence-2026-09-05.json](./maintenance-release-evidence-2026-09-05.json). 로컬 로그 경로/SHA-256 및 public run/PR/Release 링크를 포함한다.

### 인계

R1–R4와 Jobs 릴리스를 재실행하지 않는다. 이후 작업은 M22 upstream lifecycle 보완, TEN-ECO-NEXT fully-published 검증, M24 실제 private-report 수신 증거다. 새로운 실제 취약점 보고 없이 임의의 테스트 취약점 신고를 만들지 않았다. 기존 handler 계획은 시작 HEAD 대비 동일하게 보존했다. 로컬 기존 `main@9293207`도 보존하고 작업 폴더는 공개 main 기반 `codex/jobs-040-completed`로 정리했다.
