# @nestarc/jobs — PRD

## 1. 존재 이유

멀티테넌트 SaaS 백엔드에서 배경 작업은 이미 BullMQ + `@nestjs/bullmq` 조합으로 해결되고 있다. 하지만 **테넌트 격리 관점에서 세 가지 사고가 반복**된다:

- **컨텍스트 유실**: job 핸들러 실행 시 `tenantId` ALS가 비어 있어 Prisma RLS가 fail-closed로 거절하거나, 최악의 경우 다른 테넌트 데이터에 접근
- **Noisy neighbor**: 한 테넌트가 10만 건의 bulk job을 enqueue하면 다른 테넌트의 job이 수 시간 지연. BullMQ의 `concurrency` 한 옵션으로는 fairness 보장 불가
- **Outbox consumer 부재**: `@nestarc/outbox`는 publish만 책임지고, 실제로 이벤트를 읽어 처리하는 worker는 consumer가 직접 짜야 함. 매 프로젝트마다 같은 코드가 반복

### 경쟁/공백

- `@nestjs/bullmq`: 얇은 DI wrapper. 테넌트 인식 기능 없음
- **BullMQ Pro Groups**: 테넌트 fairness 제공. 하지만 **유료 라이선스**
- Inngest: 자체 fair queue를 만들었다(BullMQ 위에 덧댈 수 없어서). SaaS
- Temporal: 워크플로우 플랫폼. tier가 다름, overkill

핵심 공백: **BullMQ Pro의 Groups 기능을 OSS BullMQ 위에서 재현한 NestJS 라이브러리가 존재하지 않는다.**

## 2. 해결 방향

**BullMQ를 교체하지 않는다.** 위에 tenant-aware primitive 세 가지를 얹는다:
1. ALS 기반 테넌트 컨텍스트 자동 propagation
2. Shard-based weighted round-robin scheduler (BullMQ Pro Groups와 동일 동작)
3. Outbox consumer용 bridge adapter

한 줄 포지셔닝: **"BullMQ Pro Groups, open-source. Tenant-fair background jobs for NestJS multi-tenant SaaS."**

## 3. 타깃 사용자

- 이미 `@nestarc/tenancy`를 쓰는 팀
- `@nestarc/outbox`를 쓰는데 worker를 수작업으로 짜고 있는 팀
- BullMQ는 쓰는데 noisy neighbor 문제를 겪어본 팀
- 테넌트별 SLA를 제공해야 하는 B2B SaaS (plan별 작업 우선순위 필요)
- BullMQ Pro 라이선스 비용을 줄이고 싶은 팀

## 4. 성공 기준

- **도입 마찰**: 기존 `@nestjs/bullmq` 프로젝트에서 30분 내 마이그레이션
- **공정성**: 한 테넌트가 1만 건 enqueue해도 다른 테넌트의 p50 지연 2배 이내 유지
- **컨텍스트 안전**: job 실행 중 Prisma 쿼리가 자동으로 테넌트 scope 적용
- **Outbox 연결**: outbox → jobs 와이어링 10줄 이하
- **Starvation 방지**: 가장 낮은 가중치 테넌트도 최소 10% slot 확보

## 5. 범위

### 포함 (v0.1)
- `@JobHandler` 데코레이터 + `JobsModule.forRoot`
- ALS context serialization (enqueue 시 스냅샷 → execute 시 복원)
- **Shard-based weighted round-robin** tenant-fair scheduler
- Per-tenant concurrency cap
- Minimum share guarantee (starvation 방지)
- `JobsOutboxBridge` adapter (outbox → job enqueue)
- Type-safe job payload
- In-memory fake queue (테스트용)

### 제외
- 자체 큐 엔진 — BullMQ 재구현 안 함
- Cron scheduling — BullMQ의 기능 그대로 노출
- 워크플로우 오케스트레이션(saga, step functions) — Temporal 영역
- 관리 UI — Bull Board 연동 문서화만
- Outbox polling 자체 — `@nestarc/outbox` 책임 그대로 유지 (jobs는 bridge만)

## 6. 경쟁/비교

| 항목 | @nestjs/bullmq | BullMQ Pro | Inngest | Temporal | `@nestarc/jobs` |
|---|---|---|---|---|---|
| OSS | ✓ | ✗ (유료) | 부분 | ✓ | ✓ |
| NestJS 네이티브 | ✓ | 수동 | ✗ | SDK | ✓ |
| ALS 자동 전파 | ✗ | ✗ | 부분 | 수동 | ✓ |
| Tenant fairness (Groups) | ✗ | ✓ | ✓ | ✗ | ✓ (핵심) |
| Per-tenant concurrency | ✗ | 부분 | ✓ | ✓ | ✓ |
| Starvation 방지 | ✗ | 제한적 | ✓ | ✗ | ✓ |
| Outbox bridge | ✗ | ✗ | ✗ | ✗ | ✓ |

## 7. 핵심 개념

### 7.1 ALS 컨텍스트 자동 전파

```ts
// 호출측 (API 핸들러)
@Post('/reports')
async schedule() {
  // tenancy ALS에 { tenantId: 't1' }이 이미 있음
  await this.jobs.enqueue('sendReport', { userId: 'u1' });
}

// 핸들러
@JobHandler('sendReport')
async handle(payload: { userId: string }) {
  // ALS 자동 복원 → prisma.user.findUnique()는 t1 scope로 실행
  return this.prisma.user.findUnique({ where: { id: payload.userId } });
}
```

