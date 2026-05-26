import { useMemo } from 'react';
import { ENDPOINTS } from '../consts';
import type { Seat } from '../types';
import { useApiClient } from './apiClient';

export interface SeatsService {
  list: () => Promise<Seat[]>;
  reserve: (seatId: string) => Promise<{ checkoutUrl: string }>;
}

export function useSeatsService(): SeatsService {
  const api = useApiClient();

  return useMemo<SeatsService>(
    () => ({
      list: async () => {
        const res = await api.get<Seat[]>(ENDPOINTS.SEATS);
        return res.data;
      },
      reserve: async (seatId) => {
        const res = await api.post<{ checkoutUrl: string }>(ENDPOINTS.RESERVATIONS, { seatId });
        return res.data;
      },
    }),
    [api],
  );
}
