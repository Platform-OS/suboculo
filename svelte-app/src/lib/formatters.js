export function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

export function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMoney(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `$${Number(value).toFixed(4)}`;
}

export function formatSignedPercentDelta(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatSignedNumberDelta(value, precision = 0) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(precision)}`;
}

export function formatPeriodRange(period) {
  if (!period?.from || !period?.to) return "—";
  const from = new Date(period.from);
  const to = new Date(period.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return `${period.from} → ${period.to}`;
  }
  return `${from.toLocaleDateString()} → ${to.toLocaleDateString()}`;
}
