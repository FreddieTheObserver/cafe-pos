import { readReturnTypes, refOf } from './response-types';

describe('refOf', () => {
  it.each([
    ['Promise<OrderView>', { kind: 'type', name: 'OrderView', array: false }],
    ['OrderView', { kind: 'type', name: 'OrderView', array: false }],
    ['Promise<Category[]>', { kind: 'type', name: 'Category', array: true }],
    ['Promise<void>', { kind: 'none' }],
    ['void', { kind: 'none' }],
    [
      'Promise<{ received: true }>',
      { kind: 'unnamed', text: '{ received: true }' },
    ],
    [
      'Promise<TokenResponse & { user: X }>',
      { kind: 'unnamed', text: 'TokenResponse & { user: X }' },
    ],
    ['Promise<Page<Order>>', { kind: 'unnamed', text: 'Page<Order>' }],
    [undefined, { kind: 'missing' }],
  ])('reads %p', (annotation, expected) => {
    expect(refOf(annotation)).toEqual(expected);
  });
});

describe('readReturnTypes', () => {
  const found = readReturnTypes('src');

  it('reads the declared return type of real controller methods', () => {
    expect(found.get('OrdersController.create')).toEqual({
      kind: 'type',
      name: 'OrderView',
      array: false,
    });
    expect(found.get('CategoriesController.list')).toEqual({
      kind: 'type',
      name: 'Category',
      array: true,
    });
    expect(found.get('AuthController.logout')).toEqual({ kind: 'none' });
  });

  it('leaves no controller method with an unnamed return type', () => {
    const unnamed = [...found].filter(
      ([, ref]) => ref.kind === 'unnamed' || ref.kind === 'missing',
    );
    expect(unnamed.map(([key]) => key).sort()).toEqual([]);
  });
});
