import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import Toast from '../components/Toast';
import { isAxiosError } from 'axios';
import { SEAT_STATUS, SeatStatus } from '../constants';
import { MESSAGES } from '../messages';

interface Seat {
  id: string;
  status: SeatStatus;
}

function seatClassName(seat: Seat, selectedId: string | null): string {
  if (seat.id === selectedId && seat.status === SEAT_STATUS.AVAILABLE) {
    return 'seat seat--selected';
  }
  if (seat.status === SEAT_STATUS.AVAILABLE) return 'seat seat--available';
  return 'seat seat--occupied';
}

export default function SeatsPage() {
  const { logout } = useAuth();
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSeats = useCallback(async () => {
    try {
      const res = await api.get<Seat[]>('/api/seats');
      setSeats(res.data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 401) return;
      setToast(MESSAGES.seats.loadFailed);
    }
  }, []);

  useEffect(() => { fetchSeats(); }, [fetchSeats]);

  function handleSelect(seat: Seat) {
    if (seat.status !== SEAT_STATUS.AVAILABLE) return;
    setSelectedId((prev) => (prev === seat.id ? null : seat.id));
  }

  async function handleBook() {
    if (!selectedId) return;
    setLoading(true);
    try {
      const res = await api.post<{ checkoutUrl: string }>('/api/reservations', { seatId: selectedId });
      window.location.assign(res.data.checkoutUrl);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setToast(MESSAGES.seats.seatTaken);
      } else {
        setToast(MESSAGES.seats.bookingFailed);
      }
      setSelectedId(null);
      await fetchSeats();
    } finally {
      setLoading(false);
    }
  }

  const selectedSeat = seats.find((s) => s.id === selectedId);
  const canBook = !!selectedSeat && selectedSeat.status === SEAT_STATUS.AVAILABLE;

  return (
    <div className="page page--medium">
      <div className="page-header">
        <h1>{MESSAGES.seats.title}</h1>
        <button className="button" onClick={logout}>{MESSAGES.seats.logout}</button>
      </div>

      <div className="seats">
        {seats.map((seat) => (
          <div
            key={seat.id}
            data-testid={`seat-${seat.id}`}
            className={seatClassName(seat, selectedId)}
            onClick={() => handleSelect(seat)}
          >
            {seat.id}
          </div>
        ))}
      </div>

      <div className="actions">
        <button
          className="button button--lg"
          onClick={handleBook}
          disabled={!canBook || loading}
          data-testid="book-button"
        >
          {loading ? MESSAGES.seats.booking : MESSAGES.seats.book}
        </button>
        <button
          className="button button--lg"
          onClick={fetchSeats}
          data-testid="refresh-button"
        >
          {MESSAGES.seats.refresh}
        </button>
      </div>

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
