-- Run after a load test: every query must return no rows.
--   docker exec -i cafepos-postgres psql -U cafepos -d cafepos -v ON_ERROR_STOP=1 < ops/load/verify.sql
-- Each is an invariant the state machine or the money rules promise; the
-- constraints enforce some already, and this checks they held under load.

\echo '1. Two orders sharing a queue number on one business day'
select business_day, order_number, count(*)
from orders
where order_number is not null
group by 1, 2
having count(*) > 1;

\echo '2. A history step the state machine does not allow (section 4.4)'
select h.order_id, h.from_status, h.to_status
from order_status_history h
where h.from_status is not null
  and (h.from_status, h.to_status) not in (
    values
      ('DRAFT', 'PENDING_PAYMENT'), ('DRAFT', 'CANCELLED'),
      ('PENDING_PAYMENT', 'PAID'), ('PENDING_PAYMENT', 'EXPIRED'),
      ('PENDING_PAYMENT', 'CANCELLED'),
      ('PAID', 'IN_PREPARATION'), ('PAID', 'REFUNDED'),
      ('IN_PREPARATION', 'READY'), ('IN_PREPARATION', 'REFUNDED'),
      ('READY', 'COMPLETED'), ('READY', 'REFUNDED'),
      ('COMPLETED', 'REFUNDED')
  );

\echo '3. An order whose status is not where its history says it went'
select o.id, o.status, last.to_status
from orders o
join lateral (
  select to_status from order_status_history h
  where h.order_id = o.id
  order by h.created_at desc, h.id desc
  limit 1
) last on true
where last.to_status <> o.status;

\echo '4. A paid-or-later order with no succeeded payment'
select o.id, o.status
from orders o
where o.status in ('PAID', 'IN_PREPARATION', 'READY', 'COMPLETED')
  and not exists (
    select 1 from payments p
    where p.order_id = o.id and p.status = 'SUCCEEDED'
  );

\echo '5. An order with more than one live payment'
select order_id, count(*)
from payments
where status in ('PENDING', 'PROCESSING')
group by order_id
having count(*) > 1;

\echo '6. A cancelled or expired order whose payment is still live'
select o.id, o.status, p.status as payment_status
from orders o
join payments p on p.order_id = o.id
where o.status in ('CANCELLED', 'EXPIRED')
  and p.status in ('PENDING', 'PROCESSING');
