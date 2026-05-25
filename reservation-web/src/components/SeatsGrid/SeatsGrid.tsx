import { seatClassName } from '../../helpers';
import type { Seat } from '../../types';

interface SeatsGridProps {
  seats: Seat[];
  selectedId: string | null;
  onSelect: (seat: Seat) => void;
}

export function SeatsGrid({ seats, selectedId, onSelect }: SeatsGridProps) {
  return (
    <div className="seats">
      {seats.map((seat) => (
        <div
          key={seat.id}
          data-testid={`seat-${seat.id}`}
          className={seatClassName(seat, selectedId)}
          onClick={() => onSelect(seat)}
        >
          {seat.id}
        </div>
      ))}
    </div>
  );
}
