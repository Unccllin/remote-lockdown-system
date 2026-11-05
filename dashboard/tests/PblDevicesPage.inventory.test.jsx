import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import PblDevicesPage from '../src/pages/PblDevicesPage';
import { setupUser, renderWithRouter } from './setup';

// PBL devices come from the PBL client (/v1/*), inventory from the main API
// (/api/integrations). Both are mocked so the page's own decisions are what is
// under test.
vi.mock('../src/api/pblClient', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('../src/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import pblApi from '../src/api/pblClient';
import api from '../src/api/client';

function mockInventory({ status, devices, error }) {
  api.get.mockImplementation((url) => {
    if (url === '/integrations') return Promise.resolve({ data: { integrations: status } });
    if (url.startsWith('/integrations/')) {
      if (error) return Promise.reject(error);
      return Promise.resolve({ data: { source: 'x', readOnly: true, fetchedAt: '2026-11-04T08:00:00Z', devices } });
    }
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
  pblApi.get.mockResolvedValue({ data: { devices: [] } });
});

describe('PblDevicesPage — device inventory (part of the PBL surface)', () => {
  it('distinguishes a connected-but-unauthorised source from none at all', async () => {
    mockInventory({
      // enabled (a URL/tenant is set) but no credentials yet — a different state
      // from "nothing is connected", and the page must say so.
      status: [{ id: 'source-a', name: 'Upstream', enabled: true, configured: false }],
    });

    renderWithRouter(<PblDevicesPage />);

    await waitFor(() => {
      expect(screen.getByText(/connected but not authorised/i)).toBeInTheDocument();
    });
    // Our terms, not the upstream's: the connector's name is never rendered.
    expect(screen.queryByText(/Upstream/i)).not.toBeInTheDocument();
    expect(screen.getByText('Device inventory')).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });

  it('renders the normalized inventory when a source is connected', async () => {
    mockInventory({
      status: [{ id: 'source-a', name: 'Upstream', enabled: true, configured: true }],
      devices: [
        { id: 'n1', name: 'WORKSTATION-7', online: true, lastSeenAt: '2026-11-04T07:00:00Z', platform: 'Windows 11' },
        { id: 'n2', name: 'LAPTOP-2', online: false, lastSeenAt: null, platform: null },
      ],
    });

    renderWithRouter(<PblDevicesPage />);

    await waitFor(() => {
      expect(screen.getByText('WORKSTATION-7')).toBeInTheDocument();
    });
    expect(screen.getByText('LAPTOP-2')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('Windows 11')).toBeInTheDocument();
  });

  it('degrades to a notice when the source is unreachable, without failing the page', async () => {
    mockInventory({
      status: [{ id: 'source-a', name: 'Upstream', enabled: true, configured: true }],
      error: Object.assign(new Error('upstream'), {
        response: { status: 502, data: { code: 'UPSTREAM_ERROR' } },
      }),
    });

    renderWithRouter(<PblDevicesPage />);

    await waitFor(() => {
      expect(screen.getByText(/Inventory source unreachable/i)).toBeInTheDocument();
    });
    // The PBL device table must still render — enforcement is unaffected. The empty
    // state now explains the two registries (S229) instead of a bare "no devices".
    expect(screen.getByTestId('pbl-empty-registry')).toBeInTheDocument();
  });

  it('says nothing is connected when no source is enabled at all', async () => {
    mockInventory({
      status: [{ id: 'source-a', name: 'Upstream', enabled: false, configured: false }],
    });

    renderWithRouter(<PblDevicesPage />);

    await waitFor(() => {
      expect(screen.getByText(/No inventory source is connected/i)).toBeInTheDocument();
    });
  });
});
