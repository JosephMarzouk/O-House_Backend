import { App, cert, initializeApp } from 'firebase-admin/app';
import { getMessaging, Message } from 'firebase-admin/messaging';
import { Club } from '../clubs/clubs';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * sent: FCM took it. dead: the token is gone for good (uninstalled, signed
 * out elsewhere), delete it. retry: FCM or the network had a moment.
 * error: we sent something FCM will never accept (payload, credentials);
 * retrying won't help, and the token is not to blame.
 */
export type Delivery = 'sent' | 'dead' | 'retry' | 'error';
export type Sender = (club: Club, messages: PushMessage[]) => Promise<Delivery[]>;

const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const ERROR = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-payload',
  'messaging/mismatched-credential',
  'messaging/third-party-auth-error',
  'messaging/invalid-credential',
]);

export function classify(code: string | undefined): Delivery {
  if (code && DEAD.has(code)) return 'dead';
  if (code && ERROR.has(code)) return 'error';
  return 'retry';
}

/** One firebase-admin app per club, named by slug: each club is its own Firebase project. */
const apps = new Map<string, App>();
function appFor(club: Club): App {
  let app = apps.get(club.slug);
  if (!app) {
    const sa = club.fcmServiceAccount!;
    app = initializeApp({ credential: cert(sa), projectId: sa.projectId }, `club:${club.slug}`);
    apps.set(club.slug, app);
  }
  return app;
}

function toFcm(m: PushMessage): Message {
  return {
    token: m.token,
    notification: { title: m.title, body: m.body },
    data: m.data,
    // 'rounds' is the channel the app creates at start; high priority so a
    // dozing phone still shows it.
    android: { priority: 'high', notification: { channelId: 'rounds' } },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

/** sendEach takes at most 500; a throw (network, auth) is the caller's to retry. */
export const fcmSend: Sender = async (club, messages) => {
  const out: Delivery[] = [];
  for (let i = 0; i < messages.length; i += 500) {
    const res = await getMessaging(appFor(club)).sendEach(messages.slice(i, i + 500).map(toFcm));
    for (const r of res.responses) out.push(r.success ? 'sent' : classify(r.error?.code));
  }
  return out;
};
