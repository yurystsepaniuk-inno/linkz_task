import { useCallback, useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import { MESSAGES, SEAT_STATUS } from '../consts';
import { useSeatsService } from '../services';
import type { Seat } from '../types';
import { useToast } from './useToast';

interface UseSeats {
  seats: Seat[];
  selectedId: string | null;
  selectedSeat: Seat | undefined;
  canBook: boolean;
  loading: boolean;
  toast: string | null;
  clearToast: VoidFunction;
  selectSeat: (seat: Seat) => void;
  refresh: () => Promise<void>;
  book: () => Promise<void>;
}

export function useSeats(): UseSeats {
  const service = useSeatsService();
  const { toast, show: showToast, clear: clearToast } = useToast();

  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSeats(await service.list());
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 401) return;
      showToast(MESSAGES.seats.loadFailed);
    }
  }, [service, showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectSeat = useCallback((seat: Seat) => {
    if (seat.status !== SEAT_STATUS.AVAILABLE) return;
    setSelectedId((prev) => (prev === seat.id ? null : seat.id));
  }, []);

  const book = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    try {
      const { checkoutUrl } = await service.reserve(selectedId);
      window.location.assign(checkoutUrl);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        showToast(MESSAGES.seats.seatTaken);
      } else {
        showToast(MESSAGES.seats.bookingFailed);
      }
      setSelectedId(null);
      await refresh();
    } finally {
      setLoading(false);
    }
  }, [selectedId, service, showToast, refresh]);

  const selectedSeat = seats.find((s) => s.id === selectedId);
  const canBook = !!selectedSeat && selectedSeat.status === SEAT_STATUS.AVAILABLE;

  return {
    seats,
    selectedId,
    selectedSeat,
    canBook,
    loading,
    toast,
    clearToast,
    selectSeat,
    refresh,
    book,
  };
}
