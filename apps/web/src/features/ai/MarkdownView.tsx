import type { ReactNode } from 'react';

interface MarkdownViewProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

/**
 * Satır içi Markdown ayrıştırıcı (Kalın, İtalik, Satır içi Kod).
 * XSS riskini önlemek için tamamen yerel React düğümleri üretir (dangerouslySetInnerHTML kullanmaz).
 */
function renderInline(text: string): ReactNode[] {
  // Regex: **kalın**, *italik*, `kod`
  const regex = /(\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
  const parts = text.split(regex);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={index} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={index} className="italic text-text/90">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={index}
          className="rounded border border-border/60 bg-surface px-1.5 py-0.5 text-xs font-mono text-text [overflow-wrap:anywhere]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/**
 * Blok Markdown ayrıştırıcı (Başlıklar, Listeler, Alıntılar, Çizgiler, Paragraflar).
 */
export function MarkdownView({ content, className = '', isStreaming = false }: MarkdownViewProps) {
  const lines = content.split('\n');
  const elements: ReactNode[] = [];

  let listBuffer: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quoteBuffer: string[] = [];

  const flushList = (key: string) => {
    if (!listBuffer) return;
    if (listBuffer.type === 'ul') {
      elements.push(
        <ul key={key} className="my-2 space-y-1.5 pl-1 text-text/90">
          {listBuffer.items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
              <span className="flex-1 leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ul>,
      );
    } else {
      elements.push(
        <ol key={key} className="my-2 space-y-1.5 pl-1 text-text/90">
          {listBuffer.items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className="font-mono text-xs font-medium text-muted">{idx + 1}.</span>
              <span className="flex-1 leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ol>,
      );
    }
    listBuffer = null;
  };

  const flushQuote = (key: string) => {
    if (quoteBuffer.length === 0) return;
    elements.push(
      <blockquote
        key={key}
        className="my-2.5 rounded-r-lg border-l-3 border-brand bg-surface/60 py-2 pl-3.5 pr-3 text-xs leading-relaxed text-text/90"
      >
        {quoteBuffer.map((qLine, idx) => (
          <p key={idx} className={idx > 0 ? 'mt-1' : ''}>
            {renderInline(qLine)}
          </p>
        ))}
      </blockquote>,
    );
    quoteBuffer = [];
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // Liste kontrolü: bullet (* veya -)
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushQuote(`q-${index}`);
      if (!listBuffer || listBuffer.type !== 'ul') {
        flushList(`prev-list-${index}`);
        listBuffer = { type: 'ul', items: [] };
      }
      listBuffer.items.push(bulletMatch[1] ?? '');
      return;
    }

    // Liste kontrolü: numaralı (1. 2. vb.)
    const numberMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numberMatch) {
      flushQuote(`q-${index}`);
      if (!listBuffer || listBuffer.type !== 'ol') {
        flushList(`prev-list-${index}`);
        listBuffer = { type: 'ol', items: [] };
      }
      listBuffer.items.push(numberMatch[1] ?? '');
      return;
    }

    // Liste dışı satır geldiğinde mevcut listeyi boşalt
    flushList(`list-${index}`);

    // Alıntı kontrolü (> ...)
    if (trimmed.startsWith('>')) {
      quoteBuffer.push(trimmed.replace(/^>\s*/, ''));
      return;
    }
    flushQuote(`quote-${index}`);

    // Yatay Çizgi (--- veya ***)
    if (trimmed === '---' || trimmed === '***') {
      elements.push(<hr key={`hr-${index}`} className="my-3 border-border" />);
      return;
    }

    // Başlık 3 (###)
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h4
          key={`h3-${index}`}
          className="mt-3.5 mb-1.5 text-sm font-semibold text-text tracking-tight"
        >
          {renderInline(trimmed.slice(4))}
        </h4>,
      );
      return;
    }

    // Başlık 2 (##)
    if (trimmed.startsWith('## ')) {
      elements.push(
        <h3
          key={`h2-${index}`}
          className="mt-4 mb-2 text-base font-bold text-text tracking-tight"
        >
          {renderInline(trimmed.slice(3))}
        </h3>,
      );
      return;
    }

    // Başlık 1 (#)
    if (trimmed.startsWith('# ')) {
      elements.push(
        <h2
          key={`h1-${index}`}
          className="mt-4 mb-2 text-lg font-bold text-text tracking-tight"
        >
          {renderInline(trimmed.slice(2))}
        </h2>,
      );
      return;
    }

    // Boş satır
    if (!trimmed) {
      elements.push(<div key={`empty-${index}`} className="h-2" />);
      return;
    }

    // Normal Paragraf
    elements.push(
      <p key={`p-${index}`} className="leading-relaxed">
        {renderInline(line)}
      </p>,
    );
  });

  flushList(`final-list`);
  flushQuote(`final-quote`);

  return (
    <div className={`space-y-1 text-sm ${className}`}>
      {elements}
      {isStreaming && (
        <span
          className="inline-block ml-0.5 h-4 w-1.5 animate-pulse bg-brand align-middle"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
