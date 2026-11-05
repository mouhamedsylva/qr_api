import { ConfigService } from '@nestjs/config';
import { QrTokenService } from './qr-token.service';

describe('QrTokenService', () => {
  const config = new ConfigService({
    QR_SIGNING_SECRET: 'x'.repeat(40),
    CLIENT_APP_URL: 'https://menu.qr-order.com/',
  });
  const service = new QrTokenService(config);
  const tableId = '6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';

  it('signe et vérifie un jeton', () => {
    const token = service.sign({ tableId, version: 3 });
    expect(service.verify(token)).toEqual({ tableId, version: 3 });
  });

  it('rejette une version ou une table modifiée', () => {
    const [, , sig] = service.sign({ tableId, version: 1 }).split('.');
    expect(service.verify(`${tableId}.2.${sig}`)).toBeNull();
    expect(
      service.verify(`7f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b.1.${sig}`),
    ).toBeNull();
  });

  it('rejette un jeton mal formé', () => {
    expect(service.verify('n-importe-quoi')).toBeNull();
    expect(service.verify(`${tableId}.1`)).toBeNull();
    expect(service.verify(`${tableId}.1.abc.def`)).toBeNull();
  });

  it('rejette une signature produite avec un autre secret', () => {
    const other = new QrTokenService(
      new ConfigService({
        QR_SIGNING_SECRET: 'y'.repeat(40),
        CLIENT_APP_URL: 'http://localhost',
      }),
    );
    expect(service.verify(other.sign({ tableId, version: 1 }))).toBeNull();
  });

  it("construit l'URL client sans double slash", () => {
    expect(service.url({ tableId, version: 1 })).toMatch(
      /^https:\/\/menu\.qr-order\.com\/t\//,
    );
  });
});
