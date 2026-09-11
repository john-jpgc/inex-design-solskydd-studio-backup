import type { Carrier } from '../domain/carriers.ts';

/**
 * Gränssnitt för etikettleverantörer (nShift, PostNord, …).
 *
 * En leverantör tar en LabelRequest (avsändare, mottagare, kolli, tjänst) och
 * returnerar kollinummer och – om leverantören stödjer det – själva etiketten
 * som PDF/ZPL. Resten av systemet känner bara till detta gränssnitt, så att
 * byta eller lägga till leverantör innebär en ny fil under providers/.
 */

export interface LabelAddress {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  phone?: string | null;
  email?: string | null;
}

export interface LabelRequest {
  shipmentId: number;
  orderNumber: string;
  carrier: Carrier;
  /** Transportörens tjänst, t.ex. "MyPack Collect" eller en tjänstekod. */
  service?: string | null;
  sender: LabelAddress;
  recipient: LabelAddress;
  weightGrams: number;
  /** Utlämningsställe/ombud om kunden valt ett. */
  pickupPoint?: string | null;
  /** Fri referens som skrivs på etiketten (ordernummer). */
  reference?: string | null;
}

export type LabelFormat = 'pdf' | 'zpl' | 'png';

export interface LabelResult {
  trackingNumber: string;
  trackingUrl?: string | null;
  /** Leverantörens eget id för försändelsen (för avbokning/uppföljning). */
  providerRef?: string | null;
  label?: { format: LabelFormat; data: Uint8Array } | null;
}

export interface LabelProvider {
  readonly id: string;
  readonly name: string;
  /** Transportörer som leverantören kan boka. Tom lista = alla. */
  readonly carriers: readonly Carrier[];
  /** Är nödvändiga nycklar/inställningar på plats? */
  isConfigured(): boolean;
  createLabel(request: LabelRequest): Promise<LabelResult>;
  /** Frivilligt: avboka/annullera en bokad försändelse. */
  cancelLabel?(providerRef: string): Promise<void>;
}
