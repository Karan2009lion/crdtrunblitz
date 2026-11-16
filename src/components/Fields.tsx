import { useId } from 'react';

export function Stepper({ label, value, onChange, min, max, hint }: { label: string; value: number; onChange(v: number): void; min: number; max: number; hint?: string }) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap stepper">
        <button type="button" onClick={() => onChange(clamp(value - 1))} aria-label={`Decrease ${label}`} disabled={value <= min}>
          −
        </button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          onChange={(e) => e.target.value !== '' && onChange(clamp(Number(e.target.value)))}
        />
        <button type="button" onClick={() => onChange(clamp(value + 1))} aria-label={`Increase ${label}`} disabled={value >= max}>
          +
        </button>
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
