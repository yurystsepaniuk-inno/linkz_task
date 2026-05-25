import { MESSAGES } from '../../consts';

interface SeatsActionsProps {
  canBook: boolean;
  loading: boolean;
  onBook: VoidFunction;
  onRefresh: VoidFunction;
}

export function SeatsActions({ canBook, loading, onBook, onRefresh }: SeatsActionsProps) {
  return (
    <div className="actions">
      <button
        className="button button--lg"
        onClick={onBook}
        disabled={!canBook || loading}
        data-testid="book-button"
      >
        {loading ? MESSAGES.seats.booking : MESSAGES.seats.book}
      </button>
      <button
        className="button button--lg"
        onClick={onRefresh}
        data-testid="refresh-button"
      >
        {MESSAGES.seats.refresh}
      </button>
    </div>
  );
}
