import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CheckoutPage from './CheckoutPage';
import { MESSAGES } from '../messages';
import { PAYMENT_ERROR_CODE } from '../constants';

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

// Convenience builder for the two-fetch sequence: GET session + POST pay.
const respond = (
  sessionResp: Partial<Response>,
  payResp: Partial<Response>,
) => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(sessionResp as Response)
    .mockResolvedValueOnce(payResp as Response);
};

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

  it('navigates to /result?status=success&delivered=1 when webhook delivered', async () => {
    respond(
      { ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) },
      { ok: true, json: async () => ({ status: 'success', webhookDelivered: true, deliveryId: 'd-1' }) },
    );

    renderCheckout();

    fireEvent.change(await screen.findByTestId('card-input'), {
      target: { value: '4111111111114000' },
    });
    fireEvent.click(screen.getByTestId('pay-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/result?status=success&delivered=1&sessionId=sess_123');
    });
  });

  it('navigates with delivered=0 when the webhook is still retrying', async () => {
    respond(
      { ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) },
      { ok: true, json: async () => ({ status: 'success', webhookDelivered: false, deliveryId: 'd-2' }) },
    );

    renderCheckout();

    fireEvent.change(await screen.findByTestId('card-input'), {
      target: { value: '4111111111114000' },
    });
    fireEvent.click(screen.getByTestId('pay-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/result?status=success&delivered=0&sessionId=sess_123');
    });
  });

  it('shows the session-expired message when the backend returns SESSION_NOT_FOUND', async () => {
    respond(
      { ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) },
      {
        ok: false,
        status: 404,
        clone: () => ({ json: async () => ({ code: PAYMENT_ERROR_CODE.SESSION_NOT_FOUND }) }) as Response,
      },
    );

    renderCheckout();
    fireEvent.change(await screen.findByTestId('card-input'), { target: { value: '4111111111114000' } });
    fireEvent.click(screen.getByTestId('pay-button'));

    expect(await screen.findByTestId('checkout-error')).toHaveTextContent(MESSAGES.checkout.sessionExpired);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the invalid-card message when the backend returns INVALID_CARD_FORMAT', async () => {
    respond(
      { ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) },
      {
        ok: false,
        status: 400,
        clone: () => ({ json: async () => ({ code: PAYMENT_ERROR_CODE.INVALID_CARD_FORMAT }) }) as Response,
      },
    );

    renderCheckout();
    fireEvent.change(await screen.findByTestId('card-input'), { target: { value: '1234123412341234' } });
    fireEvent.click(screen.getByTestId('pay-button'));

    expect(await screen.findByTestId('checkout-error')).toHaveTextContent(MESSAGES.checkout.invalidCardFormat);
  });

  it('shows the already-processed message when the backend returns SESSION_ALREADY_PROCESSED', async () => {
    respond(
      { ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) },
      {
        ok: false,
        status: 400,
        clone: () => ({ json: async () => ({ code: PAYMENT_ERROR_CODE.SESSION_ALREADY_PROCESSED }) }) as Response,
      },
    );

    renderCheckout();
    fireEvent.change(await screen.findByTestId('card-input'), { target: { value: '4111111111114000' } });
    fireEvent.click(screen.getByTestId('pay-button'));

    expect(await screen.findByTestId('checkout-error')).toHaveTextContent(MESSAGES.checkout.sessionAlreadyProcessed);
  });

  it('shows the network message when the pay request throws', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ seatId: 'A1', amount: 10 }) } as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderCheckout();
    fireEvent.change(await screen.findByTestId('card-input'), { target: { value: '4111111111114000' } });
    fireEvent.click(screen.getByTestId('pay-button'));

    expect(await screen.findByTestId('checkout-error')).toHaveTextContent(MESSAGES.checkout.networkError);
  });

  it('navigates to /result?status=failed&delivered=1 for card ending 5000', async () => {
    respond(
      { ok: true, json: async () => ({ seatId: 'A2', amount: 10 }) },
      { ok: true, json: async () => ({ status: 'failed', webhookDelivered: true, deliveryId: 'd-3' }) },
    );

    renderCheckout();

    fireEvent.change(await screen.findByTestId('card-input'), {
      target: { value: '5000000000005000' },
    });
    fireEvent.click(screen.getByTestId('pay-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/result?status=failed&delivered=1&sessionId=sess_123');
    });
  });
});
