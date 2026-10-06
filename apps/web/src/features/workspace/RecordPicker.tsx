import { useEffect, useState } from 'react';
import type { SearchHit } from '@erp/shared';
import { Input } from '../../components/ui/Field';
import { useCQuery } from '../../lib/queries';

export function RecordPicker({
  value,
  onChange,
  kind,
  label = 'İlgili kayıt',
}: {
  value: SearchHit | null;
  onChange: (value: SearchHit | null) => void;
  kind?: SearchHit['kind'];
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const source = useCQuery<SearchHit>(
    ['record-source', value?.kind, value?.id],
    value && !value.path ? `/api/workspace/record?kind=${value.kind}&id=${value.id}` : null,
  );
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useCQuery<{ items: SearchHit[] }>(
    ['record-search', debounced, kind],
    debounced.length >= 2
      ? `/api/workspace/search?q=${encodeURIComponent(debounced)}${kind ? `&kind=${kind}` : ''}`
      : null,
  );
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        {label}
        <Input
          aria-label={`${label} ara`}
          placeholder="Cari, fatura, proje veya sözleşme ara…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {value && (
        <div className="flex items-center justify-between rounded-lg bg-surface-2 p-2 text-sm">
          <span className="min-w-0 break-words">{source.data?.label ?? value.label}</span>
          <button type="button" onClick={() => onChange(null)}>
            Kaldır
          </button>
        </div>
      )}
      {debounced.length >= 2 && !value && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
          {results.isFetching && <p className="p-2 text-sm">Aranıyor…</p>}
          {results.isError && (
            <p role="alert" className="p-2 text-danger">
              Arama yüklenemedi.
            </p>
          )}
          {results.data?.items.length === 0 && <p className="p-2 text-sm">Kayıt bulunamadı.</p>}
          {results.data?.items
            .filter((item) => !kind || item.kind === kind)
            .map((item) => (
              <button
                type="button"
                key={`${item.kind}:${item.id}`}
                className="block w-full p-2 text-left text-sm hover:bg-surface-2"
                onClick={() => {
                  onChange(item);
                  setQuery('');
                }}
              >
                {item.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
