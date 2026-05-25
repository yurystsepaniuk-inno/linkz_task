import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SeatsPage } from './SeatsPage';

// Clerk's <UserButton> renders an authenticated avatar widget; stub it so the
// test stays focused on seat-booking behaviour.
vi.mock('@clerk/clerk-react', () => ({
  UserButton: () => <div data-testid="user-button" />,
}));

const mockList = vi.fn();
const mockReserve = vi.fn();
// Stable instance so useSeats' useCallback([service]) doesn't recreate
// refresh every render and re-trigger the useEffect.
const mockService = {
  list: (...args: unknown[]) => mockList(...args),
  reserve: (...args: unknown[]) => mockReserve(...args),
};
// Mock the domain service rather than the underlying axios client — that's
// the boundary the page interacts with via the useSeats hook.
vi.mock('../../services', () => ({
  useSeatsService: () => mockService,
}));

const SEATS = [
  { id: 'A1', status: 'AVAILABLE' },
  { id: 'A2', status: 'PENDING_PAYMENT' },
  { id: 'A3', status: 'CONFIRMED' },
];

function renderSeats() {
  return render(<SeatsPage />);
}

describe('SeatsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue(SEATS);
  });

  it('renders 3 seat boxes', async () => {
    renderSeats();
    await waitFor(() => {
      expect(screen.getByTestId('seat-A1')).toBeInTheDocument();
      expect(screen.getByTestId('seat-A2')).toBeInTheDocument();
      expect(screen.getByTestId('seat-A3')).toBeInTheDocument();
    });
  });

  it('Book button is disabled initially', async () => {
    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A1'));
    expect(screen.getByTestId('book-button')).toBeDisabled();
  });

  it('selecting an AVAILABLE seat enables Book button', async () => {
    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('seat-A1'));
    expect(screen.getByTestId('book-button')).not.toBeDisabled();
  });

  it('clicking occupied seat does not enable Book button', async () => {
    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A2'));
    fireEvent.click(screen.getByTestId('seat-A2'));
    expect(screen.getByTestId('book-button')).toBeDisabled();
  });

  it('Book on 201 calls window.location.assign with checkoutUrl', async () => {
    const assignFn = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: assignFn },
      writable: true,
    });
    mockReserve.mockResolvedValueOnce({ checkoutUrl: 'http://localhost:3002/checkout/sess_1' });

    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('book-button'));

    await waitFor(() => {
      expect(assignFn).toHaveBeenCalledWith('http://localhost:3002/checkout/sess_1');
    });
  });

  it('Book on 409 shows toast and refetches seats', async () => {
    const err = Object.assign(new Error('Conflict'), {
      isAxiosError: true,
      response: { status: 409 },
    });
    mockReserve.mockRejectedValueOnce(err);

    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('book-button'));

    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('Book on non-409 error shows a generic toast and refetches', async () => {
    const err = Object.assign(new Error('Server error'), {
      isAxiosError: true,
      response: { status: 502 },
    });
    mockReserve.mockRejectedValueOnce(err);

    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('book-button'));

    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('fetchSeats failure shows a toast', async () => {
    mockList.mockReset();
    mockList.mockRejectedValueOnce(
      Object.assign(new Error('Server error'), {
        isAxiosError: true,
        response: { status: 500 },
      }),
    );

    renderSeats();
    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument();
    });
  });

  it('Refresh button refetches seats', async () => {
    renderSeats();
    await waitFor(() => screen.getByTestId('seat-A1'));
    fireEvent.click(screen.getByTestId('refresh-button'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });
});
