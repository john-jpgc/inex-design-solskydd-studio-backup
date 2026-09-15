import type { Db } from '../../db/connection.ts';
import { invalid, notFound } from '../../domain/errors.ts';
import { findCustomerByToken, getCustomer, type Customer } from '../../services/customers.ts';
import { findEditionByPeriod, getEdition, type EditionDetail } from '../../services/editions.ts';

/** Hemsidan får referera till kund med internt id eller publik token, och till box med id eller period. */

export function resolveCustomer(db: Db, input: { customerId?: number | null; customerToken?: string | null }): Customer {
  if (input.customerId != null) return getCustomer(db, input.customerId);
  if (input.customerToken) {
    const customer = findCustomerByToken(db, input.customerToken);
    if (!customer) throw notFound('Kund', input.customerToken);
    return customer;
  }
  throw invalid('MISSING_CUSTOMER', 'Ange customerId eller customerToken');
}

export function resolveEdition(db: Db, input: { editionId?: number | null; period?: string | null }): EditionDetail {
  if (input.editionId != null) return getEdition(db, input.editionId);
  if (input.period) {
    const edition = findEditionByPeriod(db, input.period);
    if (!edition) throw notFound('Box', input.period);
    return edition;
  }
  throw invalid('MISSING_EDITION', 'Ange editionId eller period');
}