### 7.2 Shard-based Weighted Round Robin

BullMQ의 `worker.concurrency = 10` 하나로는 공정성 보장 불가. 구조:

```
BullMQ queue (혼합 테넌트)
     │
     ▼
Tenant-fair dispatcher  ─── 가상 shard
  ├─ shard: tenant_1 (weight 3)
  ├─ shard: tenant_2 (weight 1)
  └─ shard: tenant_3 (weight 1)
         │
         ▼ round-robin + starvation boost
Worker pool (BullMQ Workers)
```

BullMQ `Worker`를 감싸서 job을 `accept` 단계에서 tenant quota·shard 순서를 평가한다.

### 7.3 Outbox Bridge

**중요**: `@nestarc/jobs`는 outbox polling을 직접 하지 않는다. `@nestarc/outbox`의 polling 콜백을 구현해 match된 이벤트를 job으로 enqueue하는 **얇은 어댑터**만 제공한다.

```ts
JobsModule.forRoot({ ... }),
JobsOutboxBridge.forRoot({
  source: outboxService,
  map: {
    'data_subject.erasure_requested': 'handleErasure',
    'webhook.delivery_due': 'deliverWebhook',
  },
}),
```

## 8. 다른 nestarc 패키지와의 결합

| 패키지 | 역할 |
|---|---|
| `@nestarc/tenancy` | ALS 컨텍스트 제공/복원의 기반. 없으면 컨텍스트 전파 no-op |
| `@nestarc/outbox` | 이벤트 저장·polling(그대로 유지). jobs는 bridge adapter만 제공 |
| `@nestarc/audit-log` | job start/finish/fail 자동 기록(옵션) |
| `@nestarc/data-subject` | 이미 outbox로 publish 중. bridge 한 줄로 consumer 연결 |
| `@nestarc/webhook` | outbound webhook 전송의 worker로 jobs 활용 가능 |

**이 패키지를 출시하면 nestarc 기존 6개 패키지가 비로소 완결된 set이 된다.**

## 9. 잠금된 설계 결정 (리서치 검증 완료)

- **Fairness 알고리즘**: Shard-based **weighted round-robin**. Token bucket은 fairness가 아닌 rate limiting 도구로 재규정(ScienceDirect, Inngest 블로그). v0.2에 token bucket을 *rate limit* 옵션으로 추가
- **큐 토폴로지**: **Queue-per-job-type + virtual tenant shards**. `queue-per-tenant`는 BullMQ 공식 안티패턴(Discussion #1439), tenant별 queue는 확장성·관리성 모두 실패
- **Outbox consumer**: bridge는 번들, **polling은 `@nestarc/outbox`가 유지**. NestJS outbox 생태계(`nestjs-inbox-outbox`, `fullstackhouse/nestjs-outbox`)의 책임 분리 원칙과 일치

리서치 근거는 `docs/research.md`(후속 작성)에 소스와 함께 정리.

## 10. 비기능 요건

- **호환성**: BullMQ v5+ peer dep. BullMQ raw API 접근 경로(`getQueue`, `getWorker`)를 막지 않음
- **관찰성**: per-tenant wait time, throughput metric 노출 (v0.1 콘솔·콜백, v0.2 Prometheus)
- **테스트 가능성**: in-memory fake queue 기본 제공
- **성능 목표**: dispatcher overhead는 job 하나당 500µs 이내

## 11. 로드맵

**v0.1** (MVP, 3~4주)
- ALS 컨텍스트 전파
- `@JobHandler` 데코레이터, `JobsModule.forRoot`
- Shard-based weighted RR + per-tenant concurrency cap
- Minimum share guarantee (10% 기본)
- `JobsOutboxBridge`
- In-memory fake queue
- tenancy 자동 통합

**v0.2**
- Token bucket rate limit 옵션 (fairness와 분리)
- Plan별 자동 가중치 (entitlements 패키지 연동)
- Bull Board integration doc
- Per-tenant introspection API (`listActive`, `listWaiting`)
- Prometheus exporter

**v0.3**
- 분산 dispatcher 조정 (여러 worker 인스턴스)
- Per-tenant DLQ 분리
- Priority inversion 옵션

## 12. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| BullMQ 업그레이드 시 내부 API 변경 | peer dep 버전 범위 명시, 통합 테스트 매트릭스 |
| 가중치 낮은 테넌트의 starvation | Minimum share guarantee 기본 10%, 설정 가능 |
| Per-tenant concurrency cap으로 throughput 저하 | 전체 worker pool 크기를 tenant cap 합보다 크게 권장 |
| ALS 전파가 프레임워크 전반에 지뢰 | tenancy 없이도 기본 no-op 동작 |
| BullMQ Pro 대비 기능 격차(Group groups, rate limit, scheduler) | README에 "Pro가 제공하되 우리가 안 하는 것"을 정직하게 명시 |
| Dispatcher가 SPOF가 됨 | 여러 worker 인스턴스에서 독립 dispatcher가 작동, BullMQ atomic move 기반 중복 방지 |

## 13. 경계 조건

이 패키지는 **BullMQ의 추상을 감추지 않는다.** 직접 BullMQ API를 쓰고 싶은 사용자는 `getQueue()`, `getWorker()`로 raw 접근 가능. 이 경계를 흐리면 "왜 이 라이브러리인가" 설명이 곤란해진다. 경쟁력은 **BullMQ 교체가 아니라 BullMQ 위의 얇은 tenant-fair 레이어**에 있다.
