import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { ScrollView } from 'react-native';
import { api, idempotencyKey, tl } from '../api';
import { Button, Card, ErrorText, Field, H, P, Row, Screen, useLoad } from '../ui';

type CardRow = { id: string; nickname: string | null; cardMasked: string; utilityName: string; subscriptionVerified: boolean; topupMethod: string };
type Quote = { amountMinor: number; feeMinor: number; totalMinor: number; isSampleTariff?: boolean; readiness: { ok: boolean; reasons?: string[] } };

/**
 * Kart yükleme. Tutar ve ücret sunucuda hesaplanır. Ödeme sağlayıcının sayfası sistem tarayıcısında açılır;
 * tarayıcı kapanınca sonuç YALNIZCA sunucudan sorgulanır (tarayıcı dönüşü başarı kanıtı sayılmaz).
 * Aynı işlem için tek idempotency anahtarı kullanılır; tekrar basmak yeni ödeme oluşturmaz.
 */
export function TopupScreen({ navigation }: { navigation: any }) {
  const cards = useLoad<CardRow[]>('/api/cards');
  const [cardId, setCardId] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [quote, setQuote] = React.useState<Quote | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const idem = React.useRef<string | null>(null);

  const amountMinor = Math.round(Number(amount.replace(',', '.')) * 100);

  async function getQuote() {
    setBusy(true); setError(null); setQuote(null); idem.current = null;
    try { setQuote(await api<Quote>('/api/topups/quote', { body: { waterCardId: cardId, amountMinor } })); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function pay() {
    if (!quote) return;
    idem.current ??= idempotencyKey();
    setBusy(true); setError(null);
    try {
      const r = await api<{ transaction: { id: string }; checkoutUrl: string | null }>('/api/topups', { body: { waterCardId: cardId, amountMinor: quote.amountMinor }, idempotencyKey: idem.current });
      if (r.checkoutUrl) await WebBrowser.openBrowserAsync(r.checkoutUrl);
      navigation.replace('TransactionDetail', { type: 'TOPUP', id: r.transaction.id });
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const usable = (cards.data ?? []).filter((c) => c.subscriptionVerified && c.topupMethod !== 'NOT_SUPPORTED');
  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Card>
          <H>Su kartı yükle</H>
          {usable.length === 0 && !cards.loading && <P muted>Yüklenebilir kartınız yok. Önce doğrulanmış bir abonelik ve kart ekleyin.</P>}
          {usable.map((c) => (
            <Button key={c.id} kind={c.id === cardId ? 'primary' : 'secondary'} title={`${c.nickname ?? c.cardMasked} · ${c.utilityName}`} onPress={() => { setCardId(c.id); setQuote(null); }} />
          ))}
          <Field label="Tutar (TL)" value={amount} onChangeText={(v) => { setAmount(v); setQuote(null); }} keyboardType="decimal-pad" />
          <ErrorText error={error ?? cards.error} />
          <Button title="Tutarı hesapla" onPress={getQuote} busy={busy && !quote} disabled={!cardId || !(amountMinor > 0)} />
        </Card>
        {quote && (
          <Card>
            <H>Ödeme özeti</H>
            <Row k="Yükleme tutarı" v={tl(quote.amountMinor)} />
            <Row k="Hizmet bedeli" v={tl(quote.feeMinor)} />
            <Row k="Toplam" v={tl(quote.totalMinor)} />
            {quote.isSampleTariff && <P muted>Hizmet bedeli örnek değerdir (test).</P>}
            {!quote.readiness.ok && <ErrorText error={new Error(`Şu anda işlem yapılamıyor: ${(quote.readiness.reasons ?? []).join(' ')}`)} />}
            <P muted>Ödemeniz onaylandıktan sonra yükleme su idaresine iletilir. Karta yükleme, su idaresinden onay gelene kadar "tamamlandı" olarak gösterilmez.</P>
            <Button title="Ödemeye geç" onPress={pay} busy={busy} disabled={!quote.readiness.ok} />
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
