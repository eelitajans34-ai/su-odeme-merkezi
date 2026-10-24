import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, getToken } from './src/api';
import { HomeScreen } from './src/screens/Home';
import { LoginScreen } from './src/screens/Login';
import { NotificationsScreen } from './src/screens/Notifications';
import { SubscriptionsScreen } from './src/screens/Subscriptions';
import { TopupScreen } from './src/screens/Topup';
import { ReceiptScreen, TransactionDetailScreen, TransactionsScreen } from './src/screens/Transactions';

const Stack = createNativeStackNavigator();

export default function App() {
  const [state, setState] = React.useState<'loading' | 'signedOut' | 'signedIn'>('loading');

  const check = React.useCallback(async () => {
    if (!(await getToken())) return setState('signedOut');
    try {
      const me = await api<{ mfa: { enrolled: boolean; verifiedThisSession: boolean } }>('/api/auth/me');
      setState(me.mfa.enrolled && !me.mfa.verifiedThisSession ? 'signedOut' : 'signedIn');
    } catch {
      setState('signedOut');
    }
  }, []);
  React.useEffect(() => { check(); }, [check]);

  if (state === 'loading') return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator>
          {state === 'signedOut' ? (
            <Stack.Screen name="Login" options={{ title: 'Giriş' }}>
              {() => <LoginScreen onSignedIn={() => setState('signedIn')} />}
            </Stack.Screen>
          ) : (
            <>
              <Stack.Screen name="Home" options={{ title: 'Su Ödeme Merkezi' }}>
                {(p) => <HomeScreen {...p} onSignedOut={() => setState('signedOut')} />}
              </Stack.Screen>
              <Stack.Screen name="Subscriptions" component={SubscriptionsScreen} options={{ title: 'Aboneliklerim' }} />
              <Stack.Screen name="Topup" component={TopupScreen} options={{ title: 'Kart yükle' }} />
              <Stack.Screen name="Transactions" component={TransactionsScreen} options={{ title: 'İşlem geçmişi' }} />
              <Stack.Screen name="TransactionDetail" component={TransactionDetailScreen} options={{ title: 'İşlem' }} />
              <Stack.Screen name="Receipt" component={ReceiptScreen} options={{ title: 'Makbuz' }} />
              <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Bildirimler' }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
