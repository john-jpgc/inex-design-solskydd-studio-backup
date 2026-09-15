import { AppError } from '../../domain/errors.ts';
import type { LabelProvider, LabelRequest, LabelResult } from '../types.ts';

/** Standardläge: ingen integration – kollinummer skrivs in för hand i admin. */
export class ManualLabelProvider implements LabelProvider {
  readonly id = 'manual';
  readonly name = 'Manuell (ingen integration)';
  readonly carriers = [] as const;

  isConfigured(): boolean {
    return false;
  }

  async createLabel(_request: LabelRequest): Promise<LabelResult> {
    throw new AppError(
      501,
      'LABEL_PROVIDER_NOT_CONFIGURED',
      'Ingen etikettleverantör är konfigurerad. Sätt LABEL_PROVIDER=nshift eller postnord och tillhörande nycklar i .env.',
    );
  }
}
