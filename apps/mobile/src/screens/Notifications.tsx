import * as Notifications from 'expo-notifications';
import React from 'react';
import { FlatList, Platform, Text } from 'react-native';
import { api } from '../api';
import { Button, Card, ErrorText, P, Screen, dt, useLoad } from '../ui';

type N = { id: string; title: string; body: string; created_at: string; read_at: string | null };

/**
 * Uygulama içi bildirimler her zaman listelenir. Anlık bildirim izni yalnızca kullanıcı
 * "Anlık bildirimleri aç"a dokunduğunda istenir. Sunucuda push sağlayıcısı kurulmamışsa
 * gönderim yapılmaz ve bu durum yönetim panelinde "Kurulum bekleniyor" olarak görünür.
 */
export function NotificationsScreen() {
  const list = useLoad<N[]>('/api/notifications');
  const [info, setInfo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  async function enablePush() {
    setError(null); setInfo(null);
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') { setInfo('Bildirim izni verilmedi. Bildirimleriniz uygulama içinde görünmeye devam eder.'); return; }
      const token = (await Notifications.getDevicePushTokenAsync()).data;
      await api('/api/push-devices', { body: { platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID', pushToken: String(token) } });
      setInfo('Cihazınız kaydedildi. Anlık bildirim gönderimi, sağlayıcı kurulumu tamamlandığında başlar.');
    } catch (e) { setError(e); }
  }

  return (
    <Screen>
      <FlatList
        data={list.data ?? []}
        keyExtractor={(x) => x.id}
        refreshing={list.loading}
        onRefresh={list.reload}
        ListHeaderComponent={
          <Card>
            <Button title="Anlık bildirimleri aç" kind="secondary" onPress={enablePush} />
            {info && <P muted>{info}</P>}
            <ErrorText error={error ?? list.error} />
          </Card>
        }
        ListEmptyComponent={!list.loading ? <Card><P>Bildiriminiz yok.</P></Card> : null}
        renderItem={({ item }) => (
          <Card>
            <Text style={{ fontWeight: item.read_at ? '400' : '700' }}>{item.title}</Text>
            <P>{item.body}</P>
            <P muted>{dt(item.created_at)}</P>
          </Card>
        )}
      />
    </Screen>
  );
}
