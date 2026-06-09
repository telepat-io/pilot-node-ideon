/**
 * quote.ts — build the PaymentContract a caller must satisfy for op:"deliver".
 *
 * Contract shape mirrors org/app-store/pkg/payment/types.go:30-49:
 *   {id, amount(uint64 USDC 6dp), asset:"USDC", recipient_addr, expires_at(RFC3339),
 *    nonce, accepted_methods?, accepted_escrows?, memo?}.
 *
 * Amount is the asset's smallest unit (USDC has 6 decimals -> 1 USDC = 1_000_000).
 * cite: app/src/types.ts PaymentContract; payment/types.go:30-49.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { MOCK_METHOD_ID } from './types.js';
import type { PaymentContract, BuildContractOpts } from './types.js';

/** USDC smallest-unit multiplier (6 decimals). */
export const USDC_DECIMALS = 6;
export const USDC_UNIT = 10 ** USDC_DECIMALS; // 1_000_000

/**
 * Price ladder, in USDC smallest units, over the THREE length tiers that map
 * 1:1 to Ideon's length vocabulary (see ideonLengthFor):
 *   short → small  ($1) ,  medium → medium ($2) ,  xl → large ($4).
 * A positive integer is treated as a word count (~$1 / 500 words). Anything
 * unrecognized is priced as medium. The amounts are a simple v1 ladder — tune
 * freely; the tier↔length correspondence is what must stay 1:1.
 */
export function priceForLength(length?: string | number): number {
  if (typeof length === 'number') {
    if (length <= 0) return USDC_UNIT; // 1 USDC floor
    // ~ $1 per 500 words, rounded up to the nearest USDC unit.
    return Math.max(USDC_UNIT, Math.ceil(length / 500) * USDC_UNIT);
  }
  switch ((length ?? '').toString().toLowerCase()) {
    case 'short':
      return 1 * USDC_UNIT;
    case 'medium':
      return 2 * USDC_UNIT;
    case 'xl':
      return 4 * USDC_UNIT;
    default:
      return 2 * USDC_UNIT; // default ~ medium
  }
}

/**
 * Map our price tier to Ideon's `length` value — a strict 1:1 correspondence
 * with `priceForLength`'s tiers, so a priced tier can NEVER fail generation
 * after payment:
 *   short → small ,  medium → medium ,  xl → large.
 * A positive integer passes through as a word count (Ideon resolves it to the
 * nearest size alias). Anything unrecognized falls back to 'medium' (matching
 * the medium price default).
 * cite: telepat/ideon src/config/schema.ts:55 (targetLengthValues), tools.ts:16.
 */
export function ideonLengthFor(length?: string | number): string | number | undefined {
  if (typeof length === 'number') return length > 0 ? length : undefined;
  switch ((length ?? '').toString().toLowerCase()) {
    case 'short':
      return 'small';
    case 'medium':
      return 'medium';
    case 'xl':
      return 'large';
    default:
      return 'medium';
  }
}

/**
 * Build a PaymentContract.
 *   - recipient_addr: our payee address (wallet.evm.address or wallet.address).
 *   - amount: USDC smallest units (caller passes the resolved price).
 *   - expires_at: now + ttlSeconds, RFC3339 (Date.toISOString() is RFC3339).
 *   - nonce: fresh 16-byte hex (replay defense + dedupe key uniqueness).
 *   - accepted_methods: configurable (defaults to [MOCK_METHOD_ID] for the
 *     smoke test).
 */
export function buildContract(opts: BuildContractOpts): PaymentContract {
  const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000).toISOString();
  const contract: PaymentContract = {
    id: randomUUID(),
    amount: opts.amount,
    asset: 'USDC',
    recipient_addr: opts.recipientAddr,
    expires_at: expiresAt,
    nonce: randomBytes(16).toString('hex'),
    accepted_methods: opts.acceptedMethods ?? [MOCK_METHOD_ID],
  };
  if (opts.memo) contract.memo = opts.memo;
  return contract;
}
