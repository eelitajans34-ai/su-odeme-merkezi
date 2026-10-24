import React from 'react';
import { ScrollView } from 'react-native';
import { api, setToken } from '../api';
import { Button, Card, H, P, Screen } from '../ui';

export function HomeScreen({ navigation, onSignedOut }: { navigation: any; onSignedOut: () => void }) {
  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    await setToken(null);
    onSignedOut();
  }
  return (
    <Screen>
      <ScrollView>
        <Card>
          <H>Su Ödeme Merkezi</H>
          <P muted>Su kartı yükleme ve fatura ödeme. Ödeme, ödeme kuruluşunun güvenli sayfasında yapılır; kart bilgileriniz bu uygulamada saklanmaz.</P>
          <Button title="Aboneliklerim" onPress={() => navigation.navigate('Subscriptions')} />
          <Button title="Kart yükle" onPress={() => navigation.navigate('Topup')} />
          <Button title="İşlem geçmişi" onPress={() => navigation.navigate('Transactions')} />
          <Button title="Bildirimler" onPress={() => navigation.navigate('Notifications')} />
          <Button title="Çıkış yap" kind="secondary" onPress={logout} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
