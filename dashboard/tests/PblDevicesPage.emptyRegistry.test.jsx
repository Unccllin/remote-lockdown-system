import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import PblDevicesPage from '../src/pages/PblDevicesPage';
import { renderWithRouter } from './setup';

// Two registries exist (S229): this page reads /v1/devices, populated only by the PBL
// firmware programme's POST /v1/enroll. An agent-enrolled machine lives in a different
// record and never appears here, so an empty registry is normal — the page must say so
// instead of looking like a fault.
vi.mock('../src/api/pblClient', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('../src/api/inventory', () => ({
  getInventoryStatus: vi.fn().mockResolvedValue({ integrations: [] }),
  getInventoryDevices: vi.fn(),
}));

vi.mock('../src/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ isOperator: true, username: 'tester' }),
}));

import pblApi from '../src/api/pblClient';

describe('PblDevicesPage - empty PBL registry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('explains that the registry is populated only by firmware enrolment', async () => {
    pblApi.get.mockResolvedValue({ data: { devices: [] } });

    renderWithRouter(<PblDevicesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('pbl-empty-registry')).toBeInTheDocument();
    });

    const text = screen.getByTestId('pbl-empty-registry').textContent;
    expect(text).toMatch(/PBL firmware programme/i);
    // The distinction that caused the confusion is named explicitly.
    expect(text).toMatch(/\/v1\/enroll/);
    expect(text).toMatch(/\/api\/enroll\/claim/);
    expect(text).toMatch(/Devices/);
    expect(text).toMatch(/normal/i);
  });

  it('distinguishes an empty registry from an empty filter result', async () => {
    pblApi.get.mockResolvedValue({
      data: {
        devices: [
          {
            device_id: 'aaaa-bbbb-cccc-dddd-eeee',
            status: 'active',
            enrolled_at: '2026-11-05T00:00:00Z',
          },
        ],
      },
    });

    renderWithRouter(<PblDevicesPage />);

    await waitFor(() => {
      expect(screen.getByText(/aaaa-bbbb-cccc-dddd-eeee/)).toBeInTheDocument();
    });
    // With one device present, the registry explanation must NOT appear.
    expect(screen.queryByTestId('pbl-empty-registry')).not.toBeInTheDocument();
  });
});
