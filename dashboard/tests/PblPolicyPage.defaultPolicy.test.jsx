import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import PblPolicyPage from '../src/pages/PblPolicyPage';
import { renderWithRouter } from './setup';

// The page talks to /v1/* through the PBL client; both call sites are mocked so the
// page's own decisions are under test.
vi.mock('../src/api/pblClient', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  pblPolicy: { list: vi.fn(), get: vi.fn(), store: vi.fn(), create: vi.fn() },
  pblAdmin: { getKeyInfo: vi.fn() },
}));

import { pblPolicy, pblAdmin } from '../src/api/pblClient';

const KEY_INFO = {
  data: {
    verdict_signing_key: null,
    policy_signing_key: { kid: 'abc123', algorithm: 'ES256' },
  },
};

/**
 * S229: firmware GET /v1/policy/latest synthesises a signed default policy when the
 * store is empty. The page therefore must not render "No policy versions stored" while
 * a downloadable policy exists -- it said the opposite of what devices receive.
 */
describe('PblPolicyPage - effective policy source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pblAdmin.getKeyInfo.mockResolvedValue(KEY_INFO);
    pblPolicy.get.mockResolvedValue({ data: new ArrayBuffer(64) });
  });

  it('explains that the built-in default is what devices receive', async () => {
    pblPolicy.list.mockResolvedValue({
      data: { latest_version: '1', versions: ['1'], source: 'default' },
    });

    renderWithRouter(<PblPolicyPage />);

    await waitFor(() => {
      expect(screen.getByTestId('policy-default-notice')).toBeInTheDocument();
    });
    const notice = screen.getByTestId('policy-default-notice');
    expect(notice.textContent).toMatch(/built-in default policy/i);
    expect(notice.textContent).toMatch(/version 1/i);
    // The version is listed, and marked as the default rather than a stored one.
    expect(screen.getByText('(built-in default)')).toBeInTheDocument();
  });

  it('shows stored versions without the default notice', async () => {
    pblPolicy.list.mockResolvedValue({
      data: { latest_version: '7', versions: ['7', '6'], source: 'stored' },
    });

    renderWithRouter(<PblPolicyPage />);

    // "7" appears twice by design: as the Latest value and as a list entry.
    await waitFor(() => {
      expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('policy-default-notice')).not.toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('survives a key-info payload with a null verdict key', async () => {
    // The real /v1/admin/key-info returns verdict_signing_key: null until that key is
    // generated; the page must render anyway.
    pblPolicy.list.mockResolvedValue({
      data: { latest_version: '1', versions: ['1'], source: 'default' },
    });

    renderWithRouter(<PblPolicyPage />);

    await waitFor(() => {
      expect(screen.getByText(/not generated/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });
});
