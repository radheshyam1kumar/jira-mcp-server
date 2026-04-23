export function formatUsd(n: number): string {
  const x = Number(n)
  if (!Number.isFinite(x)) return '$0.00'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(x)
}

export function formatTokens(n: number): string {
  const x = Math.floor(Number(n))
  if (!Number.isFinite(x)) return '0'
  return x.toLocaleString()
}
