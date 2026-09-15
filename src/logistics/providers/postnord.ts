import { config } from '../../config.ts';
import { AppError } from '../../domain/errors.ts';
import type { Carrier } from '../../domain/carriers.ts';
import { trackingUrl } from '../../domain/carriers.ts';
import { requestJson } from '../http.ts';
import type { LabelProvider, LabelRequest, LabelResult } from '../types.ts';

/**
 * PostNord direkt via deras utvecklarportal (developer.postnord.com).
 *
 * Förberett men inte färdigkopplat: PostNords "Shipment"/"Booking"-API kräver
 * ett kundnummer med fraktavtal och en API-nyckel. Kontrollera sökväg, fält och
 * tjänstekoder (t.ex. 19 = MyPack Collect, 17 = MyPack Home) mot dokumentationen
 * innan driftsättning. Allt runtomkring fungerar redan via gränssnittet.
 */

const DEFAULT_SERVICE_CODE = process.env.POSTNORD_SERVICE_CODE ?? '19';

interface PostnordBookingResponse {
  bookingResponse?: {
    bookingId?: string;
    idInformation?: { ids?: { itemId?: string }[] }[];
    labelPrintout?: { printout?: { data?: string } }[];
  };
}

export class PostnordLabelProvider implements LabelProvider {
  readonly id = 'postnord';
  readonly name = 'PostNord';
  readonly carriers: readonly Carrier[] = ['postnord'];

  isConfigured(): boolean {
    return Boolean(config.postnord.apiKey && config.postnord.customerNumber);
  }

  async createLabel(req: LabelRequest): Promise<LabelResult> {
    if (!this.isConfigured()) {
      throw new AppError(501, 'LABEL_PROVIDER_NOT_CONFIGURED', 'PostNord saknar POSTNORD_API_KEY eller POSTNORD_CUSTOMER_NUMBER');
    }
    if (req.carrier !== 'postnord') {
      throw new AppError(422, 'UNSUPPORTED_CARRIER', 'PostNord-integrationen kan bara boka PostNord-försändelser');
    }

    const body = {
      messageDate: new Date().toISOString(),
      messageFunction: 'Instruction',
      updateIndicator: 'Original',
      shipment: [
        {
          shipmentIdentification: { shipmentId: req.orderNumber },
          service: { basicServiceCode: req.service?.trim() || DEFAULT_SERVICE_CODE },
          numberOfPackages: { value: 1 },
          totalGrossWeight: { value: req.weightGrams, unit: 'GRM' },
          parties: {
            consignor: {
              issuerCode: 'Z12',
              partyIdentification: { partyId: config.postnord.customerNumber, partyIdType: '160' },
              party: {
                nameIdentification: { name: req.sender.name },
                address: { streets: [req.sender.street], postalCode: req.sender.postalCode, city: req.sender.city, countryCode: req.sender.country },
                contact: { contactName: req.sender.name, emailAddress: req.sender.email ?? undefined, phoneNo: req.sender.phone ?? undefined },
              },
            },
            consignee: {
              party: {
                nameIdentification: { name: req.recipient.name },
                address: { streets: [req.recipient.street], postalCode: req.recipient.postalCode, city: req.recipient.city, countryCode: req.recipient.country },
                contact: { contactName: req.recipient.name, emailAddress: req.recipient.email ?? undefined, smsNo: req.recipient.phone ?? undefined },
              },
            },
          },
          references: [{ referenceNo: req.reference ?? req.orderNumber, referenceType: 'CU' }],
          goodsItem: [{ packageTypeCode: 'PC', items: [{ itemIdentification: { itemId: '' } }] }],
        },
      ],
    };

    const res = await requestJson<PostnordBookingResponse>(
      `${config.postnord.baseUrl}/rest/shipment/v3/edi/labels/pdf?apikey=${encodeURIComponent(config.postnord.apiKey)}&labelType=ZPL&paperSize=A5`,
      { method: 'POST', providerName: 'PostNord', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    );

    const booking = res.bookingResponse;
    const trackingNumber = booking?.idInformation?.[0]?.ids?.[0]?.itemId;
    if (!trackingNumber) throw new AppError(502, 'LABEL_PROVIDER_ERROR', 'PostNord returnerade inget kollinummer');
    const printout = booking?.labelPrintout?.[0]?.printout?.data;
    const label = printout ? { format: 'pdf' as const, data: new Uint8Array(Buffer.from(printout, 'base64')) } : null;

    return { trackingNumber, trackingUrl: trackingUrl('postnord', trackingNumber), providerRef: booking?.bookingId ?? null, label };
  }
}
