const NOT_METRICS = new Set([
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'and',
  'or',
  'unless',
  'bool',
  'offset',
  'inf',
  'nan',
]);

/**
 * The metric names a PromQL expression reads.
 *
 * Good enough for the expressions this repository writes, not a parser: label
 * matchers, ranges, grouping clauses and string literals are removed, and what
 * is left that is neither a function call nor a keyword is a metric.
 */
export function metricNamesIn(expr: string): string[] {
  const bare = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(
      /\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g,
      '',
    );

  const names = new Set<string>();
  for (const match of bare.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) {
    const token = match[0];
    const rest = bare.slice((match.index ?? 0) + token.length).trimStart();
    if (rest.startsWith('(') || NOT_METRICS.has(token.toLowerCase())) continue;
    names.add(token);
  }
  return [...names];
}
