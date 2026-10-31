import {
  MAX_QUANTITY,
  defaultOptionIds,
  unitPrice,
  type CartLine,
  type MenuEntry,
} from '@cafepos/api-client';
import { useState } from 'react';
import { formatMoney } from '../format';
import { t } from '../i18n';

type Group = MenuEntry['optionGroups'][number];

interface Props {
  entry: MenuEntry;
  currency: string;
  onAdd: (line: Omit<CartLine, 'key'>) => void;
  onClose: () => void;
}

const countIn = (group: Group, ids: readonly string[]) =>
  group.options.filter((o) => ids.includes(o.id)).length;

export function ItemSheet({ entry, currency, onAdd, onClose }: Props) {
  const [optionIds, setOptionIds] = useState(() => defaultOptionIds(entry));
  const [quantity, setQuantity] = useState(1);

  const valid = entry.optionGroups.every((g) => {
    const n = countIn(g, optionIds);
    return n >= g.minSelect && n <= g.maxSelect;
  });

  const toggle = (group: Group, optionId: string) =>
    setOptionIds((ids) => {
      const selected = ids.includes(optionId);
      if (group.maxSelect === 1) {
        const others = ids.filter(
          (id) => !group.options.some((o) => o.id === id),
        );
        return selected && group.minSelect === 0
          ? others
          : [...others, optionId];
      }
      return selected
        ? ids.filter((id) => id !== optionId)
        : [...ids, optionId];
    });

  const rule = (g: Group) =>
    g.minSelect > 0
      ? t('item.required')
      : g.maxSelect > 1
        ? t('item.chooseUpTo', { max: g.maxSelect })
        : '';

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={entry.name}
    >
      <div className="sheet">
        <header>
          <h2>{entry.name}</h2>
          <button onClick={onClose}>{t('item.close')}</button>
        </header>
        {entry.description && <p className="muted">{entry.description}</p>}
        {entry.optionGroups.map((g) => (
          <fieldset key={g.id}>
            <legend>
              {g.name} <small>{rule(g)}</small>
            </legend>
            {g.options.map((o) => {
              const selected = optionIds.includes(o.id);
              const full =
                !selected &&
                g.maxSelect > 1 &&
                countIn(g, optionIds) >= g.maxSelect;
              return (
                <label key={o.id} className="option">
                  <input
                    type={g.maxSelect === 1 ? 'radio' : 'checkbox'}
                    name={g.id}
                    checked={selected}
                    disabled={!o.isAvailable || full}
                    onChange={() => toggle(g, o.id)}
                    onClick={() =>
                      g.maxSelect === 1 && selected && toggle(g, o.id)
                    }
                  />
                  <span>{o.name}</span>
                  <span className="muted">
                    {o.isAvailable
                      ? o.priceDeltaMinor !== 0
                        ? `${o.priceDeltaMinor > 0 ? '+' : '-'}${formatMoney(Math.abs(o.priceDeltaMinor), currency)}`
                        : ''
                      : t('item.unavailable')}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
        <div className="stepper" role="group" aria-label={t('item.quantity')}>
          <button
            aria-label={t('cart.decrease')}
            disabled={quantity <= 1}
            onClick={() => setQuantity((q) => q - 1)}
          >
            -
          </button>
          <output>{quantity}</output>
          <button
            aria-label={t('cart.increase')}
            disabled={quantity >= MAX_QUANTITY}
            onClick={() => setQuantity((q) => q + 1)}
          >
            +
          </button>
        </div>
        <button
          className="primary"
          disabled={!valid}
          onClick={() => onAdd({ menuItemId: entry.id, quantity, optionIds })}
        >
          {t('item.add')} -{' '}
          {formatMoney(unitPrice(entry, optionIds) * quantity, currency)}
        </button>
      </div>
    </div>
  );
}
