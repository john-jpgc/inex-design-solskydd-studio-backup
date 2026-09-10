import { z } from 'zod';
import { STRENGTHS, FORMATS } from '../domain/products.ts';
import { ORDER_STATUSES } from '../domain/orderStatus.ts';
import { CARRIERS, SHIPMENT_STATUSES } from '../domain/carriers.ts';

const trimmed = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 200) => z.string().trim().max(max).nullish();
const birthDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format ÅÅÅÅ-MM-DD');
const ore = z.number().int().min(0);

export const customerSchema = z.object({
  email: z.string().trim().email().max(200),
  firstName: trimmed(100),
  lastName: trimmed(100),
  phone: optionalText(50),
  birthDate,
  street: optionalText(200),
  postalCode: optionalText(20),
  city: optionalText(100),
  country: z.string().trim().length(2).optional(),
  marketingConsent: z.boolean().optional(),
  prefStrength: z.enum(STRENGTHS).nullish(),
  prefFlavors: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  excludedFlavors: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  notes: optionalText(2000),
});

export const customerPatchSchema = customerSchema.partial().extend({
  status: z.enum(['active', 'blocked']).optional(),
});

export const productSchema = z.object({
  sku: trimmed(50),
  name: trimmed(200),
  brand: trimmed(100),
  flavor: trimmed(100),
  strength: z.enum(STRENGTHS),
  nicotineMg: z.number().min(0).max(100).nullish(),
  format: z.enum(FORMATS).optional(),
  priceOre: ore,
  vatRate: z.number().int().min(0).max(100).optional(),
  weightGrams: z.number().int().min(1).max(5000).optional(),
  active: z.boolean().optional(),
});

export const productPatchSchema = productSchema.partial();

export const stockAdjustSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, 'Ändringen får inte vara 0'),
  reason: z.enum(['purchase', 'adjustment', 'return', 'correction']).default('adjustment'),
  note: optionalText(500),
});

const productLine = z.object({
  kind: z.literal('product'),
  productId: z.number().int().positive().optional(),
  sku: z.string().trim().min(1).optional(),
  quantity: z.number().int().positive().max(1000),
  unitPriceOre: ore.optional(),
}).refine((l) => l.productId != null || l.sku, { message: 'Ange productId eller sku' });

const boxLine = z.object({
  kind: z.literal('mystery_box'),
  boxSize: z.number().int().positive().max(200),
  quantity: z.number().int().positive().max(100),
  strength: z.enum(STRENGTHS).nullish(),
  unitPriceOre: ore.optional(),
});

export const shippingAddressSchema = z.object({
  name: z.string().trim().max(200).optional(),
  street: trimmed(200),
  postalCode: trimmed(20),
  city: trimmed(100),
  country: z.string().trim().length(2).optional(),
  phone: optionalText(50),
});

export const createOrderSchema = z.object({
  customerId: z.number().int().positive().optional(),
  customer: customerSchema.optional(),
  lines: z.array(z.union([productLine, boxLine])).min(1).max(100),
  shippingAddress: shippingAddressSchema.optional(),
  paymentMethod: optionalText(50),
  paymentStatus: z.enum(['unpaid', 'paid']).optional(),
  paymentRef: optionalText(200),
  shippingOre: ore.optional(),
  channel: z.string().trim().max(50).optional(),
  externalRef: optionalText(200),
  customerNote: optionalText(2000),
  ageVerified: z.boolean().optional(),
  placedAt: z.string().datetime().optional(),
}).refine((o) => o.customerId != null || o.customer, { message: 'Ange customerId eller customer' });

export const orderListQuery = z.object({
  status: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(ORDER_STATUSES)))
    .optional(),
  customerId: z.coerce.number().int().positive().optional(),
});

export const paySchema = z.object({ paymentRef: optionalText(200), paymentMethod: optionalText(50) });
export const cancelSchema = z.object({ reason: z.string().trim().max(500).default('') });
export const returnSchema = z.object({ restock: z.boolean().default(false), reason: optionalText(500) });
export const noteSchema = z.object({ internalNote: z.string().trim().max(5000).nullable() });
export const pickSchema = z.object({ seed: z.number().int().optional() });
export const boxPicksSchema = z.object({
  picks: z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(0).max(500) })).max(200),
});

export const shipmentInputSchema = z.object({
  carrier: z.enum(CARRIERS),
  service: optionalText(100),
  trackingNumber: optionalText(100),
  weightGrams: z.number().int().min(1).max(50_000).nullish(),
  pickupPoint: optionalText(200),
});

export const shipmentPatchSchema = shipmentInputSchema.partial();

export const shipmentEventSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  description: optionalText(500),
  location: optionalText(200),
  occurredAt: z.string().datetime().optional(),
});

export const shipmentListQuery = z.object({
  status: z.enum(SHIPMENT_STATUSES).optional(),
  carrier: z.enum(CARRIERS).optional(),
});
