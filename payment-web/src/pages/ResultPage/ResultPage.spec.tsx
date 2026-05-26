import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ResultPage } from './ResultPage';
import { MESSAGES } from '../../consts';

function renderResult(query: string) {
  return render(
    <MemoryRouter initialEntries={[`/result?${query}`]}>
      <Routes>
        <Route path="/result" element={<ResultPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResultPage', () => {
  it('shows success status with the confirmed detail when delivered=1', () => {
    renderResult('status=success&delivered=1');
    expect(screen.getByTestId('result-status')).toHaveTextContent('Successful');
    expect(screen.getByTestId('result-detail')).toHaveTextContent(MESSAGES.result.successDetail);
    expect(screen.queryByTestId('result-pending')).toBeNull();
  });

  it('shows success status with the pending-sync detail when delivered=0', () => {
    renderResult('status=success&delivered=0');
    expect(screen.getByTestId('result-status')).toHaveTextContent('Successful');
    expect(screen.getByTestId('result-detail')).toHaveTextContent(
      MESSAGES.result.successPendingDetail,
    );
    expect(screen.getByTestId('result-pending')).toBeInTheDocument();
  });

  it('shows failed status with the standard detail when delivered=1', () => {
    renderResult('status=failed&delivered=1');
    expect(screen.getByTestId('result-status')).toHaveTextContent('Failed');
    expect(screen.getByTestId('result-detail')).toHaveTextContent(MESSAGES.result.failedDetail);
    expect(screen.queryByTestId('result-pending')).toBeNull();
  });

  it('shows failed status with the pending-release detail when delivered=0', () => {
    renderResult('status=failed&delivered=0');
    expect(screen.getByTestId('result-status')).toHaveTextContent('Failed');
    expect(screen.getByTestId('result-detail')).toHaveTextContent(
      MESSAGES.result.failedPendingDetail,
    );
    expect(screen.getByTestId('result-pending')).toBeInTheDocument();
  });

  it('defaults to "delivered" when the param is absent (back-compat with bookmarked URLs)', () => {
    renderResult('status=success');
    expect(screen.getByTestId('result-detail')).toHaveTextContent(MESSAGES.result.successDetail);
    expect(screen.queryByTestId('result-pending')).toBeNull();
  });

  it('Back button points to reservation-web URL', () => {
    renderResult('status=success&delivered=1');
    const btn = screen.getByTestId('back-button');
    expect(btn).toHaveAttribute('href', 'http://localhost:3001');
  });

  describe('delivery polling', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('clears the pending banner once the backend reports terminalDelivered', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'DELIVERED', terminalDelivered: true }),
      } as Response);

      renderResult('status=success&delivered=0&sessionId=sess_1');
      expect(screen.getByTestId('result-pending')).toBeInTheDocument();

      // First tick at POLL_BASE_MS (1500ms); push a hair past it so the fetch
      // resolves and the state update flushes inside `act`.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('result-pending')).toBeNull();
      });
      expect(screen.getByTestId('result-detail')).toHaveTextContent(MESSAGES.result.successDetail);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('falls back to the exhausted banner if the backend reports FAILED delivery', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'FAILED', terminalDelivered: false }),
      } as Response);

      renderResult('status=success&delivered=0&sessionId=sess_1');
      // First tick at POLL_BASE_MS (1500ms); push a hair past it so the fetch
      // resolves and the state update flushes inside `act`.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      await waitFor(() => {
        expect(screen.getByTestId('result-pending-exhausted')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('result-pending')).toBeNull();
    });
  });
});
