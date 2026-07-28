import { useEffect, useRef, useState } from 'react';
import { usd } from '../../lib/format.js';

/**
 * Count-up dollar figure (homepage odometer DNA). Tabular mono at the call site keeps
 * width stable while rolling. Reduced-motion or non-numeric input renders instantly.
 */
export function OdometerUsd({ value }: { value: string }) {
  const target = Number(value);
  const [display, setDisplay] = useState(() =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
      ? target
      : 0,
  );
  const done = useRef(false);

  useEffect(() => {
    if (done.current || Number.isNaN(target) || display === target) {
      setDisplay(target);
      return;
    }
    done.current = true;
    const t0 = performance.now();
    const DURATION = 650;
    let raf = 0;
    const tick = (t: number): void => {
      const p = Math.min(1, (t - t0) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]); // animate once per mount; `display` intentionally excluded

  if (Number.isNaN(target)) return <>{usd(value)}</>;
  return <>{usd(String(display))}</>;
}
