import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as z from 'zod';

// a ticket's two parts travel as `<id>.<secret>`; the target keeps only the
// secret's sha256
const SECRET_BYTES = 32;

// the header a ticket travels in, never the URL
const MOVE_AUTH_SCHEME = 'ImpMove';

export interface ParsedTicket {
  readonly id: string;
  readonly secret: string;
}

export function createTicket(): ParsedTicket & { readonly text: string } {
  const id = Bun.randomUUIDv7();
  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  return { id, secret, text: `${id}.${secret}` };
}

export function parseTicket(text: string): ParsedTicket | null {
  const dot = text.indexOf('.');

  if (dot <= 0 || dot === text.length - 1) {
    return null;
  }

  return { id: text.slice(0, dot), secret: text.slice(dot + 1) };
}

export function buildSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function isSameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');

  return left.length === right.length && timingSafeEqual(left, right);
}

// the ticket in `Authorization: ImpMove <ticket>`
export function readTicketHeader(request: Request): ParsedTicket | null {
  const header = request.headers.get('authorization') ?? '';
  const prefix = `${MOVE_AUTH_SCHEME} `;

  return header.startsWith(prefix) ? parseTicket(header.slice(prefix.length).trim()) : null;
}

export function buildTicketHeader(ticket: string): Record<string, string> {
  return { authorization: `${MOVE_AUTH_SCHEME} ${ticket}` };
}

const ReceiptFileSchema = z.object({
  kind: z.string(),
  index: z.int().nonnegative().optional(),
  sha256: z.string(),
  bytes: z.int().nonnegative(),
});

const ReceiptBodySchema = z.object({
  ticketId: z.string(),
  name: z.string(),
  impId: z.string(),
  files: z.array(ReceiptFileSchema),
});

export type ReceiptBody = z.infer<typeof ReceiptBodySchema>;

type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

export type ReadonlyReceiptBody = Readonly<Omit<ReceiptBody, 'files'>> & {
  readonly files: readonly Readonly<ReceiptFile>[];
};

// The body travels as the JSON text the MAC covers, so no key order or
// re-encoding can change what was signed.
export const ReceiptSchema = z.object({ body: z.string(), mac: z.string() });

export type Receipt = z.infer<typeof ReceiptSchema>;

// The target's word that it holds every file: an HMAC keyed by the ticket's
// secret, which only the two hosts know
export function buildReceipt(body: ReadonlyReceiptBody, secret: string): Receipt {
  const text = JSON.stringify(body);

  return { body: text, mac: buildMac(text, secret) };
}

// the receipt's body, or null when the MAC does not hold
export function readReceipt(receipt: Readonly<Receipt>, secret: string): ReceiptBody | null {
  if (!isSameHash(receipt.mac, buildMac(receipt.body, secret))) {
    return null;
  }

  return ReceiptBodySchema.parse(JSON.parse(receipt.body));
}

function buildMac(text: string, secret: string): string {
  return createHmac('sha256', secret).update(text).digest('hex');
}
