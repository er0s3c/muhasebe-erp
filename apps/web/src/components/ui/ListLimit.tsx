import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Callout } from './Feedback';

/** Sunucu liste sayfası (API-7): varsayılan 500, "daha fazla" ile ikiye katlanır, en çok 2000 (sunucu sınırı). */
export const LIST_PAGE = 500;
export const LIST_MAX = 2000;

/** Liste sınırı; süzgeç (`resetKey`) değişince başa döner. */
export function useListLimit(resetKey: string, page = LIST_PAGE, max = LIST_MAX) {
  const [state, setState] = useState({ key: resetKey, limit: page });
  const limit = state.key === resetKey ? state.limit : page;
  return {
    limit,
    atMax: limit >= max,
    more: () => setState({ key: resetKey, limit: Math.min(max, limit * 2) }),
  };
}

/** Sunucu listeyi kırptıysa (`truncated`) bilgi ve "daha fazla göster" düğmesi. */
export function TruncatedNote({ truncated, shown, onMore, atMax }: { truncated?: boolean; shown: number; onMore?: () => void; atMax?: boolean }) {
  const { t } = useTranslation();
  if (!truncated) return null;
  const canMore = !!onMore && !atMax;
  return (
    <Callout
      tone="info"
      action={
        canMore ? (
          <Button size="sm" onClick={onMore}>
            {t('common.showMore')}
          </Button>
        ) : undefined
      }
    >
      {t(canMore ? 'common.truncated' : 'common.truncatedNarrow', { count: shown })}
    </Callout>
  );
}
