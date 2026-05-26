import { UserButton } from '@clerk/clerk-react';
import { MESSAGES } from '../../consts';
import { SeatsActions, SeatsGrid, Toast } from '../../components';
import { useSeats } from '../../hooks';

export function SeatsPage() {
  const { seats, selectedId, canBook, loading, toast, clearToast, selectSeat, refresh, book } =
    useSeats();

  return (
    <div className="page page--medium">
      <div className="page-header">
        <h1>{MESSAGES.seats.title}</h1>
        <UserButton />
      </div>

      <SeatsGrid seats={seats} selectedId={selectedId} onSelect={selectSeat} />

      <SeatsActions canBook={canBook} loading={loading} onBook={book} onRefresh={refresh} />

      {toast && <Toast message={toast} onClose={clearToast} />}
    </div>
  );
}
