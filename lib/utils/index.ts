import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatINR(val: number | string | undefined | null): string {
  if (val === undefined || val === null || isNaN(Number(val))) return '₹0.00';
  const num = Number(val);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(num);
}

export function formatNumber(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val)) return '0';
  return new Intl.NumberFormat('en-IN').format(val);
}

export function formatUSDT(val: number | string | undefined | null): string {
  if (val === undefined || val === null || isNaN(Number(val))) return '$0.00 USDT';
  const num = Number(val);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(num) + ' USDT';
}

export function formatCurrency(val: number | string | undefined | null, currency: string = 'INR'): string {
  if (currency === 'USDT' || currency === 'USD') return formatUSDT(val);
  return formatINR(val);
}

export function formatPercent(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val)) return '0.00%';
  const prefix = val > 0 ? '+' : '';
  return prefix + val.toFixed(2) + '%';
}
