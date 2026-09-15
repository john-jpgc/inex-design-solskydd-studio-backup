import type { Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';

export async function parseJson<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Kroppen måste vara giltig JSON');
  }
  return parseWith(schema, body);
}

export function parseQuery<S extends z.ZodTypeAny>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.query());
}

export function parseWith<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Felaktig indata', result.error.flatten());
  }
  return result.data;
}

export function idParam(c: Context, name = 'id'): number {
  const raw = c.req.param(name);
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'NOT_FOUND', `Ogiltigt id: ${raw}`);
  return id;
}

export const intFromString = (min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max);

export const paging = z.object({
  limit: intFromString(1, 500).optional(),
  offset: intFromString(0).optional(),
  q: z.string().trim().max(200).optional(),
});
