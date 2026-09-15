import { config } from '../config.ts';
import { ManualLabelProvider } from './providers/manual.ts';
import { NshiftLabelProvider } from './providers/nshift.ts';
import { PostnordLabelProvider } from './providers/postnord.ts';
import type { LabelProvider } from './types.ts';

export type { LabelAddress, LabelFormat, LabelProvider, LabelRequest, LabelResult } from './types.ts';

const PROVIDERS: Record<string, () => LabelProvider> = {
  manual: () => new ManualLabelProvider(),
  nshift: () => new NshiftLabelProvider(),
  postnord: () => new PostnordLabelProvider(),
};

let override: LabelProvider | undefined;
let cached: LabelProvider | undefined;

/** Vald etikettleverantör enligt LABEL_PROVIDER. Okänt värde faller tillbaka till manuell. */
export function getLabelProvider(): LabelProvider {
  if (override) return override;
  if (!cached) {
    const factory = PROVIDERS[config.labelProvider] ?? PROVIDERS.manual!;
    cached = factory();
  }
  return cached;
}

/** Byt leverantör i körtid – används i tester och kan användas för fler leverantörer. */
export function setLabelProvider(provider: LabelProvider | undefined): void {
  override = provider;
}

export function availableLabelProviders(): string[] {
  return Object.keys(PROVIDERS);
}
