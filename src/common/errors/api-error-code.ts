import type { CatalogErrorCode } from '../../catalog/errors/catalog.errors';
import type { IdentityErrorCode } from '../../identity/errors/identity.errors';
import type { OrderErrorCode } from '../../orders/errors/orders.errors';
import type { PaymentErrorCode } from '../../payments/errors/payments.errors';
import type { ErrorCode } from './error-codes';

// Type-only imports: the domain modules import AppException, so a value import would be a cycle.
// A new module's code object has to be added here, or its exceptions stop compiling.
type AllErrorCodes = typeof ErrorCode &
  typeof CatalogErrorCode &
  typeof IdentityErrorCode &
  typeof OrderErrorCode &
  typeof PaymentErrorCode;

export type ApiErrorCode = AllErrorCodes[keyof AllErrorCodes];
