import {
  MAX_QUANTITY,
  cartIssues,
  cartTotal,
  findEntry,
  setQuantity,
  type CartIssue,
  type CartLine,
  type Menu,
} from '@cafepos/api-client';
import { formatMoney } from '../format';
import { t } from '../i18n';

interface Props {
  menu: Menu;
  lines: readonly CartLine[];
  currency: string;
  notice: string | null;
  placing: boolean;
  onChange: (lines: CartLine[]) => void;
  onDropUnsellable: () => void;
  onBack: () => void;
  onPay: () => void;
}

const issueText = (
  menu: Menu,
  lines: readonly CartLine[],
  issue: CartIssue,
): string => {
  const line = lines.find((l) => l.key === issue.lineKey);
  const name = (line && findEntry(menu, line.menuItemId)?.name) ?? '';
  switch (issue.kind) {
    case 'item-gone':
      return t('cart.issue.gone', { name });
    case 'item-unavailable':
      return t('cart.issue.unavailable', { name });
    case 'option-unavailable':
      return t('cart.issue.option', { name });
    default:
      return t('cart.issue.selection', { name });
  }
};

export function CartScreen({
  menu,
  lines,
  currency,
  notice,
  placing,
  onChange,
  onDropUnsellable,
  onBack,
  onPay,
}: Props) {
  const issues = cartIssues(menu, lines);
  const total = cartTotal(menu, lines);

  return (
    <main className="panel">
      <h1>{t('cart.title')}</h1>
      {lines.length === 0 && <p className="muted">{t('cart.empty')}</p>}
      <ul className="lines">
        {lines.map((line) => {
          const entry = findEntry(menu, line.menuItemId);
          const chosen = entry?.optionGroups
            .flatMap((g) => g.options)
            .filter((o) => line.optionIds.includes(o.id))
            .map((o) => o.name);
          return (
            <li key={line.key}>
              <div className="grow">
                <strong>{entry?.name ?? ''}</strong>
                {chosen && chosen.length > 0 && (
                  <small>{chosen.join(', ')}</small>
                )}
              </div>
              <div className="stepper">
                <button
                  aria-label={t('cart.decrease')}
                  onClick={() =>
                    onChange(setQuantity(lines, line.key, line.quantity - 1))
                  }
                >
                  -
                </button>
                <output>{line.quantity}</output>
                <button
                  aria-label={t('cart.increase')}
                  disabled={line.quantity >= MAX_QUANTITY}
                  onClick={() =>
                    onChange(setQuantity(lines, line.key, line.quantity + 1))
                  }
                >
                  +
                </button>
              </div>
              <button onClick={() => onChange(setQuantity(lines, line.key, 0))}>
                {t('cart.remove')}
              </button>
            </li>
          );
        })}
      </ul>
      {issues.length > 0 && (
        <div role="alert" className="error">
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issueText(menu, lines, issue)}</li>
            ))}
          </ul>
          <button onClick={onDropUnsellable}>
            {t('cart.removeUnavailable')}
          </button>
        </div>
      )}
      {notice && (
        <p role="alert" className="error">
          {notice}
        </p>
      )}
      <p className="total">
        {t('cart.total')}: <strong>{formatMoney(total, currency)}</strong>
      </p>
      <div className="actions">
        <button onClick={onBack}>{t('common.back')}</button>
        <button
          className="primary"
          disabled={lines.length === 0 || issues.length > 0 || placing}
          onClick={onPay}
        >
          {placing
            ? t('cart.paying')
            : t('cart.pay', { total: formatMoney(total, currency) })}
        </button>
      </div>
    </main>
  );
}
