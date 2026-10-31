import {
  cartTotal,
  type CartLine,
  type Menu,
  type MenuEntry,
} from '@cafepos/api-client';
import { useState } from 'react';
import { formatMoney } from '../format';
import { t } from '../i18n';

interface Props {
  menu: Menu | null;
  online: boolean;
  currency: string;
  lines: readonly CartLine[];
  onPick: (entry: MenuEntry) => void;
  onViewCart: () => void;
}

export function MenuScreen({
  menu,
  online,
  currency,
  lines,
  onPick,
  onViewCart,
}: Props) {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const categories = menu?.categories.filter((c) => c.items.length > 0) ?? [];
  const current = categories.find((c) => c.id === categoryId) ?? categories[0];
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);

  return (
    <main className="menu">
      {!online && (
        <p role="status" className="banner">
          {t('menu.offline')}
        </p>
      )}
      {!menu && <p className="center muted">{t('menu.loading')}</p>}
      {menu && categories.length === 0 && (
        <p className="center muted">{t('menu.empty')}</p>
      )}
      {categories.length > 0 && (
        <nav className="tabs" aria-label={t('menu.title')}>
          {categories.map((c) => (
            <button
              key={c.id}
              aria-pressed={c.id === current?.id}
              onClick={() => setCategoryId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </nav>
      )}
      <ul className="items">
        {current?.items.map((item) => (
          <li key={item.id}>
            <button
              className="item"
              disabled={!item.isAvailable}
              onClick={() => onPick(item)}
            >
              {item.imageUrl && (
                <img src={item.imageUrl} alt="" loading="lazy" />
              )}
              <strong>{item.name}</strong>
              {item.description && <small>{item.description}</small>}
              <span className="price">
                {item.isAvailable
                  ? formatMoney(item.basePriceMinor, currency)
                  : t('menu.soldOut')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {menu && count > 0 && (
        <footer className="cartbar">
          <span>
            {count === 1 ? t('menu.itemOne') : t('menu.itemMany', { count })} -{' '}
            {formatMoney(cartTotal(menu, lines), currency)}
          </span>
          <button className="primary" onClick={onViewCart}>
            {t('menu.viewOrder')}
          </button>
        </footer>
      )}
    </main>
  );
}
