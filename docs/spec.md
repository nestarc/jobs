# @nestarc/jobs — v0.1 Technical Spec

본 문서는 v0.1에서 고정되는 기술 결정을 기록한다. 변경은 RFC 수준의 논의를 거친다.

## 1. 아키텍처 한눈에

```
Producer (HTTP handler)
  │ jobs.enqueue('sendReport', payload)
  │    └─ ALS snapshot attached to job.data.__nestarcCtx
  ▼
BullMQ Queue  (queue-per-job-type, 표준 BullMQ)
  │
  ▼
FairWorker (nestarc 관리)
  │ ─ dispatcher가 tenant shard 순서로 accept
  │ ─ per-tenant concurrency cap 검사
  │ ─ min share guarantee 평가
  ▼
Handler invocation (ALS 복원 후 실행)
```

**v0.1 구현 경로 (A안 확정)**: 두 backend path가 분리된다.
- **InMemory backend + FairWorker**: scheduler가 다음 job을 완전히 선택. 이 경로에서 tenant fairness가 100% 보장됨.
- **BullMQ backend**: 표준 `Worker`(autorun: true)가 FIFO로 job을 소비. scheduler는 **개입하지 않음**. `Worker.getNextJob()`이 임의 job 선택을 지원하지 않는 BullMQ 내부 구조상, OSS BullMQ에서 fairness를 동시 달성하려면 Redis Lua 스크립트가 필요하며 이는 v0.2로 연기.

두 경로 모두 ALS context 전파, `@JobHandler` discovery, outbox bridge는 동일하게 작동. 모듈 API(`JobsModule.forInMemory` / `forBullMQ`)는 이 tradeoff를 import 시점에 명시적으로 드러낸다.

## 2. 키 포맷 및 명명

### 2.1 Queue 이름
- 기본: `<namespace>.<jobType>` (예: `acme.sendReport`)
- namespace는 `JobsModule.forRoot({ namespace: 'acme' })`로 설정, 기본 `nestarc`
- 큐는 job type당 하나. **tenant별 큐 생성 금지**

### 2.2 Job ID
- BullMQ 기본 (auto) + 사용자 지정 허용
- dedupe용 키는 사용자가 payload 외에 `jobId`로 전달

## 3. ALS 컨텍스트 전파

### 3.1 Enqueue 시점
```ts
async enqueue(jobType: string, payload: unknown, opts?: JobOptions) {
  const ctx = this.contextExtractor();   // e.g. tenancy ALS 읽기
  return this.getQueue(jobType).add(jobType, { ...payload, __nestarcCtx: ctx }, opts);
}
```

### 3.2 Execute 시점
```ts
async process(job: BullJob) {
  const { __nestarcCtx, ...payload } = job.data;
  return this.contextRunner(__nestarcCtx, () => this.handler(payload, job));
}
```

### 3.3 contextExtractor / contextRunner
- 모듈 설정에서 주입. `@nestarc/tenancy` 사용 시 기본값 자동 제공
- 주입 없으면 `{}` payload 그대로 통과 (no-op)

### 3.4 보안
- `__nestarcCtx` 키는 예약어. 사용자가 동일 키로 payload를 보내면 enqueue에서 거절
- 복원된 ALS는 handler 실행 중에만 유효. 외부로 직접 노출되는 API 없음

## 4. 공정 스케줄러 (Shard-based Weighted Round Robin)

### 4.1 기본 개념
- 각 job type queue 안의 waiting job들을 `tenantId` 기준으로 **가상 shard**에 그룹핑
- dispatcher는 shard 목록을 round-robin으로 순회
- 각 shard의 가중치(weight)는 shard 당 1사이클당 pick 가능 횟수

