import { z } from 'zod';

/**
 * Control-plane request contracts (04-api-contracts §3). Response shaping lives
 * in the route handlers; these validate inbound bodies. Shared so future SDK /
 * dashboard type-gen has one source of truth.
 */

export const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric or hyphen');

export const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
// The gateway currently ships the OpenAI adapter only. Keep unsupported provider
// configuration out of the control plane until an adapter, pricing semantics, and
// egress controls exist for it.
export const providerSchema = z.enum(['openai']);

/** True when a string contains no C0 control chars or DEL (CRLF, tab, NUL, …). */
const noControlChars = (v: string): boolean =>
  ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * M48: human-facing name shared by org, team, virtual-key, alias, policy, alert, and automation
 * rule schemas.  Blocks C0 control chars (CRLF/tab/NUL) that can forge log lines, inject email
 * headers, or corrupt Slack alert templates — slug and apiKey already guard their own chars; names
 * were the remaining attacker-controlled surface feeding structured logs and outbound channels.
 * Exported so governance.ts can reuse it without duplicating the refine logic.
 */
export const safeName = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(noControlChars, { message: 'name must not contain control characters' });

// ── orgs ──
export const createOrgSchema = z.object({
  name: safeName(120),
  slug: slugSchema,
});
export const updateOrgSchema = z
  .object({
    name: safeName(120).optional(),
    bodyLoggingEnabled: z.boolean().optional(),
    bodyRetentionDays: z.number().int().min(1).max(365).optional(),
    metadataRetentionDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

// ── members ──
export const inviteMemberSchema = z.object({
  userId: z.string().min(1).max(256), // WorkOS user id
  role: roleSchema,
});
export const updateMemberSchema = z.object({ role: roleSchema }).strict();

// ── teams ──
export const createTeamSchema = z.object({ name: safeName(120), slug: slugSchema });
export const updateTeamSchema = z
  .object({ name: safeName(120).optional(), slug: slugSchema.optional() })
  .strict();

// ── provider keys ──
export const createProviderKeySchema = z
  .object({
    provider: providerSchema,
    label: z.string().min(1).max(120),
    // No control chars: the value flows into an `Authorization: Bearer …` header at
    // dispatch; a CRLF would be a header-injection vector / per-key self-DoS (red-team).
    apiKey: z
      .string()
      .min(1)
      .max(512)
      .refine(noControlChars, { message: 'API key must not contain control characters' }),
    // Custom upstream URLs are intentionally unavailable until the compat
    // adapter has an egress-time DNS/IP allow-list (creation-time parsing alone
    // cannot defend against DNS rebinding).
    baseUrl: z.never().optional(),
  })
  .refine((d) => !d.baseUrl, {
    message: 'baseUrl is not supported until the OpenAI-compatible adapter is available',
    path: ['baseUrl'],
  });

// ── virtual keys ──
export const createVirtualKeySchema = z.object({
  name: safeName(120),
  teamId: z.string().uuid().optional(),
  allowedProviders: z.array(providerSchema).max(4).optional(),
  allowedModels: z.array(z.string().min(1).max(128)).max(100).optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).optional(),
  tpmLimit: z.number().int().positive().max(1_000_000_000).optional(),
  maxInputTokens: z.number().int().positive().max(10_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  expiresAt: z.string().datetime().optional(),
  // ≤20 entries (04-api §2); bound key/value sizes to stop jsonb-bloat abuse.
  // L48: .min(1) on the key (empty-string keys corrupt jsonb matching downstream); the size cap
  // runs in superRefine BEFORE per-entry work so a 50k-entry object can't CPU-spin per-validate.
  metadata: z
    .record(z.string().min(1).max(64), z.string().max(1024))
    .superRefine((r, ctx) => {
      if (Object.keys(r).length > 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: 20,
          type: 'array',
          inclusive: true,
          message: 'metadata supports at most 20 entries',
        });
      }
    })
    .optional(),
});
export const updateVirtualKeySchema = z
  .object({ status: z.enum(['active', 'paused', 'revoked']) })
  .strict();

// ── admin api keys ──
export const createAdminKeySchema = z.object({
  name: safeName(120),
  role: z.enum(['admin', 'viewer']).default('admin'),
});
