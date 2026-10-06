import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, ArrowUpRight } from 'lucide-react';
import { useCompanyApi } from '../../lib/queries';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { Callout } from '../../components/ui/Feedback';
type Answer = {
  answer: string;
  mode: string;
  asOf: string;
  remoteAvailable: boolean;
  notes: string[];
  sources: { id: string; title: string; text: string; path: string }[];
};
export function AssistantPanel({ projectId }: { projectId: string }) {
  const { call } = useCompanyApi(),
    [question, setQuestion] = useState('Bu projenin açık riskleri neler?'),
    [answer, setAnswer] = useState<Answer | null>(null),
    [remote, setRemote] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function ask() {
    setBusy(true);
    setError('');
    try {
      setAnswer(
        await call('/api/construction/assistant', {
          method: 'POST',
          body: { projectId, question, mode: remote ? 'ai' : 'local' },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-5">
      <CardHeader
        title="Kaynaklı proje asistanı"
        description="Risk, maliyet ve proje kayıtlarında yetkiniz dahilinde arama yapın."
      />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Field label="Proje sorunuz">
          {(id) => (
            <Input
              id={id}
              required
              minLength={3}
              maxLength={2000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          )}
        </Field>
        {answer?.remoteAvailable && (
          <label className="flex gap-2 text-xs text-muted">
            <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
            Erişebildiğim proje kaynaklarını yapılandırılmış dış AI hizmetine göndererek kaynak
            seçimi yap
          </label>
        )}
        <Button type="submit" disabled={busy}>
          <Sparkles className="size-4" />
          {busy ? 'Kaynaklar aranıyor…' : 'Sor'}
        </Button>
        {error && <Callout tone="danger">{error}</Callout>}
        {answer && (
          <div className="space-y-3">
            <p className="text-sm">{answer.answer}</p>
            {answer.sources.map((s) => (
              <article key={s.id} className="rounded-lg border border-border p-4">
                <Link to={s.path} className="flex items-center gap-2 text-sm font-medium">
                  {s.title}
                  <ArrowUpRight className="size-4" />
                </Link>
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted">{s.text}</p>
              </article>
            ))}
            <p className="text-xs text-muted">
              {answer.asOf} ·{' '}
              {answer.mode === 'local' ? 'Yerel kaynak araması' : 'AI kaynak seçimi'} ·{' '}
              {answer.notes.join(' ')}
            </p>
          </div>
        )}
      </form>
    </Card>
  );
}
