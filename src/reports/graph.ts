import type { MailConfig } from '../clubs/clubs';

/**
 * Mail through Microsoft Graph, as the club's own Microsoft 365 mailbox
 * (the app: CLUBS.<slug>.mail; the address: Club settings). Two fetches and
 * no SDK: a client-credentials token,
 * then sendMail. Password SMTP is being retired for Microsoft 365.
 */
export interface Mail {
  to: string[];
  subject: string;
  html: string;
  attachment: { name: string; bytes: Buffer };
}

// ponytail: sendMail takes the whole message in one request of at most 4 MB,
// so about 3 MB of PDF once base64 grows it. Past that, Graph's draft +
// createUploadSession takes up to 150 MB (the mailbox's own limit, usually
// 25–35 MB, still applies).
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const tokens = new Map<string, { token: string; until: number }>();

async function graphToken(cfg: MailConfig): Promise<string> {
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Microsoft sign-in refused (${res.status} ${body.error ?? ''})`.trim());
  // A minute early, so a token never dies between here and sendMail.
  tokens.set(key, { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 });
  return body.access_token;
}

/** `from`: the club's sender mailbox (Club settings); the app must be allowed to send as it. */
export async function graphSend(cfg: MailConfig, from: string, mail: Mail): Promise<void> {
  if (mail.attachment.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`the PDF is ${(mail.attachment.bytes.length / 1048576).toFixed(1)} MB, over the 3 MB a single email request takes`);
  }
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await graphToken(cfg)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: 'HTML', content: mail.html },
        toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: mail.attachment.name,
            contentType: 'application/pdf',
            contentBytes: mail.attachment.bytes.toString('base64'),
          },
        ],
      },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202) {
    const detail = ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code ?? '';
    throw new Error(`Microsoft Graph refused the email (${res.status} ${detail})`.trim());
  }
}
