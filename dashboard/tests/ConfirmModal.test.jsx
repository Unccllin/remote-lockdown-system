import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from '../src/components/ConfirmModal';

describe('ConfirmModal', () => {
  it('renders title and description', () => {
    render(
      <ConfirmModal
        title="Test Title"
        description="Test description text"
        confirmLabel="Confirm"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test description text')).toBeInTheDocument();
  });

  it('requires typing hostname to confirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal
        title="Flag Device"
        description="Are you sure?"
        confirmLabel="Flag as Stolen"
        confirmValue="DEV-001"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    const confirmBtn = screen.getByText('Flag as Stolen');
    expect(confirmBtn).toBeDisabled();

    // Type the correct hostname
    const input = screen.getByPlaceholderText('DEV-001');
    fireEvent.change(input, { target: { value: 'DEV-001' } });
    expect(confirmBtn).not.toBeDisabled();

    // Click confirm
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('confirm button stays disabled with wrong input', () => {
    render(
      <ConfirmModal
        title="Flag Device"
        description="Are you sure?"
        confirmLabel="Flag as Stolen"
        confirmValue="DEV-001"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const confirmBtn = screen.getByText('Flag as Stolen');
    const input = screen.getByPlaceholderText('DEV-001');

    fireEvent.change(input, { target: { value: 'WRONG' } });
    expect(confirmBtn).toBeDisabled();
  });

  it('calls onCancel when Cancel button clicked', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        title="Test"
        description="Test"
        confirmLabel="OK"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not require text input when confirmValue is not provided', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal
        title="Test"
        description="Test"
        confirmLabel="OK"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    const confirmBtn = screen.getByText('OK');
    expect(confirmBtn).not.toBeDisabled();

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
