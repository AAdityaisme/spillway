import { monthLabel, recentMonths } from '../../lib/format.js';
import { Select } from './Select.js';

export interface MonthPickerProps {
  value: string;
  onChange: (period: string) => void;
  months?: number;
  id?: string;
}

/** Period dropdown for KPI/report headers — "YYYY-MM" values, 12 months back by default. */
export function MonthPicker({ value, onChange, months = 12, id }: MonthPickerProps) {
  const options = recentMonths(months).map((m) => ({ value: m, label: monthLabel(m) }));
  // A deep link can reference a month outside the window — keep it selectable.
  if (!options.some((o) => o.value === value)) {
    options.push({ value, label: monthLabel(value) });
  }
  return (
    <div className="w-44">
      <Select id={id} value={value} onValueChange={onChange} options={options} />
    </div>
  );
}
