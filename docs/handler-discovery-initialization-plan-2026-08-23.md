# `@JobHandler()` discovery 초기화 계약 작업 계획

- 작성일: 2026-08-23 (Asia/Seoul)
- 대상 패키지: `@nestarc/jobs@0.3.1` (변경 전 배포 버전 `0.3.0`)
- 관련 저장소: `jobs`, `nestjs-tenancy`
- 목적: 상위/인접 Nest module에 선언된 decorator handler가 의존성 초기화 전에 등록될 수 있는 문제를 재현하고, 모든 provider 초기화 이후 handler를 등록한 다음 worker를 시작하도록 lifecycle 계약을 고정한다.

## 1. 요약

현재 `JobsModule`은 `JOBS_WORKERS` provider factory를 생성하는 동안 `DiscoveryService`로
전체 Nest provider를 스캔하고 `@JobHandler(jobType)` 메서드를 `HandlerRegistry`에
등록한다.

이 방식은 handler가 단순 singleton이고 주입 dependency가 없을 때는 동작한다. 하지만
`JobsModule`을 import하는 상위 feature module의 handler가 다른 provider를 주입받으면,
Nest가 모든 provider instance와 lifecycle hook을 완전히 초기화하기 전에 discovery가
실행될 수 있다. 이때 registry가 초기화 전 instance를 캡처하거나 provider를 건너뛰면
나중에 완성된 Nest provider와 다른 instance를 호출할 수 있다.

`nestjs-tenancy` ecosystem fixture에서는 이 순서를 관찰한 뒤 `@JobHandler()` 자동 발견을
사용하지 않고 `await app.init()` 이후 공개 `HandlerRegistry`에 handler closure를 수동
등록하는 workaround를 사용한다.

이 작업의 목표는 다음 순서를 명시적인 runtime 계약으로 만드는 것이다.

```text
모든 Nest provider 생성
→ 모든 module lifecycle (`onModuleInit`) 초기화 완료
→ Jobs application-bootstrap coordinator 실행
→ @JobHandler() discovery 및 registry 등록
→ worker/consumer 시작
→ job 처리
```

> 2026-08-23 구현 결과: Nest 10과 11은 module별 `onApplicationBootstrap()` 실행
> 순서가 다르므로 모든 provider의 application-bootstrap hook 완료까지를 계약으로 만들 수는
> 없었다. 양 버전이 공통으로 보장하는 계약은 모든 `onModuleInit()` 완료 후 Jobs의
> `onApplicationBootstrap()` coordinator가 discovery와 consumer 시작을 순차 실행하는 것이다.

## 2. 현재 구현

### 2.1 Handler discovery

`src/jobs.module.ts`의 `registerHandlers()`는 `DiscoveryService.getProviders()` 결과에서
`provider.instance`를 즉시 읽는다.

```ts
for (const provider of discovery.getProviders()) {
  const instance = provider.instance;
  if (!instance || typeof instance !== 'object') continue;
  const prototype = Object.getPrototypeOf(instance);
  scanner.scanFromPrototype(instance, prototype, (method) => {
    const jobType = Reflect.getMetadata(JOB_HANDLER_METADATA, prototype[method]);
    if (jobType) {
      registry.register(jobType, (payload, ctx) =>
        prototype[method].call(instance, payload, ctx),
      );
    }
  });
}
```

### 2.2 In-memory startup

`JobsModule.forInMemory()`의 `JOBS_WORKERS` factory에서 다음 두 작업을 함께 수행한다.

1. handler discovery/registration
2. `FairWorker[]` 생성

그 후 `InMemoryWorkersHost.onModuleInit()`이 polling loop를 시작한다.

### 2.3 BullMQ startup

`JobsModule.forBullMQ()`의 `JOBS_WORKERS` factory는 다음 작업을 즉시 수행한다.

1. handler discovery/registration
2. `backend.startConsumer()` 호출

즉 BullMQ consumer 시작은 application bootstrap hook보다도 이르며 provider factory의
부수 효과다.

### 2.4 현재 테스트 공백

기존 `test/integration/jobs.module.in-memory.test.ts`와
`test/integration/module-v0.2-events.test.ts`는 decorator discovery를 확인하지만 handler가
constructor dependency를 사용하지 않는다. 따라서 아래 상황을 검증하지 못한다.

