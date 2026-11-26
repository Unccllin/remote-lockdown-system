/**
 * Re-arm approvals (ADR-011, D-226).
 *
 * The route is super-admin gated in App.jsx; what these tests pin is the behaviour an operator relies
 * on: the queue shows what is actually pending, a decision takes two clicks (the queue re-keys a device),
 * and the 15-minute expiry is stated where the decision is made.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const listRearmRequests = vi.fn();
const approveRearmRequest = vi.fn();
const denyRearmRequest = vi.fn();

vi.mock('../src/api/rearm', () => ({
  listRearmRequests: (...a) => listRearmRequests(...a),
  approveRearmRequest: (...a) => approveRearmRequest(...a),
  denyRearmRequest: (...a) => denyRearmRequest(...a),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { renderWithRouter } from './setup';
import RearmRequestsPage from '../src/pages/RearmRequestsPage';

const pending = {
  device_id: 'dev-1',
  hostname: 'STOLEN-LAPTOP',
  hardware_uuid: 'UUID-1',
  device_status: 'stolen',
  requested_at: '2026-11-26T10:00:00.000Z',
  source_ip: '203.0.113.7',
};

describe('RearmRequestsPage', () => {
  beforeEach(() => {
    listRearmRequests.mockReset();
    approveRearmRequest.mockReset();
    denyRearmRequest.mockReset();
    listRearmRequests.mockResolvedValue({ data: { requests: [pending] } });
  });

  it('lists the pending requests with the device and its status', async () => {
    renderWithRouter(<RearmRequestsPage />);

    expect(await screen.findByText('STOLEN-LAPTOP')).toBeInTheDocument();
    expect(screen.getByText('UUID-1')).toBeInTheDocument();
    expect(screen.getByText('stolen')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });

  it('states the 15-minute window where the decision is made', async () => {
    renderWithRouter(<RearmRequestsPage />);
    await screen.findByText('STOLEN-LAPTOP');
    expect(screen.getByText(/expires after 15 minutes/i)).toBeInTheDocument();
  });

  it('shows an empty state rather than an empty table', async () => {
    listRearmRequests.mockResolvedValue({ data: { requests: [] } });
    renderWithRouter(<RearmRequestsPage />);

    expect(await screen.findByText(/no pending requests/i)).toBeInTheDocument();
  });

  it('requires confirmation before approving, then reloads the queue', async () => {
    approveRearmRequest.mockResolvedValue({ data: {} });
    renderWithRouter(<RearmRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    // Nothing is decided yet: the queue hands out a device key.
    expect(approveRearmRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /confirm approve/i }));

    await waitFor(() => expect(approveRearmRequest).toHaveBeenCalledWith('dev-1'));
    // Reloaded rather than spliced: another admin may have decided in the meantime.
    await waitFor(() => expect(listRearmRequests).toHaveBeenCalledTimes(2));
  });

  it('can deny instead, and never calls approve', async () => {
    denyRearmRequest.mockResolvedValue({ data: {} });
    renderWithRouter(<RearmRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^deny$/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm deny/i }));

    await waitFor(() => expect(denyRearmRequest).toHaveBeenCalledWith('dev-1'));
    expect(approveRearmRequest).not.toHaveBeenCalled();
  });

  it('cancelling a confirmation decides nothing', async () => {
    renderWithRouter(<RearmRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(approveRearmRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
  });
});
