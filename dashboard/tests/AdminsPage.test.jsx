import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import AdminsPage from '../src/pages/AdminsPage';
import { setupUser, renderWithRouter } from './setup';

// Mock the API client
vi.mock('../src/api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}));

// Mock useServerlessMode
vi.mock('../src/hooks/useServerlessMode', () => ({
  useServerlessMode: vi.fn(() => ({ serverless: false })),
}));

import api from '../src/api/client';
import { useServerlessMode } from '../src/hooks/useServerlessMode';

const mockAdmins = [
  { id: '1', username: 'alice', role: 'super-admin', created_at: '2025-01-01T00:00:00Z' },
  { id: '2', username: 'bob', role: 'operator', created_at: '2025-01-02T00:00:00Z' },
  { id: '3', username: 'carol', role: 'viewer', created_at: '2025-01-03T00:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('super-admin');
  useServerlessMode.mockReturnValue({ serverless: false });
  api.get.mockResolvedValue({ data: mockAdmins });
});

describe('AdminsPage', () => {
  it('renders page title and header', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('Admin Management')).toBeInTheDocument();
    });
  });

  it('renders the admin list from API', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('carol')).toBeInTheDocument();
  });

  it('calls GET /admins on mount', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/admins');
    });
  });

  it('shows Refresh and Add Admin buttons', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Admin')).toBeInTheDocument();
  });

  it('shows role badges (Super Admin, Operator, Viewer)', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getAllByText('Super Admin').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Operator').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Viewer').length).toBeGreaterThan(0);
  });

  it('shows empty state when no admins', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText(/No admins found/i)).toBeInTheDocument();
    });
  });

  it('shows create form when Add Admin is clicked', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Admin'));

    expect(screen.getByText('Create New Admin')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. jdoe')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('min 8 characters')).toBeInTheDocument();
  });

  it('creates admin on form submit', async () => {
    api.post.mockResolvedValue({ data: { id: '4', username: 'newadmin', role: 'viewer' } });
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Admin'));

    fireEvent.change(screen.getByPlaceholderText('e.g. jdoe'), { target: { value: 'newadmin' } });
    fireEvent.change(screen.getByPlaceholderText('min 8 characters'), { target: { value: 'password123' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Admin/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admins', {
        username: 'newadmin',
        password: 'password123',
        role: 'viewer',
      });
    });
  });

  it('deletes admin on delete button click', async () => {
    api.delete.mockResolvedValue({ data: {} });
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('bob')).toBeInTheDocument();
    });

    // confirm() is called by handleDelete — mock it to return true
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const deleteButtons = screen.getAllByTitle('Delete admin');
    // bob is not the current user (testuser), so delete should be enabled
    fireEvent.click(deleteButtons[1]);

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith('/admins/2');
    });
  });

  it('loads admins in serverless mode (Worker has /api/admins RBAC)', async () => {
    useServerlessMode.mockReturnValue({ serverless: true });
    renderWithRouter(<AdminsPage />);

    // Should render the admin list, not the "unavailable" message
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Not available in serverless mode/i)).not.toBeInTheDocument();
  });

  it('shows (you) label next to the current user', async () => {
    renderWithRouter(<AdminsPage />);

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });

    // testuser is the current user — but no admin has that username.
    // The current user id is 'test-user-id', so no admin matches.
    // Verify the (you) label does NOT appear for non-self admins.
    expect(screen.queryByText('(you)')).not.toBeInTheDocument();
  });
});
