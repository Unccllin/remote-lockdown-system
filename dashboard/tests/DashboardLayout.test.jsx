import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DashboardLayout from '../src/components/DashboardLayout';
import { setupUser } from './setup';

// Mock TopBar to avoid its alerts API + useCurrentUser dependencies
vi.mock('../src/components/TopBar', () => ({
  default: () => <div data-testid="topbar">TopBar</div>,
}));

// Mock the current user hook
vi.mock('../src/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
}));

// Mock the serverless mode hook
vi.mock('../src/hooks/useServerlessMode', () => ({
  useServerlessMode: vi.fn(),
}));

import { useCurrentUser } from '../src/hooks/useCurrentUser';
import { useServerlessMode } from '../src/hooks/useServerlessMode';

function renderWithRouter(initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<DashboardLayout />}>
          <Route index element={<div>Overview Page</div>} />
        </Route>
        <Route path="/devices" element={<DashboardLayout />}>
          <Route index element={<div>Devices Page</div>} />
        </Route>
        <Route path="/admins" element={<DashboardLayout />}>
          <Route index element={<div>Admins Page</div>} />
        </Route>
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('super-admin');
  useCurrentUser.mockReturnValue({
    id: 'admin-id',
    username: 'admin',
    role: 'super-admin',
    isViewer: false,
    isOperator: true,
    isSuperAdmin: true,
  });
  useServerlessMode.mockReturnValue({ serverless: false, loading: false });
});

describe('DashboardLayout', () => {
  it('renders the sidebar with logo and nav items', () => {
    renderWithRouter();
    expect(screen.getByText('DeviceLock')).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
    expect(screen.getByText('Map View')).toBeInTheDocument();
  });

  it('renders the TopBar and Outlet content', () => {
    renderWithRouter();
    expect(screen.getByTestId('topbar')).toBeInTheDocument();
    expect(screen.getByText('Overview Page')).toBeInTheDocument();
  });

  it('renders the Sign out button', () => {
    renderWithRouter();
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  it('shows Enroll Device link for operators and above', () => {
    renderWithRouter();
    expect(screen.getByText('Enroll Device')).toBeInTheDocument();
  });

  it('hides Enroll Device link for viewers', () => {
    useCurrentUser.mockReturnValue({
      id: 'v1',
      username: 'viewer',
      role: 'viewer',
      isViewer: true,
      isOperator: false,
      isSuperAdmin: false,
    });
    renderWithRouter();
    expect(screen.queryByText('Enroll Device')).not.toBeInTheDocument();
  });

  it('shows Admins link for super-admins when not serverless', () => {
    renderWithRouter();
    expect(screen.getByText('Admins')).toBeInTheDocument();
  });

  it('hides Admins link in serverless mode', () => {
    useServerlessMode.mockReturnValue({ serverless: true, loading: false });
    renderWithRouter();
    expect(screen.queryByText('Admins')).not.toBeInTheDocument();
  });

  it('renders system status indicator', () => {
    renderWithRouter();
    expect(screen.getByText('System Online')).toBeInTheDocument();
  });

  it('renders serverless status indicator in serverless mode', () => {
    useServerlessMode.mockReturnValue({ serverless: true, loading: false });
    renderWithRouter();
    expect(screen.getByText('Serverless')).toBeInTheDocument();
  });

  it('navigates to /login on sign out', () => {
    renderWithRouter();
    fireEvent.click(screen.getByText('Sign out'));
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });
});
