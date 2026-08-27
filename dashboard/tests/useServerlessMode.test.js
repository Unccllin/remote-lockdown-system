import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useServerlessMode, _resetServerlessCache } from '../src/hooks/useServerlessMode';

// Mock the health API
vi.mock('../src/api/health', () => ({
  getHealth: vi.fn(),
}));

import { getHealth } from '../src/api/health';

beforeEach(() => {
  vi.clearAllMocks();
  _resetServerlessCache();
});

afterEach(() => {
  _resetServerlessCache();
});

describe('useServerlessMode', () => {
  it('returns serverless=true when /health response includes serverless: true', async () => {
    getHealth.mockResolvedValue({ data: { status: 'ok', serverless: true } });

    const { result } = renderHook(() => useServerlessMode());

    // Initially loading with unknown state
    expect(result.current.loading).toBe(true);
    expect(result.current.serverless).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.serverless).toBe(true);
  });

  it('returns serverless=false when /health response has no serverless field (Express server)', async () => {
    getHealth.mockResolvedValue({ data: { status: 'ok', uptimeSeconds: 42 } });

    const { result } = renderHook(() => useServerlessMode());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.serverless).toBe(false);
  });

  it('returns serverless=false when health check fails (server down)', async () => {
    getHealth.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useServerlessMode());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.serverless).toBe(false);
  });

  it('caches the result — second hook instance does not re-fetch', async () => {
    getHealth.mockResolvedValue({ data: { serverless: true } });

    const { result: first } = renderHook(() => useServerlessMode());

    await waitFor(() => {
      expect(first.current.loading).toBe(false);
    });

    expect(getHealth).toHaveBeenCalledTimes(1);

    // Second hook instance — should use cache, not re-fetch
    const { result: second } = renderHook(() => useServerlessMode());

    expect(second.current.serverless).toBe(true);
    expect(second.current.loading).toBe(false);
    expect(getHealth).toHaveBeenCalledTimes(1); // still only 1 call
  });
});
