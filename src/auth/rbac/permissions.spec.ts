import { PERMISSIONS, resolvePermissions } from './permissions';

describe('resolvePermissions', () => {
  it('donne toutes les permissions à un OWNER', () => {
    expect(resolvePermissions('OWNER').size).toBe(PERMISSIONS.length);
  });

  it('retire la facturation au MANAGER', () => {
    const perms = resolvePermissions('MANAGER');
    expect(perms.has('billing.manage')).toBe(false);
    expect(perms.has('menu.manage')).toBe(true);
  });

  it('applique grant et deny', () => {
    const perms = resolvePermissions('STAFF', {
      grant: ['menu.manage'],
      deny: ['payments.collect'],
    });
    expect(perms.has('menu.manage')).toBe(true);
    expect(perms.has('payments.collect')).toBe(false);
  });

  it('ignore les permissions inconnues', () => {
    const perms = resolvePermissions('STAFF', { grant: ['hack.everything'] });
    expect([...perms]).not.toContain('hack.everything');
  });

  it("n'accorde jamais billing.manage à un STAFF", () => {
    const perms = resolvePermissions('STAFF', { grant: ['billing.manage'] });
    expect(perms.has('billing.manage')).toBe(false);
  });

  it("empêche un OWNER de perdre l'accès à son équipe", () => {
    const perms = resolvePermissions('OWNER', { deny: ['team.manage'] });
    expect(perms.has('team.manage')).toBe(true);
  });
});
