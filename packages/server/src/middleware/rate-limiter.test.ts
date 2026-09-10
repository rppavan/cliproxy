import { describe, it, expect, afterEach } from 'vitest';
import type { RateLimitConfig } from '@star-cliproxy/shared';
import { RateLimiter } from './rate-limiter.js';

// In tests, getDatabase() is uninitialized and errors are swallowed internally, operating purely in-memory.

function makeConfig(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  return {
    global: { rpm: 1000, rpd: 10000 },
    perProvider: {},
    ...overrides,
  };
}

const limiters: RateLimiter[] = [];
function newLimiter(config: RateLimitConfig): RateLimiter {
  const rl = new RateLimiter(config);
  limiters.push(rl);
  return rl;
}

afterEach(async () => {
  // Clear timers to prevent hanging test process.
  await Promise.all(limiters.splice(0).map((rl) => rl.destroy()));
});

describe('RateLimiter - 폴백 중복 카운트 방지 (HIGH 버그 회귀)', () => {
  it('checkGlobalAndKey + checkProvider 분리: 폴백으로 프로바이더를 여러 번 시도해도 글로벌은 1회만 차감', () => {
    // Simulate fallback to multiple providers with global RPM limit of 2.
    const rl = newLimiter(makeConfig({ global: { rpm: 2, rpd: 100 } }));

    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);
    expect(rl.checkProvider('providerA').allowed).toBe(true);
    expect(rl.checkProvider('providerB').allowed).toBe(true);

    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);
    const third = rl.checkGlobalAndKey('key1');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('레거시 checkAndIncrement는 폴백 시 글로벌을 매번 차감(중복) — 분리 메서드로 교체된 이유', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 2, rpd: 100 } }));
    // Legacy checkAndIncrement deducted global and provider together, consuming multiple global slots during fallbacks.
    expect(rl.checkAndIncrement('key1', 'providerA').allowed).toBe(true);
    expect(rl.checkAndIncrement('key1', 'providerB').allowed).toBe(true);
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(false);
  });
});

describe('RateLimiter - checkProvider', () => {
  it('프로바이더 한도가 없으면 항상 allowed', () => {
    const rl = newLimiter(makeConfig());
    for (let i = 0; i < 100; i++) {
      expect(rl.checkProvider('noLimit').allowed).toBe(true);
    }
  });

  it('프로바이더 RPM 한도 초과 시 차단 + retryAfter', () => {
    const rl = newLimiter(makeConfig({ perProvider: { gemini: { rpm: 2 } } }));
    expect(rl.checkProvider('gemini').allowed).toBe(true);
    expect(rl.checkProvider('gemini').allowed).toBe(true);
    const blocked = rl.checkProvider('gemini');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(rl.checkProvider('other').allowed).toBe(true);
  });
});

describe('RateLimiter - checkGlobalAndKey', () => {
  it('글로벌 RPD 초과 시 글로벌 RPM 롤백 (원자성)', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 100, rpd: 1 } }));
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(false);
  });

  it('API 키별 RPM 한도 적용 + 키별 독립', () => {
    const rl = newLimiter(makeConfig());
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(true);
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(false);
    expect(rl.checkGlobalAndKey('key2', { rpm: 1 }).allowed).toBe(true);
  });

  it('키 RPM 초과 시 글로벌 카운터 롤백', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 5, rpd: 5 } }));
    // key1 has RPM limit 1; rejection must roll back global counters.
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(true);
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(false);
    for (let i = 0; i < 4; i++) {
      expect(rl.checkGlobalAndKey(`k${i}`).allowed).toBe(true);
    }
    expect(rl.checkGlobalAndKey('kX').allowed).toBe(false);
  });
});
