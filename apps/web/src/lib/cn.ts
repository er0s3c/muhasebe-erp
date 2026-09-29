import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Tasarım sistemindeki özel yazı boyutları (styles.css `--text-*`). tailwind-merge bilmezse
 * `text-heading` ile `text-warning` gibi renk sınıfını çakışıyor sanıp birini siler.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'subheading', 'heading-sm', 'heading', 'heading-lg', 'display'] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
