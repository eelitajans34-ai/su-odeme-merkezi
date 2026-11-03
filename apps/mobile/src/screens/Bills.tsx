import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Linking, ScrollView, Share, Text, View } from 'react-native';
import { api, idempotencyKey, tl } from '../api';
import { Button, Card, ErrorText, H, P, Row, Screen, colors, useLoad } from '../ui';

type Sub = { id: string; utilityName: string; subscriberMasked: string; nickname: string | null; verificationStatus: string };
type Bill = { billId: string; period: string; dueDate: string; amountMinor: number };
type Method = { method: 'HOSTED_CARD' | 'QR' | 'NFC'; label: string; help: string; status: string; statusLabel: string; isSimulator: boolean };
type PayResult = { transaction: { id: string; isTest: boolean }; method: Method['method']; checkoutUrl: string | null; qr: { payload: string; expiresAt: string } | null; nfc: { sessionToken: string; sdk: string } | null };

/**
 * Fatura sorgula ve öde. Yöntemler sunucudan gerçek durumlarıyla gelir (Kurulum bekleniyor / Test modu).
 * Hiçbir yöntemde sonuç uygulamada belirlenmez: ödeme sağlayıcının imzalı bildirimiyle, fatura ise su idaresi teyidiyle kesinleşir.
 */
