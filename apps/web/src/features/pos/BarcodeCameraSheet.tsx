import { Camera, CameraOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorInstance { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> }
interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats(): Promise<string[]>;
}
type CameraWindow = Window & { BarcodeDetector?: BarcodeDetectorConstructor };
type CameraDocument = Document & {
  permissionsPolicy?: { allowsFeature(feature: string): boolean };
  featurePolicy?: { allowsFeature(feature: string): boolean };
};
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];

export function cameraUnavailableReason(): string | null {
  if (!window.isSecureContext) return 'Kamera için uygulamayı güvenli bir HTTPS bağlantısından açın.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Bu tarayıcı kamera erişimini desteklemiyor.';
  if (!(window as CameraWindow).BarcodeDetector) return 'Bu tarayıcı kamerayla barkod okumayı desteklemiyor.';
  const policy = (document as CameraDocument).permissionsPolicy ?? (document as CameraDocument).featurePolicy;
  if (policy && !policy.allowsFeature('camera')) return 'Bu sayfada kamera erişimine izin verilmiyor.';
  return null;
}

function cameraError(cause: unknown): string {
  const name = cause instanceof Error || cause instanceof DOMException ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Kamera izni verilmedi. Tarayıcının site ayarlarından izin verip yeniden deneyebilirsiniz.';
  if (name === 'NotFoundError') return 'Kullanılabilir kamera bulunamadı.';
  if (name === 'NotReadableError') return 'Kamera açılamadı. Başka bir uygulama kullanıyor olabilir.';
  return 'Kamera barkodu okuyamadı. Yeniden deneyin veya barkodu giriş alanına yazın.';
}

function CameraReader({ onDetected }: { onDetected: (barcode: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const [status, setStatus] = useState<'idle' | 'starting' | 'running'>('idle');
  const [error, setError] = useState('');
  const unavailable = cameraUnavailableReason();
  const stop = useCallback(() => {
    generation.current += 1;
    busy.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'hidden') return;
      stop();
      setStatus('idle');
    };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); stop(); };
  }, [stop]);

  const start = async () => {
    if (busy.current || unavailable) return;
    stop();
    const run = generation.current;
    busy.current = true;
    setError('');
    setStatus('starting');
    try {
      const Detector = (window as CameraWindow).BarcodeDetector!;
      const supported = await Detector.getSupportedFormats();
      if (generation.current !== run) return;
      const formats = FORMATS.filter(format => supported.includes(format));
      if (!formats.length) {
        stop(); setStatus('idle'); setError('Bu tarayıcı ürün barkodu biçimlerini desteklemiyor.'); return;
      }
      const detector = new Detector({ formats });
      const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      // İzin penceresi açıkken panel kapanabilir; geç gelen kamerayı da hemen bırakırız.
      if (generation.current !== run || !video.current) { opened.getTracks().forEach(track => track.stop()); return; }
      stream.current = opened;
      video.current.srcObject = opened;
      opened.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (generation.current !== run) return;
        stop(); setStatus('idle'); setError('Kamera bağlantısı kesildi. Yeniden başlatabilirsiniz.');
      }, { once: true }));
      await video.current.play();
      if (generation.current !== run) return;
      setStatus('running');
      const detect = async () => {
        if (generation.current !== run || !video.current) return;
        try {
          if (video.current.readyState >= 2) {
            const results = await detector.detect(video.current);
            if (generation.current !== run) return;
            const barcode = results.map(result => result.rawValue.trim()).find(value => value.length > 0 && value.length <= 80);
            if (barcode) { stop(); setStatus('idle'); onDetected(barcode); return; }
          }
          timer.current = setTimeout(() => { void detect(); }, 200);
        } catch (cause) {
          if (generation.current !== run) return;
          stop(); setStatus('idle'); setError(cameraError(cause));
        }
      };
      void detect();
    } catch (cause) {
      if (generation.current !== run) return;
      stop(); setStatus('idle'); setError(cameraError(cause));
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Barkodu kadrajın ortasına getirin. Okunan ürün sepete bir kez eklenir ve kamera kapanır.</p>
      {unavailable && <Callout title="Kamerayla okuma kullanılamıyor">{unavailable} Barkodu giriş alanına yazabilir veya barkod okuyucu kullanabilirsiniz.</Callout>}
      {error && <Callout tone="danger" title="Kamera açılamadı">{error}</Callout>}
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface-2">
        <video ref={video} autoPlay playsInline muted aria-label="Barkod kamerası" className="aspect-[4/3] w-full object-cover" />
        {status === 'running' && <div aria-hidden className="pointer-events-none absolute inset-x-[12%] inset-y-[30%] rounded-lg border-2 border-brand" />}
        {status === 'idle' && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted"><CameraOff className="size-10" /></div>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!!unavailable || status !== 'idle'} loading={status === 'starting'} onClick={() => { void start(); }}><Camera className="size-4" aria-hidden />Kamerayı başlat</Button>
        {status !== 'idle' && <Button onClick={() => { stop(); setStatus('idle'); }}>Kamerayı durdur</Button>}
      </div>
      <p role="status" className="text-sm text-muted">{status === 'starting' ? 'Kamera izni bekleniyor…' : status === 'running' ? 'Barkod aranıyor…' : 'Kamera kapalı.'}</p>
      <p className="text-xs text-muted">Kamera görüntüsü cihazınızda işlenir. Fotoğraf çekilmez ve görüntü sunucuya gönderilmez.</p>
    </div>
  );
}

export function BarcodeCameraSheet({ open, onOpenChange, onDetected }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetected: (barcode: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Kamerayla barkod okut" description="Kamerayı başlat düğmesine bastığınızda tarayıcı kamera izni ister.">
      {open && <CameraReader onDetected={barcode => { onOpenChange(false); onDetected(barcode); }} />}
    </Sheet>
  );
}
