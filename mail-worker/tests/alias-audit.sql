-- Read-only inventory. Run against a backed-up D1/SQLite database.
-- Do NOT automatically transfer historical messages or delete accounts.
SELECT
  a.account_id AS alias_account_id,
  a.email AS alias_email,
  a.user_id AS alias_user_id,
  a.is_del AS alias_deleted,
  b.account_id AS base_account_id,
  b.email AS base_email,
  b.user_id AS base_user_id,
  b.is_del AS base_deleted,
  CASE WHEN b.account_id IS NULL THEN 'orphan'
       WHEN a.user_id <> b.user_id THEN 'cross-user'
       WHEN b.is_del = 1 THEN 'deleted-base'
       ELSE 'same-owner' END AS ownership_status
FROM account a
LEFT JOIN account b ON b.email = (
  substr(a.email, 1, instr(a.email, '+') - 1) || substr(a.email, instr(a.email, '@'))
) COLLATE NOCASE
WHERE instr(substr(a.email, 1, instr(a.email, '@') - 1), '+') > 0
ORDER BY ownership_status, alias_email;

-- Independent user identities containing + require manual ownership review.
SELECT user_id, email, is_del FROM user
WHERE instr(substr(email, 1, instr(email, '@') - 1), '+') > 0;

-- OAuth identity duplication must be resolved before the unique index migration.
SELECT platform, oauth_user_id, count(*) AS count,
       group_concat(oauth_id) AS oauth_ids, group_concat(user_id) AS user_ids
FROM oauth
GROUP BY platform, oauth_user_id
HAVING count(*) > 1;