- importing parent module에 선언된 handler
- handler의 constructor-injected dependency
- dependency의 `onModuleInit()` 또는 `onApplicationBootstrap()` 상태
- discovery가 캡처한 instance와 `moduleRef.get()` instance의 동일성
- handler 등록 완료 전 worker/consumer 시작 여부

## 3. 관찰된 ecosystem 영향

`nestjs-tenancy`의 ecosystem fixture는 다음 실제 경로를 검증한다.

```text
API key
→ tenancy context
→ RBAC
→ PostgreSQL RLS/outbox
→ jobs context 복원
→ WebhookService
→ signed HTTP webhook
```

원래 의도는 상위 `EcosystemModule` provider가 `WebhookService`를 주입받고
`@JobHandler('webhook.publish')`로 처리하는 것이다. 현재 fixture는 초기화 순서 문제를
피하기 위해 다음과 같이 app init 이후 수동 등록한다.

```ts
await app.init();

const webhooks = app.get(WebhookService);
app.get(HandlerRegistry).register('webhook.publish', async (payload) => {
  // restored tenant context에서 webhook 전송
  await webhooks.sendToTenant(/* ... */);
});
```

이 workaround는 runtime을 deterministic하게 만들지만 README가 약속하는 decorator 기반
provider scanning을 대표 통합 경로에서 사용하지 못한다.

## 4. 원인 가설과 검증 기준

현재 근거로 가장 강한 원인 가설은 `JOBS_WORKERS` provider factory가 Nest의 전체 provider
초기화보다 먼저 `DiscoveryService`를 조회한다는 것이다. Nest는 dependency graph를 만드는
동안 provider wrapper/prototype를 먼저 노출할 수 있으므로 당시 `provider.instance`가 최종
singleton instance라고 가정하면 안 된다.

### 4.1 2026-08-23 재현 결과

- Jobs 회귀 fixture에서 기존 구현은 `compile()`이 끝난 시점에 이미
  `dependency.job`을 registry에 등록했다. 즉 discovery가 `app.init()`보다 먼저 실행되는
  사실을 확인했다.
- 단순 fixture에서는 조기 instance와 `moduleRef.get(InjectedJobHandler)`가 동일했다. 모든
  조기 discovery가 다른 instance를 만든다는 가설은 성립하지 않았다.
- import 순서와 provider graph가 복잡한 실제 tenancy published-only fixture에서는 현재
  배포된 `@nestarc/jobs@0.3.0`이 constructor dependency인 `WebhookService`가 `undefined`인
  handler instance를 캡처했다. job은
  `Cannot read properties of undefined (reading 'sendToTenant')`로 실패했다.
- 기존 in-memory worker는 `onModuleInit()`에서 polling을 시작하므로 bootstrap 전에 enqueue한
  job이 application-bootstrap hook보다 먼저 실행될 수 있었다.
- Nest 10 fixture에서는 dependency의 `onApplicationBootstrap()`이 Jobs보다 먼저 실행됐지만,
  Nest 11에서는 반대 순서가 관찰됐다. 따라서 이 작업의 안정적인 cross-version ready
  기준은 constructor injection과 모든 `onModuleInit()` 완료로 확정했다.

구현에 들어가기 전에 실패하는 회귀 테스트로 다음을 증명해야 한다.

1. discovery 시점의 handler instance와 `moduleRef.get(Handler)` 결과가 다른지 확인한다.
2. constructor-injected dependency 또는 lifecycle-initialized 상태가 handler 호출 시
   준비되지 않는지 확인한다.
3. provider가 아예 skip되어 `jobs_handler_not_found`가 발생하는 경우와 초기화 전 instance가
   등록되는 경우를 구분한다.
4. NestJS 10과 11에서 같은 원인인지 확인한다.

테스트가 다른 원인을 드러내면 이 문서의 설계보다 재현 근거를 우선한다.

## 5. 권장 설계

### 5.1 provider factory의 startup 부수 효과 제거

다음 작업을 `JOBS_WORKERS` factory에서 제거한다.

- `registerHandlers()` 실행
- BullMQ `backend.startConsumer()` 호출

provider factory는 runtime 객체와 설정만 구성하고 application startup을 시작하지 않아야
한다.

