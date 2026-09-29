import { Power, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation } from '../../lib/queries';
import { useCategories } from './common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Stok kategorileri: ekle, pasifleştir, sil (kartı olan kategori silinemez). */
export function CategoriesSheet({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data } = useCategories();
  const [name, setName] = useState('');
  const inval = [['item-categories'], ['items']];

  const add = useCMutation((v: string, call) => call('/api/item-categories', { method: 'POST', body: { name: v } }), inval);
  const toggle = useCMutation((v: { id: string; isActive: boolean }, call) => call(`/api/item-categories/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }), inval);
  const remove = useCMutation((id: string, call) => call(`/api/item-categories/${id}`, { method: 'DELETE' }), inval);

  const submit = () => {
    const value = name.trim();
    if (value.length < 2) return;
    add.mutate(value, {
      onSuccess: () => {
        toast.success(t('inventory.items.categories.added'));
        setName('');
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('inventory.items.categories.title')}>
      <form
        className="mb-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('inventory.items.categories.name')} aria-label={t('inventory.items.categories.name')} maxLength={80} />
        <Button type="submit" variant="primary" loading={add.isPending} disabled={name.trim().length < 2}>
          {t('inventory.items.categories.add')}
        </Button>
      </form>
      {!data?.categories.length ? (
        <p className="py-6 text-center text-sm text-muted">{t('inventory.items.categories.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.categories.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className={c.isActive ? 'font-medium' : 'font-medium text-muted line-through'}>{c.name}</p>
                <p className="text-xs text-muted">{t('inventory.items.categories.itemCount', { count: c.itemCount })}</p>
              </div>
              {!c.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
              <Button
                size="sm"
                variant="ghost"
                aria-label={c.isActive ? t('inventory.detail.deactivate') : t('inventory.detail.activate')}
                onClick={() => toggle.mutate({ id: c.id, isActive: !c.isActive }, { onSuccess: () => toast.success(t('inventory.items.categories.updated')), onError: (e) => toast.error(errorMessage(e)) })}
              >
                <Power className="size-3.5" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('common.delete')}
                onClick={() => remove.mutate(c.id, { onSuccess: () => toast.success(t('inventory.items.categories.deleted')), onError: (e) => toast.error(errorMessage(e)) })}
              >
                <Trash2 className="size-3.5 text-danger" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
