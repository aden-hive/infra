-- +goose Up
-- +goose StatementBegin

-- Hive override: e2b's upstream default is `max_length_hours = 1`, set
-- by 20240219190940_add_max_length_hours.sql. That hard-caps every
-- sandbox at 1 hour of running time — refreshTimeout's KeepAliveFor
-- (packages/api/internal/orchestrator/keep_alive.go) returns
-- errMaxInstanceLengthExceeded once a sandbox crosses the cap, the
-- evictor (packages/api/internal/orchestrator/evictor/evict.go) then
-- pauses or kills, and the user has to manually Resume.
--
-- Hive's workspace VMs are long-lived per-team persistent VMs (the
-- /root/.hive volume holds the user's queens/colonies/memories — see
-- account-vm.service.ts in hive-backend). A 1-hour cap turns into
-- "every hour the cloud colony disconnects with 502s" — exactly the
-- failure pattern the user was hitting.
--
-- 24 hours matches the streamToken TTL and covers any realistic
-- single-session usage; the persistent volume keeps state across the
-- inevitable nightly pause/resume cycle. Don't go higher without
-- thinking about snapshot churn: every paused sandbox holds a memory
-- snapshot until next resume.
--
-- Idempotent: only updates rows still at the upstream 1-hour default,
-- so re-running this migration on a DB that's been manually adjusted
-- won't clobber an operator's deliberate override.
UPDATE "public"."tiers"
   SET "max_length_hours" = 24
 WHERE "max_length_hours" = 1;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Revert to upstream default. Safe to run; restores the 1-hour cap.
UPDATE "public"."tiers"
   SET "max_length_hours" = 1
 WHERE "max_length_hours" = 24;

-- +goose StatementEnd
