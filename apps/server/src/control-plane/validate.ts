import type { ZodType } from 'zod';
import { SpillwayError } from '@spillway/shared';

/** Parses input against a zod schema, throwing a 422 validation_error on failure. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SpillwayError('validation_error', 'request failed validation', {
      httpStatus: 422,
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