### 4.2 알고리즘 (의사 코드)
```
state: {
  shards: Map<tenantId, { weight, inflight, starvationTokens }>,
  cursor: 0,
  minSharePct: 0.1,
}

pickNext():
  for i in [0, shards.size):
    shard = shards[(cursor + i) % shards.size]
    if shard.inflight >= shard.tenantCap:
      continue
    if shard.weight > 0 OR shard.starvationTokens >= starvationThreshold:
      cursor = (cursor + i + 1) % shards.size
      return popOneJob(shard.tenantId)

  // 아무도 못 골랐으면 minShare 보장 체크: 가장 오래 기다린 shard 1개 강제 선택
  starved = shards.orderBy(oldestWait).first()
  if starved && starved.inflight < tenantCap:
    return popOneJob(starved.tenantId)

  return null   // 모든 tenant가 cap 소진
```

### 4.3 Minimum Share Guarantee
- 기본 `minSharePct = 0.1` (10%)
- 매 N cycles마다 각 shard의 최소 `N * minSharePct` 실행 보장
- 보장 미달 시 `starvationTokens`가 증가, 임계 도달 시 강제 pick
- 이 접근은 BullMQ Pro Groups에 없는 **nestarc의 추가 안전망**

### 4.4 가중치
- `dataSubjectService.setTenantWeight(tenantId, n)` 런타임 변경 허용
- plan 변경 이벤트에 반응 (v0.2)
- shard 상태는 v0.1에서는 **단일 worker 프로세스 메모리**. 분산은 v0.3

## 5. Per-Tenant Concurrency Cap

- `concurrency.tenantCap`: 한 테넌트당 동시 실행 가능 job 수. 기본 10
- `concurrency.globalCap`: 전체 동시 실행. 기본 50
- shard의 `inflight`가 `tenantCap`에 도달하면 dispatcher는 다음 shard로 넘어감

## 6. Public API

### 6.1 Module
```ts
JobsModule.forRoot({
  namespace?: string;
  redis: ConnectionOptions | { url: string };
  concurrency?: { globalCap?: number; tenantCap?: number };
  fairness?: { minSharePct?: number; defaultWeight?: number };
  contextExtractor?: () => Record<string, unknown>;
  contextRunner?: (ctx: Record<string, unknown>, fn: () => unknown) => unknown;
  onJobStart?: (info: JobEvent) => void;
  onJobFinish?: (info: JobEvent) => void;
  onJobFail?: (info: JobEvent, err: Error) => void;
})
```

### 6.2 Service
```ts
interface JobsService {
  enqueue(jobType: string, payload: unknown, opts?: JobOptions): Promise<string>;
  getQueue(jobType: string): BullQueue;     // raw escape
  getWorker(jobType: string): FairWorker;   // raw escape
  setTenantWeight(tenantId: string, weight: number): void;
  listShards(jobType: string): ShardInfo[];
}
```

### 6.3 Handler 데코레이터
```ts
@Injectable()
export class ReportHandler {
  @JobHandler('sendReport')
  async handle(payload: { userId: string }, ctx: JobContext) {
    // ctx.tenantId 등 ALS에서 읽힘
  }
}
```

### 6.4 Outbox Bridge
```ts
JobsOutboxBridge.forRoot({
  source: outboxService,
  map: Record<OutboxEventType, JobType>,
  tenantFrom?: (event: OutboxEvent) => string;   // 기본: event.tenantId
})
```

내부 구현은 ~30줄: outbox의 `onEvent` 콜백 구독 → match된 이벤트 → `jobs.enqueue`.

## 7. BullMQ 사용 경계

- `Worker({ autorun: false })`로 생성
- `getNextJob()`을 dispatcher 루프에서 호출해 pull 타이밍 제어
- 나머지 BullMQ 기능(retry, backoff, DLQ, rate limit) 모두 **그대로 노출**
- `JobOptions`는 BullMQ의 `JobsOptions`를 확장 없이 재수출

## 8. 테스트 기반

### 8.1 In-Memory Fake Queue
- `FakeJobsService`를 제공
- enqueue는 메모리 배열에 push
- `drain()`으로 등록 handler를 순차 호출 (dispatcher 동작도 시뮬레이션)
- tenant cap, weight, min share 모두 Fake에도 적용 → 배포 전 fairness 테스트 가능

