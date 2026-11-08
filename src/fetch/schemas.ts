/**
 * Link-server response schemas (Req 14.5). Unknown extra fields are allowed
 * and stripped. Every string parsed here is Untrusted_Data.
 */
import { z } from 'zod';

export const ActionsJsonSchema = z.object({
  rules: z.array(z.object({ pathPattern: z.string(), apiPath: z.string() })).max(100),
});
export type ActionsJson = z.infer<typeof ActionsJsonSchema>;
export type ActionsJsonRule = ActionsJson['rules'][number];

export const LinkedActionSchema = z.object({ href: z.string(), label: z.string() });

export const ActionMetadataSchema = z.object({
  title: z.string(),
  description: z.string(),
  label: z.string(),
  icon: z.string(),
  links: z.object({ actions: z.array(LinkedActionSchema).optional() }).optional(),
});
export type ActionMetadata = z.infer<typeof ActionMetadataSchema>;

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict padded base64 that decodes to at least one byte. */
export function isValidBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0 || !BASE64_ALPHABET.test(s)) return false;
  try {
    return Buffer.from(s, 'base64').byteLength > 0;
  } catch {
    return false;
  }
}

export const ActionPostResponseSchema = z.object({
  transaction: z.string().min(1).refine(isValidBase64, { message: 'transaction is not valid base64' }),
});
export type ActionPostResponse = z.infer<typeof ActionPostResponseSchema>;

/** Each field is dropped on its own if it is not a string (Req 2.5). */
export const TransactionRequestGetSchema = z.object({
  label: z.string().optional().catch(undefined),
  icon: z.string().optional().catch(undefined),
});
export type TransactionRequestGet = z.infer<typeof TransactionRequestGetSchema>;
