import { describe, expect, it } from 'vitest';
import { LicenseTokenError, compareVersions, parseReleaseManifest, releaseFileName, signToken } from '../src';
import { makeVendor } from './helpers';

const { signer, ring } = makeVendor('r1');
const sha = 'a'.repeat(64);
const manifest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  typ: 'release',
  version: '1.2.0',
  notes: 'Yenilikler',
  publishedAt: Date.now(),
  files: [{ target: 'linux-x64', name: releaseFileName('1.2.0', 'linux-x64'), sha256: sha, size: 1000 }],
  ...over,
});

describe('sürüm manifestosu', () => {
  it('imzalı manifestoyu doğrular', () => {
    const m = parseReleaseManifest(signToken('release', manifest(), signer), ring);
    expect(m.version).toBe('1.2.0');
    expect(m.files[0]!.name).toBe('muhasebe-erp-1.2.0-linux-x64.tar.gz');
  });
  it('kira belirteci manifesto yerine geçmez (tür imzanın parçası)', () => {
    const asLease = signToken('lease', manifest(), signer);
    expect(() => parseReleaseManifest(asLease, ring)).toThrow(LicenseTokenError);
  });
  it('dosya adı sürümle uyuşmazsa reddeder', () => {
    const bad = signToken('release', manifest({ files: [{ target: 'win-x64', name: releaseFileName('1.1.0', 'win-x64'), sha256: sha, size: 5 }] }), signer);
    expect(() => parseReleaseManifest(bad, ring)).toThrow(/uyuşmuyor/);
  });
  it('sürüm karşılaştırma', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
  });
  it('sürüm karşılaştırma: SemVer ön sürüm önceliği', () => {
    // SemVer 2.0 §11 örnek sırası
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) expect(compareVersions(order[i]!, order[j]!), `${order[i]} ? ${order[j]}`).toBe(Math.sign(i - j));
    }
    expect(compareVersions('1.2.0-rc.10', '1.2.0-rc.9')).toBe(1);
    expect(compareVersions('1.2.0-rc-1', '1.2.0-rc-2')).toBe(-1);
    expect(compareVersions('1.2.0+build.5', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-rc.1', '1.1.9')).toBe(1);
  });
});
