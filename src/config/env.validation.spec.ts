import 'reflect-metadata';
import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'mysql://root:@localhost:3306/x',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  QR_SIGNING_SECRET: 'c'.repeat(32),
  CLIENT_APP_URL: 'http://localhost:5173',
};

describe('validateEnv', () => {
  it('interprète correctement les booléens', () => {
    expect(
      validateEnv({ ...base, PAYMENTS_SANDBOX_ENABLED: 'false' })
        .PAYMENTS_SANDBOX_ENABLED,
    ).toBe(false);
    expect(
      validateEnv({ ...base, PAYMENTS_SANDBOX_ENABLED: 'true' })
        .PAYMENTS_SANDBOX_ENABLED,
    ).toBe(true);
    expect(validateEnv(base).PAYMENTS_SANDBOX_ENABLED).toBe(false);
  });

  it('interdit le simulateur de paiement en production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        PAYMENTS_SANDBOX_ENABLED: 'true',
      }),
    ).toThrow(/interdit en production/);
  });

  it('refuse un secret trop court', () => {
    expect(() => validateEnv({ ...base, QR_SIGNING_SECRET: 'court' })).toThrow(
      /QR_SIGNING_SECRET/,
    );
  });
});
