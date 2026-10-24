import type { Actor, Deps } from '../context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { maskTail } from '../lib/mask.js';
import { audit } from './audit.js';

const SUBSCRIBER_NO = /^[A-Za-z0-9-]{4,24}$/;

export function presentSubscription(r: any) {
  return {
    id: r.id,
    utilityId: r.utility_id,
    utilityName: r.utility_name,
    subscriberMasked: maskTail(r.subscriber_no),
    nickname: r.nickname,
    verificationStatus: r.verification_status,
    holderNameMasked: r.holder_name_masked,
    isTestData: r.is_test_data,
    createdAt: r.created_at,
  };
}

export async function listSubscriptions(deps: Deps, userId: string) {
  const { rows } = await deps.db.query(
    `SELECT s.*, u.full_name AS utility_name FROM subscriptions s JOIN water_utilities u ON u.id = s.utility_id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL ORDER BY s.created_at`,
    [userId],
  );
  return rows.map(presentSubscription);
}

/** Nesne bazlı yetki kontrolü: başka kullanıcının aboneliği 404 döner. */
export async function getOwnedSubscription(deps: Deps, userId: string, id: string) {
  const { rows } = await deps.db.query(
    `SELECT s.*, u.full_name AS utility_name FROM subscriptions s JOIN water_utilities u ON u.id = s.utility_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
    [id, userId],
  );
  if (!rows[0]) throw notFound('Abonelik bulunamadı.');
  return rows[0];
}

export async function addSubscription(deps: Deps, actor: Actor, input: { utilityId: string; subscriberNo: string; nickname?: string; source?: 'MANUAL' | 'QR' }) {
  const db = deps.db;
  const subscriberNo = input.subscriberNo.trim();
  if (!SUBSCRIBER_NO.test(subscriberNo)) throw badRequest('Abone numarası geçersiz.');
  const utility = (await db.query('SELECT id, is_active FROM water_utilities WHERE id = $1', [input.utilityId])).rows[0];
  if (!utility) throw notFound('Su idaresi bulunamadı.');
  const { mode } = await deps.integrations.mode(db);

  let status = 'INTEGRATION_PENDING';
  let holder: string | null = null;
  let cards: { cardSerial: string; topupMethod: string }[] = [];
  const runtime = await deps.integrations.utilityRuntime(db, input.utilityId, mode);
  if (runtime.integration?.supports_account_query && runtime.adapter.code !== 'NONE') {
    try {
      const acc = await runtime.adapter.queryAccount(runtime.ctx, subscriberNo);
      if (!acc.found) throw badRequest('Abone numarası su idaresinde bulunamadı.', 'SUBSCRIBER_NOT_FOUND');
      status = 'VERIFIED';
      holder = acc.holderNameMasked ?? null;
      cards = acc.cards ?? [];
    } catch (err: any) {
      if (err.code === 'SUBSCRIBER_NOT_FOUND') throw err;
      status = 'INTEGRATION_PENDING';
    }
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO subscriptions (user_id, utility_id, subscriber_no, nickname, verification_status, verified_at, holder_name_masked, source, is_test_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [actor.userId, input.utilityId, subscriberNo, input.nickname ?? null, status, status === 'VERIFIED' ? new Date() : null, holder, input.source ?? 'MANUAL', runtime.adapter.isSimulator],
    );
    const id = rows[0].id;
    await audit(db, { actorUserId: actor.userId, actorType: 'USER', action: 'subscription.add', targetType: 'subscription', targetId: id, ip: actor.ip, userAgent: actor.userAgent, details: { utilityId: input.utilityId, source: input.source ?? 'MANUAL' } });
    await deps.notifications.notifyUser({ userId: actor.userId, eventType: 'SUBSCRIPTION_ADDED', title: 'Yeni abonelik tanımlandı', body: `${maskTail(subscriberNo)} numaralı abonelik hesabınıza eklendi.` });
    {
      for (const card of cards) {
        await db.query(
          `INSERT INTO water_cards (user_id, subscription_id, card_serial, topup_method) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [actor.userId, id, card.cardSerial, card.topupMethod],
        );
      }
    }
    return presentSubscription({ ...(await getOwnedSubscription(deps, actor.userId, id)) });
  } catch (err: any) {
    if (err.code === '23505') throw conflict('Bu abonelik zaten hesabınızda kayıtlı.');
    throw err;
  }
}

/** QR yalnızca entegrasyonun tanımladığı ve doğrulanabilen biçimde kabul edilir; aksi hâlde manuel giriş istenir. */
export async function addSubscriptionFromQr(deps: Deps, actor: Actor, payload: string) {
  const { mode } = await deps.integrations.mode(deps.db);
  const utilities = (await deps.db.query('SELECT id, code FROM water_utilities WHERE is_active')).rows;
  for (const u of utilities) {
    const rt = await deps.integrations.utilityRuntime(deps.db, u.id, mode);
    const parsed = rt.adapter.parseQr?.(payload);
    if (parsed && parsed.utilityCode === u.code) {
      return addSubscription(deps, actor, { utilityId: u.id, subscriberNo: parsed.subscriberNo, source: 'QR' });
    }
  }
  throw badRequest('QR kodu tanınmadı veya bu su idaresi için QR desteği tanımlı değil. Lütfen abone numarasını elle girin.', 'QR_UNSUPPORTED');
}

export async function removeSubscription(deps: Deps, actor: Actor, id: string) {
  await getOwnedSubscription(deps, actor.userId, id);
  await deps.db.query('UPDATE subscriptions SET deleted_at = now() WHERE id = $1 AND user_id = $2', [id, actor.userId]);
  await deps.db.query('UPDATE water_cards SET deleted_at = now() WHERE subscription_id = $1 AND user_id = $2', [id, actor.userId]);
  await audit(deps.db, { actorUserId: actor.userId, actorType: 'USER', action: 'subscription.remove', targetType: 'subscription', targetId: id, ip: actor.ip });
}

export async function listCards(deps: Deps, userId: string) {
  const { rows } = await deps.db.query(
    `SELECT c.*, s.subscriber_no, s.verification_status, u.full_name AS utility_name
       FROM water_cards c JOIN subscriptions s ON s.id = c.subscription_id JOIN water_utilities u ON u.id = s.utility_id
      WHERE c.user_id = $1 AND c.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY c.created_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    cardMasked: maskTail(r.card_serial),
    subscriberMasked: maskTail(r.subscriber_no),
    utilityName: r.utility_name,
    topupMethod: r.topup_method,
    nickname: r.nickname,
    subscriptionVerified: r.verification_status === 'VERIFIED',
  }));
}

export async function addCard(deps: Deps, actor: Actor, subscriptionId: string, input: { cardSerial: string; nickname?: string }) {
  await getOwnedSubscription(deps, actor.userId, subscriptionId);
  if (!/^[A-Za-z0-9-]{4,32}$/.test(input.cardSerial)) throw badRequest('Kart numarası geçersiz.');
  try {
    const { rows } = await deps.db.query(
      `INSERT INTO water_cards (user_id, subscription_id, card_serial, nickname) VALUES ($1,$2,$3,$4) RETURNING id`,
      [actor.userId, subscriptionId, input.cardSerial.trim(), input.nickname ?? null],
    );
    return { id: rows[0].id };
  } catch (err: any) {
    if (err.code === '23505') throw conflict('Bu kart zaten kayıtlı.');
    throw err;
  }
}
