import { useEffect, useState } from 'react';

// the time, again every few seconds, for "12s ago" labels
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
