/**
 * Normalise a typed phone number to E.164 (+15551234567) for an sms: link.
 * Numbers without a country code are taken as US/Canada. Returns null if it doesn't look valid.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** "•••1234": enough for someone to recognise their own number on a shared screen. */
export const maskPhone = (e164: string) => `•••${e164.slice(-4)}`;
