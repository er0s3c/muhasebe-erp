import { createContext, useContext } from 'react';

/**
 * Uygulama kabuğu (AppShell) içinde miyiz? Favori yıldızı ve son ziyaret kaydı oturum/sorgu bağlamı ister;
 * kabuk dışındaki (portal, birim testi, baskı önizleme) başlıklar bu kişisel öğeleri çizmez.
 */
export const ShellContext = createContext(false);
export const useInShell = () => useContext(ShellContext);

/**
 * Gömülü sayfa bağlamı: birleşik bir merkez sayfanın sekmesinde çizilen eski sayfa kendi başlığını h2 olarak çizer,
 * favori/son ziyaret üretmez (merkez sayfa bunları üstlenir). Sayfanın iş mantığı ve izin denetimleri aynen çalışır.
 */
export const EmbeddedContext = createContext(false);
export const useEmbedded = () => useContext(EmbeddedContext);