### 5.2 lifecycle coordinator 도입

in-memory와 BullMQ 각각 또는 공통 coordinator가 명시적으로 다음 순서를 수행한다.

```text
onApplicationBootstrap()
  1. handler discovery
  2. duplicate/missing handler validation
  3. in-memory polling loop 또는 BullMQ consumer 시작
```

`onModuleInit()`보다 `onApplicationBootstrap()`을 사용한다. application bootstrap은 모든
module의 `onModuleInit()` 이후 호출되므로 상위 feature dependency의 module lifecycle state를
handler가 사용할 수 있다. Nest 10/11의 module별 application-bootstrap 순서는 다르므로
handler dependency의 `onApplicationBootstrap()` 완료는 이 계약에 포함하지 않는다.

단, discovery provider와 worker provider를 별도 hook으로만 나누면 hook 실행 순서에 새로운
race가 생길 수 있다. handler 등록과 worker 시작을 같은 coordinator method에서 순차적으로
수행하거나, worker startup이 명시적으로 discovery completion promise를 await해야 한다.

### 5.3 shutdown 계약 보존

기존 계약을 회귀시키면 안 된다.

- in-memory worker loop는 `onModuleDestroy()`에서 정지하고 active tick을 기다린다.
- BullMQ backend는 active handler를 drain한 뒤 queue/worker를 닫는다.
- Nest 10/11의 module destruction order 차이를 처리하는 현재
  `BULLMQ_SHUTDOWN_DISTANCE` 보정은 유지하거나 동등한 테스트로 대체한다.
- handler가 실행 중일 때 주입 dependency가 먼저 파괴되지 않아야 한다.

### 5.4 handler scope 계약

현재 구현은 stable `provider.instance`를 registry에 바인딩하므로 singleton provider를
전제로 한다. request/transient-scoped handler까지 지원할지 이번 작업에서 명확히 결정한다.

최소 안전 계약:

- singleton handler: 지원
- request/transient handler: 명시적 fail-fast 또는 비지원 문서화
- discovery 시 instance가 없으면 silent skip하지 않고 actionable error 제공 검토

scope 확장은 이 문제를 해결하기 위한 필수 조건은 아니다. 기존 API 범위를 불필요하게
넓히지 않는다.

## 6. Jobs 저장소 테스트 계획

### 6.1 필수 회귀 fixture

다음 module 구조를 사용하는 integration test를 추가한다.

```text
RootTestingModule
└── imports: FeatureModule
    ├── imports: JobsModule.forInMemory(...), DependencyModule
    └── providers: InjectedJobHandler

InjectedJobHandler
└── constructor(ReadyDependency)

ReadyDependency
└── onModuleInit()에서 ready = true
```

`InjectedJobHandler`는 `@JobHandler('dependency.job')` 메서드에서 다음을 assertion 가능한
결과로 기록한다.

- injected dependency가 존재함
- dependency lifecycle state가 ready임
- handler의 `this`가 `moduleRef.get(InjectedJobHandler)`와 동일함
- job이 정확히 한 번 처리됨

현재 구현에서 테스트가 실패하는 것을 먼저 확인한 뒤 lifecycle 수정으로 통과시킨다.

### 6.2 In-memory 검증

- parent/feature module handler 자동 발견
- constructor injection 완료
- dependency `onModuleInit()` 완료
- bootstrap 전 enqueue된 job도 discovery 후 정상 처리
- duplicate `@JobHandler(jobType)`의 기존 오류 계약 유지
- handler 미존재 시 `jobs_handler_not_found` 유지
- module close 시 worker loop 종료

### 6.3 BullMQ/Redis 검증

- 같은 injected handler fixture를 실제 Redis consumer로 실행
- consumer가 discovery 완료 전에 job을 처리하지 않음
- tenant/job context 복원 유지
- active handler shutdown/drain 계약 유지
- reconnect/restart 후 handler registry 및 consumer 정상 시작

### 6.4 Nest/Node matrix

기존 reusable verify workflow의 범위를 활용한다.

- Node.js 20, 22, 24
- NestJS 10, 11
- in-memory integration은 최소 Nest 10/11 lane에서 실행
- Redis integration은 기존 Node × Nest matrix에서 실행

