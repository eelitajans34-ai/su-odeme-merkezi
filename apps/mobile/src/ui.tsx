import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { api } from './api';

export const colors = { primary: '#0b5fa5', text: '#14202b', muted: '#5b6b7a', bg: '#f4f7fa', card: '#ffffff', warn: '#8a5a00', warnBg: '#fff4d6', err: '#a3261b', errBg: '#fde7e5', ok: '#1d6b35' };

export function Screen({ children }: { children: React.ReactNode }) {
  return <View style={s.screen}><TestModeBanner />{children}</View>;
}

/** Sunucu TEST modundaysa her ekranda açık uyarı gösterilir. */
export function TestModeBanner() {
  const [notice, setNotice] = React.useState<string | null>(null);
  React.useEffect(() => {
    api<{ environmentNotice: string | null }>('/api/platform/status').then((r) => setNotice(r.environmentNotice)).catch(() => undefined);
  }, []);
  if (!notice) return null;
  return <View style={s.warn}><Text style={s.warnText}>{notice}</Text></View>;
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}
export function H({ children }: { children: React.ReactNode }) {
  return <Text style={s.h} accessibilityRole="header">{children}</Text>;
}
export function P({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={[s.p, muted && { color: colors.muted }]}>{children}</Text>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={s.input} placeholderTextColor={colors.muted} {...props} />
    </View>
  );
}
export function Button({ title, onPress, disabled, busy, kind = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean; kind?: 'primary' | 'secondary' }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || busy }} disabled={disabled || busy} onPress={onPress}
      style={[s.btn, kind === 'secondary' && s.btnSecondary, (disabled || busy) && { opacity: 0.5 }]}>
      {busy ? <ActivityIndicator color={kind === 'primary' ? '#fff' : colors.primary} /> : <Text style={[s.btnText, kind === 'secondary' && { color: colors.primary }]}>{title}</Text>}
    </Pressable>
  );
}
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <View style={s.err}><Text style={{ color: colors.err }} accessibilityLiveRegion="polite">{msg}</Text></View>;
}
export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <View style={s.row}><Text style={{ color: colors.muted }}>{k}</Text><Text style={{ color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{v}</Text></View>;
}

export function useLoad<T>(path: string) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setData(await api<T>(path)); } catch (e) { setError(e); } finally { setLoading(false); }
  }, [path]);
  React.useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

export const dt = (iso?: string) => (iso ? new Date(iso).toLocaleString('tr-TR') : '—');

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  warn: { backgroundColor: colors.warnBg, padding: 10 },
  warnText: { color: colors.warn, fontWeight: '700', textAlign: 'center' },
  card: { backgroundColor: colors.card, borderRadius: 10, padding: 16, margin: 12, marginBottom: 0 },
  h: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 8 },
  p: { fontSize: 15, color: colors.text, marginBottom: 8, lineHeight: 21 },
  label: { fontSize: 14, color: colors.text, marginBottom: 4, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#c5d0da', borderRadius: 8, padding: 12, fontSize: 16, color: colors.text, backgroundColor: '#fff' },
  btn: { backgroundColor: colors.primary, borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 4, minHeight: 48, justifyContent: 'center' },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  err: { backgroundColor: colors.errBg, padding: 10, borderRadius: 8, marginVertical: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
});
