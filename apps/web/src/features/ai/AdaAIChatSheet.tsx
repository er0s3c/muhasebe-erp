import {
  Bot,
  Send,
  Sparkles,
  Trash2,
  AlertCircle,
  HelpCircle,
  Loader2,
  Square,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { MarkdownView } from './MarkdownView';

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  time: string;
  isStreaming?: boolean;
}

interface AdaAIChatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STARTER_PROMPTS = [
  'Kritik stokları listele',
  'Kasa ve banka bakiyelerimi göster',
  'Vadesi geçmiş alacak ve borçlar neler?',
  'Aktif projeleri ve durumlarını listele',
  'Son kesilen faturaları özetle',
  'Onay bekleyen belgeler var mı?',
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AdaAIChatSheet({ open, onOpenChange }: AdaAIChatSheetProps) {
  const { activeCompany, user } = useSession();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'model',
      text: `Merhaba${user?.fullName ? ` ${user.fullName}` : ''}! Ben Ada AI, Ada ERP akıllı asistanınızım. Muhasebe, finans, stok, cari, şantiye veya üretim verileriniz hakkında sormak istediğiniz soruları yanıtlayabilirim.`,
      time: formatTime(new Date()),
      isStreaming: false,
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const completeTextRef = useRef<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  // Yeni mesaj veya yazma akışında otomatik aşağı kaydır
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, isTyping]);

  // Bileşen kapandığında aktif animasyonu temizle
  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      if (streamIntervalRef.current) {
        clearInterval(streamIntervalRef.current);
      }
    };
  }, []);

  const stopTyping = () => {
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current);
      streamIntervalRef.current = null;
      setIsTyping(false);
      setMessages((prev) =>
        prev.map((m) => (m.isStreaming ? { ...m, text: completeTextRef.current?.id === m.id ? completeTextRef.current.text : m.text, isStreaming: false } : m)),
      );
    }
  };

  const startTypewriter = (msgId: string, fullText: string) => {
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current);
    }

    setIsTyping(true);
    completeTextRef.current = { id: msgId, text: fullText };
    let charIndex = 0;
    // Hızlı ve akıcı daktilo efekti: 0.4 - 0.7 saniyede tamamlanır
    const step = Math.max(8, Math.ceil(fullText.length / 30));

    const interval = setInterval(() => {
      charIndex += step;
      if (charIndex >= fullText.length) {
        charIndex = fullText.length;
        clearInterval(interval);
        streamIntervalRef.current = null;
        setIsTyping(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, text: fullText, isStreaming: false } : m,
          ),
        );
      } else {
        const partial = fullText.slice(0, charIndex);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, text: partial, isStreaming: true } : m,
          ),
        );
      }
    }, 16);

    streamIntervalRef.current = interval;
  };

  const sendMessage = async (textToSend?: string) => {
    const text = (textToSend ?? input).trim();
    if (!text || loading || isTyping || !activeCompany) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      time: formatTime(new Date()),
      isStreaming: false,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setError(null);
    setLoading(true);
    const controller = new AbortController();
    requestRef.current = controller;

    try {
      // API'ye son en fazla 6 geçmiş mesajı gönder (karşılama hariç)
      const historyPayload = messages
        .filter((m) => m.id !== 'welcome')
        .slice(-6)
        .map((m) => ({
          role: m.role,
          text: m.text.slice(0, 4000),
        }));

      const res = await api<{ success: boolean; answer?: string; error?: string }>(
        '/api/ai/chat',
        {
          method: 'POST',
          body: {
            message: text,
            history: historyPayload,
          },
          companyId: activeCompany.id,
          signal: controller.signal,
        },
      );

      if (controller.signal.aborted) return;
      if (res.success && res.answer) {
        const aiMessageId = crypto.randomUUID();
        const aiTime = formatTime(new Date());

        // Boş metinle mesajı ekle ve canlı yazma akışını başlat
        setMessages((prev) => [
          ...prev,
          {
            id: aiMessageId,
            role: 'model',
            text: '',
            time: aiTime,
            isStreaming: true,
          },
        ]);
        setLoading(false);
        startTypewriter(aiMessageId, res.answer);
      } else {
        setError(res.error || 'Ada AI yanıt veremedi.');
        setLoading(false);
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Sunucu bağlantısı sırasında bir hata oluştu.');
      }
      setLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const clearHistory = () => {
    requestRef.current?.abort();
    setLoading(false);
    stopTyping();
    setMessages([
      {
        id: 'welcome',
        role: 'model',
        text: 'Sohbet temizlendi. Size nasıl yardımcı olabilirim?',
        time: formatTime(new Date()),
        isStreaming: false,
      },
    ]);
    setError(null);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) stopTyping();
        onOpenChange(nextOpen);
      }}
      title="Ada AI Asistanı"
      description={activeCompany?.name ?? 'Ada ERP'}
      contentClassName="flex flex-col overflow-hidden px-3 py-3 sm:px-6"
      wide
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* Üst Eylemler & Bilgi */}
        <div className="flex items-center justify-between border-b border-border pb-2 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-brand" />
            <span>Ada ERP asistanı</span>
          </div>
          <div className="flex items-center gap-2">
            {isTyping && (
              <button
                type="button"
                onClick={stopTyping}
                className="flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-xs text-text hover:bg-surface-3 transition-colors"
                title="Yazmayı durdur ve metnin tamamını göster"
              >
                <Square className="size-2.5 fill-current" />
                <span>Tamamla</span>
              </button>
            )}
            <button
              type="button"
              onClick={clearHistory}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-text"
              title="Sohbeti temizle"
            >
              <Trash2 className="size-3" />
              <span>Temizle</span>
            </button>
          </div>
        </div>

        {/* Mesaj Listesi */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-2 text-sm"
          aria-live="polite"
        >
          {messages.map((m) => {
            const isUser = m.role === 'user';
            return (
              <div
                key={m.id}
                className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {!isUser && (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-contrast shadow-sm mt-0.5">
                    <Bot className="size-4" />
                  </div>
                )}
                <div
                  className={`min-w-0 max-w-[88%] break-words rounded-2xl px-4 py-3 leading-relaxed transition-all ${
                    isUser
                      ? 'bg-brand text-brand-contrast'
                      : 'border border-border/80 bg-surface-2 text-text'
                  }`}
                >
                  {isUser ? (
                    <div className="whitespace-pre-wrap">{m.text}</div>
                  ) : (
                    <MarkdownView content={m.text} isStreaming={m.isStreaming} />
                  )}
                  <div
                    className={`mt-1.5 text-right text-[12px] ${
                      isUser ? 'text-brand-contrast/70' : 'text-muted'
                    }`}
                  >
                    {m.time}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-contrast mt-0.5">
                <Bot className="size-4" />
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface-2 px-4 py-3 text-xs text-muted shadow-sm">
                <Loader2 className="size-3.5 animate-spin text-brand" />
                <span>Ada AI düşünüyor...</span>
              </div>
            </div>
          )}

          {error && (
            <Callout tone="danger" title="Hata">
              <div className="flex items-start gap-2">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <div>
                  <p>{error}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => void sendMessage(messages[messages.length - 1]?.text)}
                  >
                    Tekrar Dene
                  </Button>
                </div>
              </div>
            </Callout>
          )}
        </div>

        {/* Başlangıç Soru Önerileri (Yalnızca tek karşılama mesajı varken göster) */}
        {messages.length === 1 && (
          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center gap-1 text-[12px] font-medium text-muted">
              <HelpCircle className="size-3" />
              <span>Örnek sorular:</span>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => void sendMessage(prompt)}
                  className="rounded-lg border border-border bg-surface p-2 text-left text-xs text-text transition-colors hover:border-brand hover:bg-surface-2"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Giriş Alanı */}
        <div className="border-t border-border pt-2">
          <div className="relative flex items-end gap-2 rounded-xl border border-border bg-bg p-1.5 focus-within:border-brand">
            <textarea
              ref={textareaRef}
              rows={2}
              aria-label="Asistana sorunuz"
              maxLength={2000}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ada ERP hakkında bir soru sorun... (Göndermek için Enter)"
              disabled={loading || isTyping}
              className="min-h-[44px] max-h-32 flex-1 resize-none bg-transparent px-2.5 py-1 text-sm text-text outline-none placeholder:text-muted disabled:opacity-60"
            />
            <Button
              size="sm"
              disabled={!input.trim() || loading || isTyping}
              onClick={() => void sendMessage()}
              className="shrink-0"
              aria-label="Gönder"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
          <div className="mt-1 flex items-center justify-between px-1 text-[12px] text-muted">
            <span>Shift + Enter: Yeni satır</span>
            <span>Ada AI finansal tavsiye vermez.</span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
