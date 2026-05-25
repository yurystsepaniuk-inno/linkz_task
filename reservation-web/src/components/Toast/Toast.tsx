import { useEffect } from 'react';

interface ToastProps {
  message: string;
  onClose: VoidFunction;
}

export function Toast({ message, onClose }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="toast" data-testid="toast">
      {message}
    </div>
  );
}
