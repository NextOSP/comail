import { useEffect, useState } from "react";

/** Current time, re-read every `intervalMs` (aligned to the next tick) so
 *  now-lines and past-event fading keep moving while the view stays open. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(
      () => {
        setNow(Date.now());
        interval = setInterval(() => setNow(Date.now()), intervalMs);
      },
      intervalMs - (Date.now() % intervalMs),
    );
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [intervalMs]);
  return now;
}
