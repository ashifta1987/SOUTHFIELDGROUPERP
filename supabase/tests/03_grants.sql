-- Special permissions: expire on their own, actions record the grant, never-grantable rights refused,
-- nobody approves their own request.
select plan(13);

create temp table s as select tests.seed() as v;
grant select on s to authenticated;

-- Admin gives the accountant back-dating, running now
select tests.login((select (v ->> 'admin')::uuid from s));
select lives_ok($$ select api.grant_special_permission(gen_random_uuid(), (select (v ->> 'acct')::uuid from s), 'entries.backdate',
  (select (v ->> 'company_a')::uuid from s), '{"books":"cash"}', now() - interval '1 hour', now() + interval '2 days', null, 'Test: October close') $$,
  'admin gives a running permission');
select throws_ok($$ select api.grant_special_permission(gen_random_uuid(), (select (v ->> 'acct')::uuid from s), 'tax.enter_without_gst',
  null, '{}', now(), now() + interval '1 day', null, 'Test: must be refused') $$, '42501', null, 'never-grantable right is refused by the RPC');
select throws_ok($$ select api.grant_special_permission(gen_random_uuid(), (select (v ->> 'acct')::uuid from s), 'entries.backdate',
  null, '{}', now(), now() + interval '30 days', null, 'Test: too long') $$, '22023', null, 'a permission longer than the limit is refused');
select throws_ok($$ select api.grant_special_permission(gen_random_uuid(), (select (v ->> 'admin')::uuid from s), 'entries.backdate',
  null, '{}', now(), now() + interval '1 day', null, 'Test: to self') $$, '42501', null, 'nobody gives a permission to themselves');
select tests.logout();

select throws_ok($$ insert into core.special_grants (code, user_id, right_key, starts_at, ends_at, reason, granted_by)
  values ('SP-X', (select (v ->> 'acct')::uuid from s), 'backup.restore', now(), now() + interval '1 hour', 'direct insert', (select (v ->> 'admin')::uuid from s)) $$,
  '42501', null, 'never-grantable right is refused even on a direct insert');

-- The accountant now holds the right, and an action under it is recorded with the grant id
select tests.login((select (v ->> 'acct')::uuid from s));
select ok(app.can((select (v ->> 'company_a')::uuid from s), 'entries.backdate'), 'accountant can back-date while the permission runs');
select isnt(app.require((select (v ->> 'company_a')::uuid from s), 'entries.backdate'), null, 'require() returns the grant id for the action');
select app.use_grant(app.require((select (v ->> 'company_a')::uuid from s), 'entries.backdate'), '{"test":"use"}');
select tests.logout();
select ok(exists (select 1 from audit.user_log l join core.special_grants g on g.id = l.grant_id
                  where l.event = 'grant_used' and g.user_id = (select (v ->> 'acct')::uuid from s)), 'the use is logged under the grant');

-- Expiry: move the window into the past (as the owner, outside the app) — the right disappears on its own
update core.special_grants set starts_at = now() - interval '3 days', ends_at = now() - interval '1 minute'
 where user_id = (select (v ->> 'acct')::uuid from s);
select tests.login((select (v ->> 'acct')::uuid from s));
select ok(not app.can((select (v ->> 'company_a')::uuid from s), 'entries.backdate'), 'the permission has expired on its own');

-- Nobody approves their own request
select lives_ok($$ select api.request_special_permission(gen_random_uuid(), 'data.export', null, '{}', now(), now() + interval '1 day', 'Test: need an export') $$,
  'accountant requests a permission');
select throws_ok($$ select api.decide_special_permission(gen_random_uuid(), (select id from core.special_grant_requests limit 1), true, null) $$,
  '42501', null, 'the requester cannot approve (no right, and it is their own request)');
select tests.logout();

select tests.login((select (v ->> 'admin')::uuid from s));
select lives_ok($$ select api.decide_special_permission(gen_random_uuid(),
  (select id from core.special_grant_requests where requested_by = (select (v ->> 'acct')::uuid from s)), true, 1) $$, 'another person (Admin) approves it');
select tests.logout();

-- Even an Admin cannot approve a request they made themselves
select tests.login((select (v ->> 'admin2')::uuid from s));
select api.request_special_permission(gen_random_uuid(), 'data.import', null, '{}', now(), now() + interval '1 day', 'Test: admin asks');
select throws_ok($$ select api.decide_special_permission(gen_random_uuid(),
  (select id from core.special_grant_requests where requested_by = (select (v ->> 'admin2')::uuid from s)), true, null) $$,
  '42501', null, 'an Admin cannot approve their own request');
select tests.logout();

select * from finish();
