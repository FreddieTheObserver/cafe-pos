// js-yaml ships no types; this declares the one function the metrics suite reads the alert rules with.
declare module 'js-yaml' {
  export function load(input: string): unknown;
}
