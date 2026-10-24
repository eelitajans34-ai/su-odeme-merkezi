import React from 'react';
import { FlatList, Pressable, Share, ScrollView, Text } from 'react-native';
import { api, tl } from '../api';
import { Button, Card, ErrorText, H, P, Row, Screen, dt, useLoad } from '../ui';

type Tx = { id: string; type: 'TOPUP' | 'BILL'; ref: string; totalMinor: number; status: string; statusText: string; createdAt: string; isTest: boolean };

export function TransactionsScreen({ navigation }: { navigation: any }) {
  const tx = useLoad<Tx[]>('/api/transactions');
  return (
    <Screen>
      <FlatList
        data={tx.data ?? []}
        keyExtractor={(x) => x.id}
        refreshing={tx.loading}
        onRefresh={tx.reload}
        ListHeaderComponent={<ErrorText error={tx.error} />}
        ListEmptyComponent={!tx.loading ? <Card><P>Henüz işleminiz yok.</P></Card> : null}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate('TransactionDetail', { type: item.type, id: item.id })}>
            <Card>
              <Text style={{ fontWeight: '700' }}>{item.type === 'TOPUP' ? 'Kart yükleme' : 'Fatura'} · {tl(item.totalMinor)}{item.isTest ? ' · TEST' : ''}</Text>
              <P muted>{item.ref} · {dt(item.createdAt)}</P>
              <P>{item.statusText}</P>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}

/** İşlem durumu her zaman sunucudan okunur; "Durumu güncelle" sunucunun sağlayıcıya sormasını tetikler. */
export function TransactionDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const { type, id } = route.params as { type: 'TOPUP' | 'BILL'; id: string };
  const base = type === 'TOPUP' ? `/api/topups/${id}` : `/api/bill-payments/${id}`;
  const t = useLoad<any>(base);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  async function refresh() {
    setBusy(true); setError(null);
    try { await api(`${base}/refresh`, { method: 'POST', body: {} }); await t.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const d = t.data;
  return (
    <Screen>
      <ScrollView>
        <Card>
          <H>{type === 'TOPUP' ? 'Kart yükleme' : 'Fatura ödemesi'}</H>
          <ErrorText error={error ?? t.error} />
          {d && (
            <>
              <P>{d.statusText}</P>
              <Row k="İşlem no" v={d.ref ?? d.publicRef} />
              <Row k="Tutar" v={tl(d.amountMinor)} />
              <Row k="Hizmet bedeli" v={tl(d.feeMinor)} />
              <Row k="Toplam" v={tl(d.totalMinor)} />
              <Row k="Oluşturulma" v={dt(d.createdAt)} />
              <Button title="Durumu güncelle" kind="secondary" onPress={refresh} busy={busy} />
              {d.receiptId && <Button title="Makbuzu görüntüle" onPress={() => navigation.navigate('Receipt', { id: d.receiptId })} />}
            </>
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}

export function ReceiptScreen({ route }: { route: any }) {
  const r = useLoad<any>(`/api/receipts/${route.params.id}`);
  const c = r.data?.content;
  async function share() {
    await Share.share({ message: `${c.baslik}\nMakbuz no: ${r.data.receipt_no}\nİşlem no: ${c.islemNo}\nToplam: ${tl(c.toplamKurus)}` });
  }
  return (
    <Screen>
      <ScrollView>
        <Card>
          <ErrorText error={r.error} />
          {c && (
            <>
              {c.ortamUyarisi && <ErrorText error={new Error(c.ortamUyarisi)} />}
              <H>{c.baslik}</H>
              <Row k="Makbuz no" v={r.data.receipt_no} />
              <Row k="İşlem no" v={c.islemNo} />
              <Row k="Su idaresi" v={c.suIdaresi} />
              <Row k="Abone no" v={c.aboneNo} />
              {c.kartNo && <Row k="Kart" v={c.kartNo} />}
              <Row k="Tutar" v={tl(c.tutarKurus)} />
              <Row k="Hizmet bedeli" v={tl(c.hizmetBedeliKurus)} />
              <Row k="Toplam" v={tl(c.toplamKurus)} />
              <Button title="Paylaş" kind="secondary" onPress={share} />
            </>
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}
