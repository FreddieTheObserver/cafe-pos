import { en } from './messages';

export type MessageKey = keyof typeof en;
type Catalog = Record<MessageKey, string>;

const catalogs: Record<string, Catalog> = { en };
let catalog: Catalog = en;

export const setLocale = (locale: string) => {
  catalog = catalogs[locale] ?? en;
};

export const t = (
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string =>
  catalog[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in vars ? String(vars[name]) : placeholder,
  );
