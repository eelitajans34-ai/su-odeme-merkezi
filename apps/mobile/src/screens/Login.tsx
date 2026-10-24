import React from 'react';
import { ScrollView } from 'react-native';
import { api, setToken } from '../api';
import { Button, Card, ErrorText, Field, H, P, Screen } from '../ui';

/**
 * Giriş. MFA etkinse ikinci adımda TOTP veya kurtarma kodu istenir.
 * Yönetim işlemleri mobil uygulamada yoktur; personel hesapları web panelini kullanır.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [step, setStep] = React.useState<'password' | 'mfa'>('password');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  async function login() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ token: string; mfaRequired: boolean; mfaEnrollmentRequired: boolean }>('/api/auth/login', { body: { email, password, clientType: 'MOBILE' } });
      await setToken(r.token);
      setPassword('');
      if (r.mfaEnrollmentRequired) throw new Error('Bu hesap için iki adımlı doğrulama kurulumu gerekiyor. Lütfen önce web uygulamasından kurulumu tamamlayın.');
      if (r.mfaRequired) setStep('mfa'); else onSignedIn();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError(null);
    try {
      const body = /^\d{6}$/.test(code) ? { code } : { recoveryCode: code.trim() };
      await api('/api/auth/mfa/verify', { body });
      onSignedIn();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Card>
          <H>{step === 'password' ? 'Giriş yap' : 'İki adımlı doğrulama'}</H>
          {step === 'password' ? (
            <>
              <Field label="E-posta" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="username" />
              <Field label="Parola" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" />
              <ErrorText error={error} />
              <Button title="Giriş yap" onPress={login} busy={busy} disabled={!email || !password} />
              <P muted>Hesap oluşturma ve parola sıfırlama web uygulamasından yapılır.</P>
            </>
          ) : (
            <>
              <P>Doğrulayıcı uygulamanızdaki 6 haneli kodu veya bir kurtarma kodunu girin.</P>
              <Field label="Doğrulama kodu" value={code} onChangeText={setCode} autoCapitalize="none" autoComplete="one-time-code" textContentType="oneTimeCode" />
              <ErrorText error={error} />
              <Button title="Doğrula" onPress={verify} busy={busy} disabled={code.length < 6} />
            </>
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}
