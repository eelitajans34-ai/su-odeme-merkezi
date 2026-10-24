import { CameraView, useCameraPermissions } from 'expo-camera';
import React from 'react';
import { FlatList, Text, View } from 'react-native';
import { api } from '../api';
import { Button, Card, ErrorText, Field, H, P, Screen, useLoad } from '../ui';

type Sub = { id: string; utilityName: string; subscriberMasked: string; nickname: string | null; verificationStatus: string };
const VERIFY_TEXT: Record<string, string> = { VERIFIED: 'Su idaresince doğrulandı', INTEGRATION_PENDING: 'Entegrasyon bekleniyor — doğrulanamadı' };
type Utility = { id: string; name: string; statusLabel: string };

/**
 * Abonelikler. QR okuma isteğe bağlıdır: kamera izni yalnızca kullanıcı "QR ile ekle"ye
 * dokunduğunda istenir; izin verilmezse elle giriş her zaman kullanılabilir.
 * QR içeriği sunucuda doğrulanır; uygulama içerikten hiçbir sonuç çıkarmaz.
 */
export function SubscriptionsScreen() {
  const subs = useLoad<Sub[]>('/api/subscriptions');
  const utils = useLoad<Utility[]>('/api/utilities');
  const [utilityId, setUtilityId] = React.useState('');
  const [subscriberNo, setSubscriberNo] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const handled = React.useRef(false);

  async function add() {
    setBusy(true); setError(null);
    try {
      await api('/api/subscriptions', { body: { utilityId, subscriberNo: subscriberNo.trim() } });
      setSubscriberNo('');
      subs.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function startScan() {
    setError(null);
    const p = permission?.granted ? permission : await requestPermission();
    if (!p.granted) { setError(new Error('Kamera izni verilmedi. Abone numaranızı elle girebilirsiniz.')); return; }
    handled.current = false;
    setScanning(true);
  }
  async function onScanned(payload: string) {
    if (handled.current) return;
    handled.current = true;
    setScanning(false);
    try { await api('/api/subscriptions/qr', { body: { payload } }); subs.reload(); } catch (e) { setError(e); }
  }

  if (scanning) {
    return (
      <View style={{ flex: 1 }}>
        <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => onScanned(r.data)} />
        <View style={{ padding: 12 }}><Button title="Vazgeç" kind="secondary" onPress={() => setScanning(false)} /></View>
      </View>
    );
  }

  return (
    <Screen>
      <FlatList
        data={subs.data ?? []}
        keyExtractor={(x) => x.id}
        refreshing={subs.loading}
        onRefresh={subs.reload}
        ListHeaderComponent={
          <Card>
            <H>Abonelik ekle</H>
            <Text style={{ marginBottom: 4, fontWeight: '600' }}>Su idaresi</Text>
            {utils.data?.map((u) => (
              <Button key={u.id} kind={u.id === utilityId ? 'primary' : 'secondary'} title={`${u.name} — ${u.statusLabel}`} onPress={() => setUtilityId(u.id)} />
            ))}
            {utils.data?.length === 0 && <P muted>Henüz tanımlı su idaresi yok (Kurulum bekleniyor).</P>}
            <Field label="Abone numarası" value={subscriberNo} onChangeText={setSubscriberNo} autoCapitalize="characters" />
            <ErrorText error={error ?? subs.error} />
            <Button title="Ekle" onPress={add} busy={busy} disabled={!utilityId || !subscriberNo} />
            <Button title="QR ile ekle" kind="secondary" onPress={startScan} />
          </Card>
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={{ fontWeight: '700' }}>{item.nickname ?? item.subscriberMasked}</Text>
            <P muted>{item.utilityName} · {VERIFY_TEXT[item.verificationStatus] ?? item.verificationStatus}</P>
          </Card>
        )}
        ListEmptyComponent={!subs.loading ? <Card><P>Kayıtlı aboneliğiniz yok.</P></Card> : null}
      />
    </Screen>
  );
}
