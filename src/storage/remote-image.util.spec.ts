import { directImageUrl, isForbiddenIp } from './remote-image.util';

describe('directImageUrl', () => {
  it('réécrit les liens de partage Google Drive', () => {
    const direct =
      'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp';
    expect(
      directImageUrl(
        'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing',
      ),
    ).toBe(direct);
    expect(
      directImageUrl('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'),
    ).toBe(direct);
  });

  it('réécrit les liens Dropbox en lien brut', () => {
    expect(
      directImageUrl('https://www.dropbox.com/s/abc123/thieb.jpg?dl=0'),
    ).toBe('https://www.dropbox.com/s/abc123/thieb.jpg?raw=1');
  });

  it('laisse les autres liens intacts', () => {
    const url =
      'https://upload.wikimedia.org/wikipedia/commons/5/52/Ceebu_Jen.jpg';
    expect(directImageUrl(url)).toBe(url);
  });
});

describe('isForbiddenIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.5',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.1',
    'pas-une-ip',
  ])('refuse %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '198.35.26.112',
    '172.32.0.1',
    '2620:0:862:ed1a::1',
    '::ffff:8.8.8.8',
  ])('autorise %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(false);
  });
});
