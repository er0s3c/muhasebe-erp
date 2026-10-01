/** Bellekteki dosyayı tarayıcıya kaydettirir (kimlikli istekle alınan blob için). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Hemen iptal edilen nesne URL'si Chromium'da indirmeyi yarıda kesebilir; indirme başladıktan sonra serbest bırakılır.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
