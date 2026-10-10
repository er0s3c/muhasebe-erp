export interface NavHelpEntry {
  title: string;
  description: string;
  /** Bölüm rehberlerinde örnek isteğe bağlıdır. */
  example?: string;
}

export interface HelpData {
  NAV_GROUP_HELP: Record<string, NavHelpEntry>;
  NAV_ITEM_HELP: Record<string, NavHelpEntry>;
}

let helpData: Promise<HelpData> | null = null;

/** Rehber metinleri (~50 KB) yalnız bir "i" ilk kez açıldığında ya da üzerine gelindiğinde indirilir. */
export function loadHelpData(): Promise<HelpData> {
  helpData ??= import('./navHelpData').catch((error: unknown) => {
    helpData = null;
    throw error;
  });
  return helpData;
}
