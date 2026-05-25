import { useCallback, useState } from 'react';

interface UseToast {
  toast: string | null;
  show: (message: string) => void;
  clear: VoidFunction;
}

export function useToast(): UseToast {
  const [toast, setToast] = useState<string | null>(null);
  const show = useCallback((message: string) => setToast(message), []);
  const clear = useCallback(() => setToast(null), []);
  return { toast, show, clear };
}
