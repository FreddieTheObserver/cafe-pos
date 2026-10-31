import type { components } from './generated/schema';

type S = components['schemas'];

export type KdsTicket = S['KdsTicket'];
export type BoardEntry = S['BoardEntry'];
export type OrderStatus = S['OrderStatus'];
export type OrderLine = S['OrderLine'];
export type OrderDetail = S['OrderDetail'];
export type OrderSummary = S['OrderSummary'];
export type OrderView = S['OrderView'];
export type CreateOrderDto = S['CreateOrderDto'];
export type CreatePaymentDto = S['CreatePaymentDto'];
export type PaymentView = S['PaymentView'];
export type Menu = S['Menu'];
export type MenuItem = S['MenuItem'];
export type PrincipalDescription = S['PrincipalDescription'];
export type DeviceStatus = S['DeviceStatus'];
export type ActivatedDevice = S['ActivatedDevice'];
export type LoginResponse = S['LoginResponse'];
export type TokenResponse = S['TokenResponse'];
export type ProblemDetails = S['ProblemDetails'];
export type ApiErrorCode = S['ApiErrorCode'];