현재 unit job은 기본 Nest 10만 사용하므로 새 lifecycle 회귀 테스트가 unit에만 들어가면
Nest 11 회귀를 놓칠 수 있다. 별도 module lifecycle matrix를 추가하거나 기존
consumer/Redis matrix에서 해당 테스트를 실행한다.

## 7. Tenancy fixture 전환

Jobs 수정과 tarball 검증이 끝나면 `nestjs-tenancy` fixture를 실제 decorator 경로로
변경한다.

### 7.1 handler provider 추가

예상 구조:

```ts
@Injectable()
class WebhookPublishHandler {
  constructor(private readonly webhooks: WebhookService) {}

  @JobHandler('webhook.publish')
  async handle(payload: { projectId: string; name: string }): Promise<void> {
    const tenantId = TenancyContext.getCurrentTenantId();
    if (!tenantId) throw new Error('Restored job tenant context is required');
    await this.webhooks.sendToTenant(/* existing event/options */);
  }
}
```

이를 `EcosystemModule.providers`에 추가한다.

### 7.2 manual workaround 제거

`test/ecosystem/fixture/test/ecosystem.e2e-spec.ts`에서 다음을 제거한다.

- `HandlerRegistry` import
- `app.get(HandlerRegistry).register(...)`
- app init 이후 수동 handler closure

기존 tenant context, webhook signature, side-effect isolation assertion은 유지한다.

### 7.3 artifact 기반 재검증

1. 수정된 Jobs 로컬 tarball을 사용하는 ecosystem E2E
2. Jobs 새 버전 배포 후 published-only strict ecosystem E2E
3. API Keys `0.3.1` strict install 계약 보존
4. release workflow gate 반영

## 8. 완료 조건

- [x] 현재 구현에서 실패하는 parent-module injected handler 회귀 테스트 확보
- [x] 실패 원인이 discovery/initialization 순서임을 테스트 근거로 확정
- [x] provider factory에서 handler discovery 부수 효과 제거
- [x] handler registration 완료 후 worker/consumer가 시작되는 명시적 lifecycle 구현
- [x] in-memory injected handler 테스트 통과
- [x] BullMQ/Redis injected handler 테스트 통과
- [x] NestJS 10/11에서 회귀 테스트 통과
- [x] 기존 duplicate/missing handler 오류 계약 유지
- [x] 기존 BullMQ shutdown/drain 계약 유지
- [x] README에 discovery 시점과 handler scope 계약 기록
- [x] CI 및 release reusable verify workflow에 lifecycle 회귀 gate 포함
- [x] tenancy fixture의 manual `HandlerRegistry` workaround 제거
- [x] tenancy fixture가 `@JobHandler('webhook.publish')` provider를 사용
- [x] 로컬 Jobs tarball ecosystem E2E 통과
- [ ] 새 Jobs release 기반 published-only ecosystem E2E 통과
- [x] API Keys `0.3.1` strict ecosystem 설치 계약 회귀 없음

## 9. 권장 검증 명령

Jobs 저장소:

```bash
npm ci
npm run lint
npm run build
npm test -- --runInBand
npm run test:redis
npm run test:coverage
npm pack --dry-run
```

Nest 11 lane:

```bash
npm install --no-save --package-lock=false \
  @nestjs/common@^11.0.0 \
  @nestjs/core@^11.0.0 \
  @nestjs/testing@^11.0.0
npm test -- --runInBand
npm run test:redis
```

Tenancy 저장소:

```bash
npm run lint
npm test -- --runInBand
npm run build
npm run test:e2e:ecosystem

NESTARC_ECOSYSTEM_SOURCE_ROOT=/path/without/local/siblings \
  npm run test:e2e:ecosystem
```

## 10. 비범위 및 주의사항

- queue scheduling, fairness, retry, idempotency 알고리즘 변경은 비범위다.
- tenant context envelope 형식 변경은 비범위다.
- public `HandlerRegistry.register()` API는 manual/dynamic handler 사용자를 위해 유지한다.
- discovery 지연으로 bootstrap 전에 enqueue된 job을 잃으면 안 된다. worker만 bootstrap 이후
  시작하고 backend의 queued state는 유지해야 한다.