### 8.2 예시
```ts
const fake = new FakeJobsService({ tenantCap: 2, weights: { t1: 3, t2: 1 } });
await fake.enqueue('x', { msg: 1 }, { ctx: { tenantId: 't1' } });
await fake.drain();
expect(fake.picked.map(j => j.ctx.tenantId)).toEqual(['t1','t1','t1','t2']);
```

## 9. 에러 코드

| 코드 | 의미 |
|---|---|
| `jobs_reserved_payload_key` | payload에 `__nestarcCtx` 사용 시도 |
| `jobs_handler_not_found` | 등록되지 않은 jobType |
| `jobs_queue_not_found` | raw escape에서 없는 큐 요청 |
| `jobs_fairness_misconfig` | weight ≤ 0 또는 minSharePct > 1 등 |

## 10. 보안 체크리스트

- [x] `__nestarcCtx` 키 충돌 방지
- [x] ALS 복원 실패 시 handler 실행 거부 (silent-empty 방지)
- [x] tenant id 검증은 consumer 책임 (문서에 명시)
- [x] redis 연결은 TLS 권장, README에 명시
- [x] Job payload 로깅 시 PII redaction은 consumer 책임 (hook 제공)

## 11. 다른 nestarc 패키지와의 결합

### @nestarc/tenancy
- 기본 `contextExtractor` = tenancy ALS store 읽기
- 기본 `contextRunner` = tenancy ALS `run()` wrapping
- tenancy 없어도 jobs는 작동 (no-op context)

### @nestarc/outbox
- `JobsOutboxBridge`가 outbox의 polling 이벤트를 구독
- **polling 로직은 outbox 패키지에 그대로 유지**. jobs는 dispatch target
- 같은 트랜잭션 내 outbox insert → consumer worker가 잠시 후 job으로 변환

### @nestarc/audit-log
- `onJobStart/Finish/Fail` 콜백을 audit-log와 wire
- jobType, tenantId, duration, failureReason 기록

### @nestarc/data-subject
- 기존에 `data_subject.erasure_requested` outbox 이벤트 publish
- Bridge map에 한 줄 추가로 consumer 연결
```ts
JobsOutboxBridge.forRoot({
  source: outboxService,
  map: { 'data_subject.erasure_requested': 'handleErasure' },
})
```

### @nestarc/webhook (미래)
- outbound webhook 재시도 worker로 jobs 활용

## 12. v0.1에서 의도적으로 제외된 것

- **분산 dispatcher**: 단일 worker 프로세스의 인메모리 상태만. 여러 worker 인스턴스 간 shard state 공유는 v0.3
- **토큰 버킷 rate limit**: BullMQ의 rate limiter를 그대로 쓰도록 안내. nestarc rate limit은 v0.2
- **Plan 연동 가중치 자동화**: entitlements 패키지가 아직 없음. 수동 `setTenantWeight` 사용
- **Prometheus exporter**: v0.2
- **DLQ per tenant**: BullMQ의 failed queue 공유. 분리는 v0.3

## 13. 성능 목표

- Dispatcher 선택 overhead: job 당 p99 < 500µs
- Enqueue 대기시간: BullMQ baseline + context serialization 50µs 이내
- 10 tenant × 1000 waiting jobs에서 fairness 편차 ±5%

## 14. 테스트 전략

- **단위**: shard scheduler (가중치, min share, starvation boost), context serialization
- **통합**: FakeJobsService로 end-to-end flow, ALS 복원, bridge 동작
- **Contract**: Worker interface에 대해 BullMQ-backed와 InMemory-backed가 동일 동작 검증
- **Fairness test**: 시나리오 기반 (한 테넌트 대량 enqueue, 다른 테넌트 p50 측정)
- **배포 전**: BullMQ Pro Groups와 동일 입력에 대해 비슷한 출력 분포 검증 (샘플 시나리오)
