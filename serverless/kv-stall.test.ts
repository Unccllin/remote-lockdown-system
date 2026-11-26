/**
 * D-225's instrument: the in-flight KV watchdog.
 *
 * The first wedge could not be diagnosed because nothing measured *which* KV operation stopped
 * answering — and a promise that never settles cannot be timed on completion, so the instrument
 * has to be a witness rather than a stopwatch. These tests pin the witness, its published views,
 * and the fact that a healthy operation leaves no trace.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { KV_STALL_WARN_MS, kvInFlight, kvStalls, watchKv } from './kv-store';
import worker from './worker';

const env = { ADMIN_TOKEN: 'test-admin-token', LOCKDOWN_KV: {} };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('D-225: KV stall watchdog', () => {
  it('names an operation that has not settled, in the log and on health', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The production shape: a KV operation whose promise never settles.
    void watchKv('test.hang', () => new Promise<void>(() => {}), 20);
    await vi.advanceTimersByTimeAsync(21);

    expect(warn).toHaveBeenCalled();
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('[kv-stall]');
    expect(message).toContain('test.hang');

    // Visible to a *different* request in the same isolate, which is the whole point: the hung
    // handler may never get to log again.
    expect(kvInFlight()['test.hang']).toBeGreaterThanOrEqual(20);
    expect(kvStalls()['test.hang'].count).toBe(1);
    expect(kvStalls()['test.hang'].last_ms).toBeGreaterThanOrEqual(20);
  });

  it('leaves no trace when the operation settles in time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(watchKv('test.ok', async () => 'value', 50)).resolves.toBe('value');

    expect(kvInFlight()['test.ok']).toBeUndefined();
    expect(kvStalls()['test.ok']).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('propagates a rejection and still clears the in-flight entry', async () => {
    await expect(
      watchKv('test.fail', async () => {
        throw new Error('KV said no');
      }, 50),
    ).rejects.toThrow('KV said no');

    expect(kvInFlight()['test.fail']).toBeUndefined();
    // A rejection is not a stall: it answered, so it must not be recorded as one.
    expect(kvStalls()['test.fail']).toBeUndefined();
  });

  it('does not fire before the threshold', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let release: (value: string) => void = () => {};
    const op = watchKv('test.slow', () => new Promise<string>((resolve) => {
      release = resolve;
    }), 500);

    await vi.advanceTimersByTimeAsync(499);
    expect(warn).not.toHaveBeenCalled();

    release('slow-but-fine');
    await expect(op).resolves.toBe('slow-but-fine');
  });

  it('counts repeated stalls for the same label', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    void watchKv('test.repeat', () => new Promise<void>(() => {}), 10);
    await vi.advanceTimersByTimeAsync(11);
    void watchKv('test.repeat', () => new Promise<void>(() => {}), 10);
    await vi.advanceTimersByTimeAsync(11);

    expect(kvStalls()['test.repeat'].count).toBe(2);
  });

  it('publishes both views on /api/health, beside the mutation-queue counter', async () => {
    const resp = await worker.fetch(
      new Request('https://lockdown.example.com/api/health'),
      env,
    );
    const data = (await resp.json()) as {
      mutation_queue: { stalls: number };
      kv_inflight: Record<string, number>;
      kv_stalls: Record<string, { count: number }>;
    };

    expect(resp.status).toBe(200);
    expect(data.mutation_queue).toHaveProperty('stalls');
    expect(data.kv_inflight).toBeTypeOf('object');
    expect(data.kv_stalls).toBeTypeOf('object');
  });

  it('defaults to a threshold well inside the agent\'s own timeout', () => {
    // The agent gives up after 15 s (agent.py read timeout). A warning later than that would
    // describe the incident instead of naming the culprit during it.
    expect(KV_STALL_WARN_MS).toBeGreaterThan(0);
    expect(KV_STALL_WARN_MS).toBeLessThan(15000);
  });
});
