import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.ts';
import { idParam, parseJson, parseQuery } from '../validate.ts';
import { SENTIMENTS } from '../../domain/ratings.ts';
import {
  getCustomerEditionRatings, listComments, listCustomerRatings, upsertEditionFeedback, upsertProductRating,
} from '../../services/ratings.ts';
import { resolveCustomer, resolveEdition } from './resolve.ts';

const ref = {
  customerId: z.number().int().positive().optional(),
  customerToken: z.string().trim().max(100).optional(),
  editionId: z.number().int().positive().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
};

const ratingSchema = z.object({
  ...ref,
  productId: z.number().int().positive(),
  rating: z.number().int().min(1).max(5).nullish(),
  sentiment: z.enum(SENTIMENTS).nullish(),
  wouldBuyAgain: z.boolean().nullish(),
  comment: z.string().trim().max(2000).nullish(),
  source: z.string().trim().max(50).optional(),
});

const boxFeedbackSchema = z.object({
  ...ref,
  rating: z.number().int().min(1).max(5).nullish(),
  comment: z.string().trim().max(2000).nullish(),
});

const lookupQuery = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  customerToken: z.string().trim().max(100).optional(),
  editionId: z.coerce.number().int().positive().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export const ratingsApi = new Hono<AppEnv>()
  /** Kunden betygsätter en produkt i en viss månads box. Samma anrop uppdaterar ett tidigare betyg. */
  .post('/', async (c) => {
    const input = await parseJson(c, ratingSchema);
    const db = c.get('db');
    const customer = resolveCustomer(db, input);
    const edition = resolveEdition(db, input);
    const rating = upsertProductRating(db, {
      customerId: customer.id,
      editionId: edition.id,
      productId: input.productId,
      rating: input.rating ?? null,
      sentiment: input.sentiment ?? null,
      wouldBuyAgain: input.wouldBuyAgain ?? null,
      comment: input.comment ?? null,
      source: input.source,
    });
    return c.json({ rating }, 201);
  })
  /** Helhetsbetyg på månadens box. */
  .post('/box', async (c) => {
    const input = await parseJson(c, boxFeedbackSchema);
    const db = c.get('db');
    const customer = resolveCustomer(db, input);
    const edition = resolveEdition(db, input);
    const feedback = upsertEditionFeedback(db, {
      customerId: customer.id,
      editionId: edition.id,
      rating: input.rating ?? null,
      comment: input.comment ?? null,
    });
    return c.json({ feedback }, 201);
  })
  /** Kundens egna betyg för en box – underlag för "min profil" på hemsidan. */
  .get('/', (c) => {
    const q = parseQuery(c, lookupQuery);
    const db = c.get('db');
    const customer = resolveCustomer(db, q);
    if (q.editionId == null && !q.period) {
      return c.json({ customerId: customer.id, ratings: listCustomerRatings(db, customer.id) });
    }
    const edition = resolveEdition(db, q);
    return c.json({ customerId: customer.id, ...getCustomerEditionRatings(db, customer.id, edition.id) });
  })
  .get('/comments/:editionId', (c) => c.json({ comments: listComments(c.get('db'), { editionId: idParam(c, 'editionId') }) }));