export function BillsScreen({ navigation }: { navigation: any }) {
  const subs = useLoad<Sub[]>('/api/subscriptions');
  const [subId, setSubId] = React.useState('');
  const [inq, setInq] = React.useState<{ id: string; status: string; statusText: string; errorMessage: string | null; bills: Bill[] } | null>(null);
  const [quote, setQuote] = React.useState<{ amountMinor: number; feeMinor: number; totalMinor: number; feeDescription: string } | null>(null);
  const [methods, setMethods] = React.useState<Method[]>([]);
  const [method, setMethod] = React.useState<Method['method'] | null>(null);
  const [nfc, setNfc] = React.useState<{ txId: string; sessionToken: string; sdk: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const inquire = () => run(async () => {
    setQuote(null); setNfc(null);
    setInq(await api('/api/bill-payments/inquiries', { body: { subscriptionId: subId }, idempotencyKey: idempotencyKey() }));
    const m = await api<Method[]>(`/api/payment-methods?kind=BILL_PAYMENT&subscriptionId=${subId}`);
    setMethods(m);
    setMethod(m.find((x) => x.status === 'AVAILABLE')?.method ?? null);
  });
  const billIds = () => (inq?.bills ?? []).map((b) => b.billId);
  const getQuote = () => run(async () => { setQuote(await api(`/api/bill-payments/${inq!.id}/quote`, { body: { billIds: billIds() } })); });
  const pay = () => run(async () => {
    const r = await api<PayResult>(`/api/bill-payments/${inq!.id}/pay`, { body: { billIds: billIds(), paymentMethod: method } });
    if (r.method === 'HOSTED_CARD' && r.checkoutUrl) {
      await WebBrowser.openBrowserAsync(r.checkoutUrl);
      navigation.replace('TransactionDetail', { type: 'BILL', id: r.transaction.id });
    } else if (r.method === 'QR' && r.qr) {
      // Aynı telefonda karekodu okutmak mümkün olmadığından içerik banka uygulamasına iletilir veya paylaşılır
      navigation.replace('QrPayment', { txId: r.transaction.id, payload: r.qr.payload, expiresAt: r.qr.expiresAt, isTest: r.transaction.isTest });
    } else if (r.method === 'NFC' && r.nfc) {
      setNfc({ txId: r.transaction.id, ...r.nfc });
    }
  });
  const tap = (outcome: 'SUCCEEDED' | 'FAILED') => run(async () => {
    await api(`/api/sandbox/nfc/${encodeURIComponent(nfc!.sessionToken)}/tap`, { body: { outcome } });
    navigation.replace('TransactionDetail', { type: 'BILL', id: nfc!.txId });
  });

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Card>
          <H>Fatura sorgula ve öde</H>
          {(subs.data ?? []).map((s) => (
            <Button key={s.id} kind={s.id === subId ? 'primary' : 'secondary'} disabled={s.verificationStatus !== 'VERIFIED'}
              title={`${s.nickname ?? s.subscriberMasked} · ${s.utilityName}${s.verificationStatus !== 'VERIFIED' ? ' (doğrulanmadı)' : ''}`} onPress={() => { setSubId(s.id); setInq(null); setQuote(null); }} />
          ))}
          <ErrorText error={error ?? subs.error} />
          <Button title="Borç sorgula" onPress={inquire} busy={busy && !inq} disabled={!subId} />
        </Card>
        {inq && (
          <Card>
            {inq.status !== 'BILL_FOUND' ? <P>{inq.errorMessage ?? inq.statusText}</P> : (
              <>
                {inq.bills.map((b) => <Row key={b.billId} k={`${b.period} · son ödeme ${b.dueDate}`} v={tl(b.amountMinor)} />)}
                {!quote && <Button title="Toplamı hesapla" kind="secondary" onPress={getQuote} busy={busy} />}
              </>
            )}
          </Card>
        )}
        {quote && !nfc && (
          <Card>
            <H>Ödeme</H>
            <Row k="Fatura tutarı" v={tl(quote.amountMinor)} />
            <Row k="Hizmet bedeli" v={tl(quote.feeMinor)} />
            <Row k="Toplam" v={tl(quote.totalMinor)} />
            <P muted>{quote.feeDescription}</P>
            <Text style={{ fontWeight: '700', marginVertical: 8 }}>Ödeme yöntemi</Text>
            {methods.map((m) => (
              <View key={m.method} style={{ marginBottom: 8 }}>
                <Button title={m.label} kind={m.method === method ? 'primary' : 'secondary'} disabled={m.status !== 'AVAILABLE'} onPress={() => setMethod(m.method)} />
                <Text style={{ color: m.status === 'AVAILABLE' ? colors.muted : colors.warn, marginTop: 4 }}>{m.statusLabel}</Text>
              </View>
            ))}
            <P muted>Fatura, su idaresi tahsilatı teyit ettikten sonra "ödendi" olarak gösterilir.</P>
            <Button title={method === 'QR' ? 'Karekodu oluştur' : method === 'NFC' ? 'Temassız ödemeyi başlat' : 'Ödemeye geç'} onPress={pay} busy={busy} disabled={!method} />
          </Card>
        )}
        {nfc && (
          <Card>
            <H>Temassız (NFC) ödeme</H>
            {nfc.sdk === 'SANDBOX' ? (
              <>
                <ErrorText error={new Error('TEST — Gerçek kart okunmaz. Kart okuma adımı simüle edilir; para hareketi yoktur.')} />
                <P>Gerçek sistemde bu adımda kartınızı telefonunuzun arkasına yaklaştırırsınız; okuma ödeme kuruluşunun uygulama içi bileşeniyle yapılır.</P>
                <Button title="Kart okutuldu (başarılı simülasyon)" onPress={() => tap('SUCCEEDED')} busy={busy} />
                <Button title="Kart reddedildi (başarısız simülasyon)" kind="secondary" onPress={() => tap('FAILED')} busy={busy} />
              </>
            ) : (
              // Gerçek sağlayıcının NFC SDK'sı bu sürümde uygulamaya eklenmedi; ödeme başlatılmış sayılmaz
              <P>Bu ödeme kuruluşunun temassız ödeme bileşeni uygulamaya henüz eklenmedi (Kurulum bekleniyor). Hesabınızdan tahsilat yapılmadı; lütfen başka bir yöntem seçin.</P>
            )}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

export function QrPaymentScreen({ route, navigation }: { route: any; navigation: any }) {
  const { txId, payload, expiresAt, isTest } = route.params as { txId: string; payload: string; expiresAt: string; isTest: boolean };
  const [left, setLeft] = React.useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));
  React.useEffect(() => {
    const tick = setInterval(() => setLeft(Math.max(0, new Date(expiresAt).getTime() - Date.now())), 1000);
    const poll = setInterval(async () => {
      const t = await api<{ status: string }>(`/api/bill-payments/${txId}/refresh`, { method: 'POST', body: {} }).catch(() => null);
      if (t && t.status !== 'AWAITING_PAYMENT') navigation.replace('TransactionDetail', { type: 'BILL', id: txId });
    }, 4000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [txId, expiresAt, navigation]);
  return (
    <Screen>
      <ScrollView>
        <Card>
          <H>QR ile ödeme</H>
          {isTest && <ErrorText error={new Error('TEST karekodu — gerçek ödeme için kullanılamaz; açıldığında ödeme simülatörü gelir.')} />}
          {left > 0 ? (
            <>
              <P>Karekodu banka veya cüzdan uygulamanızda açın ya da başka bir cihaza gönderip okutun. Kalan süre: {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}</P>
              <Button title="Ödeme uygulamasında aç" onPress={() => Linking.openURL(payload).catch(() => undefined)} />
              <Button title="Karekod içeriğini paylaş" kind="secondary" onPress={() => Share.share({ message: payload })} />
              <P muted>Ödeme onaylandığında bu ekran kendiliğinden güncellenir.</P>
            </>
          ) : (
            <P>Karekodun süresi doldu. Ödeme yapmadıysanız hesabınızdan tahsilat yapılmamıştır; faturayı yeniden sorgulayın.</P>
          )}
          <Button title="İşlem durumunu gör" kind="secondary" onPress={() => navigation.replace('TransactionDetail', { type: 'BILL', id: txId })} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
