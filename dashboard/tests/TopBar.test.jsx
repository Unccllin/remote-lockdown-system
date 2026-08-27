import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TopBar from '../src/components/TopBar';
import { setupUser } from './setup';

// Mock the alerts API
vi.mock('../src/api/alerts', () => ({
  getUnreadAlertCount: vi.fn().mockResolvedValue(3),
}));

// Mock the current user hook
vi.mock('../src/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
}));

import { useCurrentUser } from '../src/hooks/useCurrentUser';

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<div><TopBar /></div>} />
        <Route path="/alerts" element={<div>Alerts Page</div>} />
        <Route path="/devices" element={<div>Devices Page</div>} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('super-admin');
  useCurrentUser.mockReturnValue({ username: 'admin', role: 'super-admin', isSuperAdmin: true });
});

describe('TopBar', () => {
  it('renders search input', () => {
    renderWithRouter();
    expect(screen.getByPlaceholderText(/Search devices/i)).toBeInTheDocument();
  });

  it('renders notification bell with unread count', async () => {
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('renders admin profile chip with username', () => {
    renderWithRouter();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('renders role label', () => {
    renderWithRouter();
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
  });

  it('navigates to /alerts when bell is clicked', () => {
    renderWithRouter();
    const bellButton = screen.getByTitle('Alerts');
    fireEvent.click(bellButton);
    expect(screen.getByText('Alerts Page')).toBeInTheDocument();
  });

  it('shows profile dropdown on click', () => {
    renderWithRouter();
    const profileButton = screen.getByText('admin').closest('button');
    fireEvent.click(profileButton);
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  it('navigates on search submit', () => {
    renderWithRouter();
    const input = screen.getByPlaceholderText(/Search devices/i);
    fireEvent.change(input, { target: { value: 'DEV-001' } });
    fireEvent.submit(input.closest('form'));
    expect(screen.getByText('Devices Page')).toBeInTheDocument();
  });
});
