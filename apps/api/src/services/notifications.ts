import nodemailer from 'nodemailer';
import type { Db, DbClient } from '../db.js';
import type { SecretStore } from './secrets.js';

export type Channel = 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP';

export interface NotifyInput {
  userId: string;
  eventType: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  channels?: Channel[];
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Bildirim servisi.
 * - Uygulama içi bildirim her zaman kaydedilir.
 * - E-posta yalnızca standart SMTP yapılandırılmışsa gönderilir. SMS ve push için sağlayıcı adaptörü
 *   bağlanana kadar teslimat kaydı "NOT_SENT_PROVIDER_NOT_CONFIGURED" olur; sahte "gönderildi" yazılmaz.
 * - Geliştirme ortamında e-postalar yalnızca yerel konsol "dev outbox"una yazılır ve öyle işaretlenir.
 */
export class NotificationService {
  /** Testlerde gözlemlenebilir yerel çıkış kutusu (yalnızca geliştirme/test). */
  readonly devOutbox: OutboundEmail[] = [];

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly opts: { appEnv: string; emailFrom?: string; emailSecretRef?: string },
  ) {}

  private async channelStatus(db: DbClient): Promise<Record<Channel, string>> {
    const { rows } = await db.query('SELECT channel, status FROM notification_channels');
    return Object.fromEntries(rows.map((r) => [r.channel, r.status])) as Record<Channel, string>;
  }

  async notifyUser(input: NotifyInput, db: DbClient = this.db): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO notifications (user_id, audience, event_type, severity, title, body, data)
       VALUES ($1,'USER',$2,$3,$4,$5,$6) RETURNING id`,
      [input.userId, input.eventType, input.severity ?? 'INFO', input.title, input.body, JSON.stringify(input.data ?? {})],
    );
    const id = rows[0].id as string;
    await db.query(`INSERT INTO notification_deliveries (notification_id, channel, status) VALUES ($1,'IN_APP','DELIVERED_IN_APP')`, [id]);
    const status = await this.channelStatus(db);
    for (const ch of input.channels ?? (['EMAIL', 'PUSH'] as Channel[])) {
      if (ch === 'IN_APP') continue;
      if (ch === 'EMAIL') {
        const u = await db.query('SELECT email FROM users WHERE id = $1', [input.userId]);
        const result = await this.sendEmail(db, status.EMAIL, { to: u.rows[0]?.email, subject: input.title, text: input.body });
        await db.query('INSERT INTO notification_deliveries (notification_id, channel, status, error) VALUES ($1,$2,$3,$4)', [id, ch, result.status, result.error ?? null]);
        continue;
      }
      // SMS ve PUSH: sağlayıcı adaptörü bu sürümde yok → gönderilmez, durum açıkça kaydedilir.
      await db.query('INSERT INTO notification_deliveries (notification_id, channel, status) VALUES ($1,$2,$3)', [id, ch, 'NOT_SENT_PROVIDER_NOT_CONFIGURED']);
    }
    return id;
  }

  /** Doğrudan e-posta (doğrulama/sıfırlama/davet bağlantıları). Bağlantı içeriği bildirim tablosuna yazılmaz. */
  async sendTransactionalEmail(email: OutboundEmail, db: DbClient = this.db) {
    const status = await this.channelStatus(db);
    return this.sendEmail(db, status.EMAIL, email);
  }

  isEmailDeliverable(statusRow: string | undefined) {
    return statusRow === 'ACTIVE' || statusRow === 'TEST';
  }

  private async sendEmail(db: DbClient, channelStatus: string | undefined, email: OutboundEmail): Promise<{ status: string; error?: string }> {
    if (this.opts.appEnv === 'development' || this.opts.appEnv === 'test') {
      if (!this.isEmailDeliverable(channelStatus)) {
        this.devOutbox.push(email);
        if (this.opts.appEnv === 'development') {
          // Yalnızca yerel geliştirici konsolu; gerçek gönderim değildir.
          console.info(`[DEV OUTBOX — GERÇEK E-POSTA GÖNDERİLMEDİ] Kime: ${email.to} | ${email.subject}\n${email.text}`);
        }
        return { status: 'DEV_OUTBOX_ONLY' };
      }
    }
    if (!this.isEmailDeliverable(channelStatus) || !this.opts.emailFrom) {
      return { status: 'NOT_SENT_PROVIDER_NOT_CONFIGURED' };
    }
    try {
      const smtpUrl = await this.secrets.reveal(db, this.opts.emailSecretRef);
      if (!smtpUrl) return { status: 'NOT_SENT_PROVIDER_NOT_CONFIGURED' };
      const transport = nodemailer.createTransport(smtpUrl);
      await transport.sendMail({ from: this.opts.emailFrom, to: email.to, subject: email.subject, text: email.text });
      return { status: 'SENT' };
    } catch (err) {
      return { status: 'FAILED', error: (err as Error).message.slice(0, 200) };
    }
  }

  async alertAdmins(
    input: { eventType: string; title: string; body: string; severity?: 'INFO' | 'WARNING' | 'CRITICAL'; data?: Record<string, unknown> },
    db: DbClient = this.db,
  ): Promise<void> {
    await db.query(
      `INSERT INTO notifications (user_id, audience, event_type, severity, title, body, data)
       VALUES (NULL,'ADMIN',$1,$2,$3,$4,$5)`,
      [input.eventType, input.severity ?? 'WARNING', input.title, input.body, JSON.stringify(input.data ?? {})],
    );
  }
}
