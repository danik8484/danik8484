-- Migration number: 0009
-- A coordinator (רכז) is a regular team member with a board of their own, so – like an employee – they report
-- to a direct manager. Coordinators created by the first version of the role were stored without one;
-- they now report to the (first) admin. New coordinators are validated on the way in.
UPDATE users
   SET manager_id = (SELECT min(id) FROM users WHERE role = 'admin')
 WHERE role = 'coordinator' AND manager_id IS NULL;
