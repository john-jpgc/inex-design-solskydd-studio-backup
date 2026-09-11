import { config } from '../../config.ts';
import { AppError } from '../../domain/errors.ts';
import type { Carrier } from '../../domain/carriers.ts';
import { trackingUrl } from '../../domain/carriers.ts';
import { requestJson } from '../http.ts';
import type { LabelProvider, LabelRequest, LabelResult } from '../types.ts';

/**
 * nShift (f.d. Unifaun) – bokar försändelser hos alla stora transportörer via
 * ett och samma API och returnerar etiketten som PDF.
 *
 * Förberett men inte färdigkopplat: fyll i tjänstekoderna i SERVICE_CODES från
 * ert nShift-avtal och verifiera fältnamnen mot nShift:s API-dokumentation
 * (Unifaun Online REST API, "Shipments"). Allt övrigt – lagring av etiketten,
 * kollinummer, spårningslänk, admin-knappar – fungerar redan via gränssnittet.
 */

/** Tjänstekod per transportör i nShift. Hämtas från ert avtal i nShift-portalen. */
const SERVICE_CODES: Partial<Record<Carrier, string>> = {
  postnord: process.env.NSHIFT_SERVICE_POSTNORD ?? 'P19DR', // exempel: PostNord MyPack Collect
  dhl: process.env.NSHIFT_SERVICE_DHL ?? '',
  budbee: process.env.NSHIFT_SERVICE_BUDBEE ?? '',
  instabox: process.env.NSHIFT_SERVICE_INSTABOX ?? '',
  bring: process.env.NSHIFT_SERVICE_BRING ?? '',
  schenker: process.env.NSHIFT_SERVICE_SCHENKER ?? '',
};

interface NshiftShipmentResponse {
  id?: string;
  status?: string;
  parcels?: { parcelNo?: string }[];
  pdfs?: { href?: string }[];
}

export class NshiftLabelProvider implements LabelProvider {
  readonly id = 'nshift';
  readonly name = 'nShift';
  readonly carriers: readonly Carrier[] = ['postnord', 'dhl', 'budbee', 'instabox', 'bring', 'schenker'];

  isConfigured(): boolean {
    return Boolean(config.nshift.apiId && config.nshift.apiSecret && config.nshift.senderId);
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${config.nshift.apiId}:${config.nshift.apiSecret}`).toString('base64')}`;
  }

  async createLabel(req: LabelRequest): Promise<LabelResult> {
    if (!this.isConfigured()) {
      throw new AppError(501, 'LABEL_PROVIDER_NOT_CONFIGURED', 'nShift saknar NSHIFT_API_ID, NSHIFT_API_SECRET eller NSHIFT_SENDER_ID');
    }
    const serviceCode = req.service?.trim() || SERVICE_CODES[req.carrier];
    if (!serviceCode) {
      throw new AppError(422, 'MISSING_SERVICE_CODE', `Ingen nShift-tjänstekod är konfigurerad för ${req.carrier}`);
    }

    // Kroppen följer strukturen i nShift/Unifaun "Shipments"-API. Verifiera mot dokumentationen.
    const body = {
      sender: { quickId: config.nshift.senderId },
      senderPartners: [{ id: req.carrier.toUpperCase() }],
      receiver: {
        name: req.recipient.name,
        address1: req.recipient.street,
        zipcode: req.recipient.postalCode,
        city: req.recipient.city,
        country: req.recipient.country,
        phone: req.recipient.phone ?? undefined,
        email: req.recipient.email ?? undefined,
      },
      service: { id: serviceCode },
      parcels: [{ copies: 1, weight: req.weightGrams / 1000, contents: 'Nikotinportioner' }],
      orderNo: req.orderNumber,
      senderReference: req.reference ?? req.orderNumber,
      ...(req.pickupPoint ? { agent: { quickId: req.pickupPoint } } : {}),
    };

    const res = await requestJson<NshiftShipmentResponse[]>(`${config.nshift.baseUrl}/shipments?returnFile=true&inlinePdf=true`, {
      method: 'POST',
      providerName: 'nShift',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });

    const shipment = res[0];
    const trackingNumber = shipment?.parcels?.[0]?.parcelNo;
    if (!shipment || !trackingNumber) {
      throw new AppError(502, 'LABEL_PROVIDER_ERROR', 'nShift returnerade inget kollinummer');
    }

    let label: LabelResult['label'] = null;
    const pdfHref = shipment.pdfs?.[0]?.href;
    if (pdfHref) {
      const pdf = await fetch(pdfHref, { headers: { Authorization: this.authHeader() } });
      if (pdf.ok) label = { format: 'pdf', data: new Uint8Array(await pdf.arrayBuffer()) };
    }

    return { trackingNumber, trackingUrl: trackingUrl(req.carrier, trackingNumber), providerRef: shipment.id ?? null, label };
  }

  async cancelLabel(providerRef: string): Promise<void> {
    await requestJson(`${config.nshift.baseUrl}/shipments/${encodeURIComponent(providerRef)}`, {
      method: 'DELETE',
      providerName: 'nShift',
      headers: { Authorization: this.authHeader() },
    });
  }
}
