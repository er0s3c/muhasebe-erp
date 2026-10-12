// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BarcodeCameraSheet } from './BarcodeCameraSheet';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key === 'common.close' ? 'Kapat' : key }) }));
let root: Root;
let host: HTMLDivElement;
let getUserMedia: ReturnType<typeof vi.fn>;
let detect: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let media: MediaStream;
let onDetected: Mock<(barcode: string) => void>;
let onOpenChange: Mock<(open: boolean) => void>;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === name)!;
const render = async (open = true) => act(async () => { root.render(<BarcodeCameraSheet open={open} onOpenChange={onOpenChange} onDetected={onDetected} />); });

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(document, 'permissionsPolicy', { configurable: true, value: undefined });
  stop = vi.fn();
  const track = { stop, addEventListener: vi.fn() } as unknown as MediaStreamTrack;
  media = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(media);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  detect = vi.fn().mockResolvedValue([]);
  class Detector {
    static getSupportedFormats = vi.fn().mockResolvedValue(['ean_13', 'code_128']);
    detect = detect;
  }
  Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: Detector });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  onDetected = vi.fn(); onOpenChange = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('POS kamera barkod okuma', () => {
  it('izin yalnız düğmeden istenir; tek okuma, kamera kapanışı ve yinelenen sonuç engeli', async () => {
    detect.mockResolvedValue([{ rawValue: ' 8691234567890 ' }, { rawValue: '8691234567890' }]);
    await render(); expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => button('Kamerayı başlat').click()); await flush();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    expect(onDetected).toHaveBeenCalledExactlyOnceWith('8691234567890');
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false); expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(detect).toHaveBeenCalledTimes(1);
  });
  it('panel kapanınca tüm görüntü izleri durur', async () => {
    await render(); await act(async () => button('Kamerayı başlat').click()); await flush();
    expect(document.querySelector('video')!.srcObject).toBe(media);
    await render(false); expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(onDetected).not.toHaveBeenCalled();
  });
  it('panel kapandıktan sonra verilen geç izin de kamerayı açık bırakmaz', async () => {
    let resolve!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise<MediaStream>(done => { resolve = done; }));
    await render(); await act(async () => button('Kamerayı başlat').click()); await flush();
    await render(false); await act(async () => resolve(media));
    expect(stop).toHaveBeenCalledTimes(1); expect(detect).not.toHaveBeenCalled();
  });
  it('sekme gizlenince kamera durur ve kendiliğinden yeniden açılmaz', async () => {
    await render(); await act(async () => button('Kamerayı başlat').click()); await flush();
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(stop).toHaveBeenCalledTimes(1); expect(button('Kamerayı başlat').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
  it.each(['insecure', 'unsupported', 'policy'] as const)('%s ortamında izin istemeden giriş alternatifi gösterilir', async kind => {
    if (kind === 'insecure') Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    if (kind === 'unsupported') Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: undefined });
    if (kind === 'policy') Object.defineProperty(document, 'permissionsPolicy', { configurable: true, value: { allowsFeature: () => false } });
    await render(); expect(button('Kamerayı başlat').disabled).toBe(true);
    expect(document.body.textContent).toContain('Barkodu giriş alanına yazabilir'); expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('reddedilen izni Türkçe açıklar ve yeniden denemeye izin verir', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await render(); await act(async () => button('Kamerayı başlat').click()); await flush();
    expect(document.body.textContent).toContain('Kamera izni verilmedi'); expect(button('Kamerayı başlat').disabled).toBe(false);
    expect(onDetected).not.toHaveBeenCalled();
  });
});