- BullMQ consumer를 중복 시작하지 않도록 lifecycle method에 idempotency guard가 필요하다.
- handler discovery 실패 후 worker를 시작해 silent runtime failure로 바꾸지 않는다.
- Nest 내부 wrapper 필드에 새로 의존하기 전에 public `DiscoveryService`와 lifecycle hook으로
  해결 가능한지 우선 검토한다.

## 11. 2026-08-23 작업 결과

### 11.1 구현

- `JOBS_WORKERS` factory에서 decorator discovery와 BullMQ `startConsumer()` 호출을 제거했다.
- 공통 `HandlerDiscovery`와 in-memory/BullMQ application-bootstrap host가 discovery 완료 후
  worker/consumer를 시작한다. host에는 중복 시작 guard가 있다.
- discovery는 초기화된 singleton instance의 bound method를 등록한다.
- request/transient provider와 request-scoped dependency tree는 bootstrap에서 actionable
  `TypeError`로 fail-fast한다.
- bootstrap 전에 enqueue된 in-memory/Redis job이 registry 등록 후 처리되는 회귀 fixture를
  추가했다.
- reusable verify workflow에 Nest 10/11 module lifecycle matrix를 추가했다. release workflow는
  이 reusable workflow를 기존과 같이 선행 gate로 사용한다.
- README와 CHANGELOG의 discovery 시점 및 scope 계약을 갱신했다.
- Jobs package 및 lockfile을 patch release `0.3.1`로 bump했다.
- `nestjs-tenancy` ecosystem fixture에 constructor-injected
  `WebhookPublishHandler`를 추가하고 테스트의 manual registry workaround를 제거했다.

### 11.2 검증 결과

Jobs (Nest 10):

- `npm run lint`: 통과
- `npm run build`: 통과
- `npm test -- --runInBand`: 20 suites, 151 tests 통과
- `npm run test:redis`: 1 suite, 41 tests 통과
- `npm run test:coverage`: 21 suites, 192 tests 통과; global statements 91.46%,
  branches 82.66%, functions 96.93%, lines 93.72%
- `npm pack --dry-run`: 통과, 58 files

Jobs (Nest 11 임시 dependency matrix):

- module lifecycle regression: 5 tests 통과
- Redis/BullMQ 전체 suite: 41 tests 통과
- build 및 lint 통과

Tenancy:

- `npm run lint`: 통과
- `npm test -- --runInBand`: 47 suites, 554 tests 통과
- `npm run build`: 통과
- 로컬 sibling Jobs tarball ecosystem E2E: 3 tests 통과
- published-only strict install의 package graph assertion은 통과했고
  `@nestarc/api-keys@0.3.1`을 확인했다.
- published-only 전체 E2E는 현재 배포된 `@nestarc/jobs@0.3.0`의 조기 instance 캡처로
  예상대로 실패했다. 새 수정 버전 배포 후 재실행이 필요하다.

### 11.3 남은 외부 release gate

코드와 로컬 artifact 검증은 완료했다. 다만 npm publish는 외부 배포 작업이므로 이 작업에서
수행하지 않았다. `@nestarc/jobs@0.3.1`이 배포된 뒤 아래 명령을 다시 실행해야 마지막 완료
조건이 닫힌다. tenancy fixture dependency와 expected version은 `0.3.1`로 갱신했다.

```bash
NESTARC_ECOSYSTEM_SOURCE_ROOT=/path/without/local/siblings \
  npm run test:e2e:ecosystem
```

## 12. 작업 시작용 프롬프트

```text
docs/handler-discovery-initialization-plan-2026-08-23.md를 읽고,
@nestarc/jobs의 @JobHandler discovery가 상위 feature module의 constructor-injected
handler를 provider 초기화 전에 캡처하는 문제를 먼저 실패하는 회귀 테스트로 재현해 주세요.
모든 provider 초기화 후 handler 등록이 완료된 다음 in-memory worker/BullMQ consumer가
시작되도록 lifecycle을 수정하고 NestJS 10/11 및 Redis matrix를 통과시켜 주세요.
그 후 nestjs-tenancy ecosystem fixture의 manual HandlerRegistry 등록을
@JobHandler('webhook.publish') provider로 교체하고 tarball/published-only E2E를 검증해 주세요.
```
