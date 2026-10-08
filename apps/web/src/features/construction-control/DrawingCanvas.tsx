import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DrawingPin, Point } from '@erp/shared';
import { Link } from 'react-router-dom';
import { Callout } from '../../components/ui/Feedback';
GlobalWorkerOptions.workerSrc = workerUrl;

export function DrawingCanvas({
  data,
  previous,
  page = 1,
  pins = [],
  onPoint,
  onDimensions,
  points = [],
}: {
  data: Uint8Array;
  previous?: Uint8Array;
  page?: number;
  pins?: DrawingPin[];
  onPoint?: (p: Point) => void;
  onDimensions?: (width: number, height: number) => void;
  points?: Point[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(''),
    [dimensions, setDimensions] = useState({ width: 800, height: 1000 }),
    [opacity, setOpacity] = useState(0.5);
  useEffect(() => {
    let stopped = false;
    const task = getDocument({ data: data.slice() });
    const old = previous ? getDocument({ data: previous.slice() }) : null;
    void (async () => {
      try {
        const pdf = await task.promise;
        if (page > pdf.numPages) throw new Error(`Çizim ${pdf.numPages} sayfa içeriyor.`);
        const sheet = await pdf.getPage(page);
        const viewport = sheet.getViewport({ scale: 1 });
        if (stopped || !canvas.current) return;
        setDimensions({ width: viewport.width, height: viewport.height });
        onDimensions?.(viewport.width, viewport.height);
        setError('');
        const c = canvas.current;
        c.width = viewport.width;
        c.height = viewport.height;
        await sheet.render({ canvas: c, viewport }).promise;
        if (old) {
          const prev = await old.promise;
          if (page > prev.numPages) throw new Error('Önceki revizyonda bu sayfa yok.');
          const ps = await prev.getPage(page);
          if (stopped || !overlay.current) return;
          const ov = ps.getViewport({ scale: viewport.width / ps.getViewport({ scale: 1 }).width });
          const oc = overlay.current;
          oc.width = ov.width;
          oc.height = ov.height;
          await ps.render({ canvas: oc, viewport: ov }).promise;
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : 'PDF açılamadı.');
      }
    })();
    return () => {
      stopped = true;
      void task.destroy();
      void old?.destroy();
    };
  }, [data, previous, page, onDimensions]);
  return (
    <div className="space-y-3">
      {error && <Callout tone="danger">{error}</Callout>}
      {previous && (
        <label className="flex items-center gap-3 text-sm">
          Önceki revizyon görünürlüğü
          <input
            aria-label="Önceki revizyon görünürlüğü"
            type="range"
            min="0"
            max="1"
            step=".05"
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
        </label>
      )}
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-white"
        style={{ aspectRatio: `${dimensions.width}/${dimensions.height}` }}
        onClick={(e) => {
          if (!onPoint || (e.target as HTMLElement).closest('a')) return;
          const r = e.currentTarget.getBoundingClientRect();
          onPoint({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
        }}
      >
        <canvas
          ref={canvas}
          className="absolute inset-0 h-full w-full"
          aria-label={`Çizim sayfa ${page}`}
        />
        {previous && (
          <canvas
            ref={overlay}
            className="pointer-events-none absolute left-0 top-0 w-full mix-blend-multiply"
            style={{ opacity }}
          />
        )}
        {points.length > 0 && (
          <svg
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            <polyline
              points={points
                .map((p) => `${p.x * dimensions.width},${p.y * dimensions.height}`)
                .join(' ')}
              fill="none"
              stroke="#111"
              strokeWidth="2"
            />
            {points.map((p, i) => (
              <circle
                key={i}
                cx={p.x * dimensions.width}
                cy={p.y * dimensions.height}
                r="5"
                fill="#f0ed52"
                stroke="#111"
              />
            ))}
          </svg>
        )}
        {pins
          .filter((p) => p.page === page)
          .map((p, i) => (
            <Link
              key={p.id}
              to={`/workspace/operations?kind=${p.recordKind}&open=${p.recordId}`}
              title={p.label}
              aria-label={p.label}
              onClick={(e) => e.stopPropagation()}
              className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-border-strong bg-brand text-xs text-brand-contrast"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            >
              {i + 1}
            </Link>
          ))}
      </div>
      {onPoint && (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => onPoint({ x: 0.5, y: 0.5 })}
        >
          Planın ortasına işaret ekle
        </button>
      )}
    </div>
  );
}
