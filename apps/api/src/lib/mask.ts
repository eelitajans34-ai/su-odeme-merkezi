/** Hassas numaraları ekranda maskeler: yalnızca son 4 karakter görünür. */
export function maskTail(value: string | null | undefined, visible = 4): string {
  if (!value) return '';
  const v = value.trim();
  if (v.length <= visible) return '•'.repeat(v.length);
  return '•'.repeat(Math.min(v.length - visible, 8)) + v.slice(-visible);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '•••';
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

export function maskSecretHint(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}
