import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CheckoutPage from './CheckoutPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderCheckout(sessionId = 'sess_123') {
  return render(
    <MemoryRouter initialEntries={[`/checkout/${sessionId}`]}>
      <Routes>
        <Route path="/checkout/:sessionId" element={<CheckoutPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CheckoutPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches session on mount and renders seatId + amount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ seatId: 'A1', amount: 10 }),
    } as Response);

    renderCheckout();

    expect(await screen.findByTestId('seat-id')).toHaveTextContent('A1');
    expect(screen.getByTestId('amount')).toHaveTextContent('$10.00');
  });

  it('renders error state on 404 from session fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response);

    renderCheckout();

    expect(await screen.findByTestId('checkout-error')).toBeInTheDocument();
  });

  it('navigates to /result?status=success for card ending 4000', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success' }) } as Response);

    renderCheckout();

    fireEvent.change(await screen.findByTestId('card-input'), {
      target: { value: '4111111111114000' },
    });
    fireEvent.click(screen.getByTestId('pay-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/result?status=success');
    });
  });

  it('shows error and does not navigate when pay endpoint returns non-ok', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);

    renderCheckout();

    fireEvent.change(await screen.findByTestId('card-input'), {
      target: { value: '4111111111114000' },
    });
    fireEvent.click(screen.getByTestId('pay-button'));

    expect(await screen.findByTestId('checkout-error')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to /result?status=failed for card ending 5000', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ seatId: 'A2', amount: 10 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed' }) } as Response);

    renderCheckout();

    fireEvent.change(await screen.findByTestId('card-input'), {
      target: { value: '5000000000005000' },
    });
    fireEvent.click(screen.getByTestId('pay-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/result?status=failed');
    });
  });
});
