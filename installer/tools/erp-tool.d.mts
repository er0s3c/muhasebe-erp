export function urlEncode(s: string): string;
export function buildSmtpUrl(o: { host: string; port: string | number; security: string; user?: string; pass?: string }): string;
export function scrub(text: unknown, secrets?: string[]): string;
export function explainSmtpError(err: unknown): string;
export function smtpTest(o: { url: string; from: string; to: string; modulesDir?: string; timeoutMs?: number }): Promise<void>;
export function parsePemCerts(pem: string): import('node:crypto').X509Certificate[];
export function checkCert(o: { certPem: string; keyPem: string; domain?: string; minDays?: number; now?: Date }): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
};
