-- Every row belongs to one m3 account.
--
-- Until now the runs table was shared: one token, embedded in the public bundle, read and wrote
-- every row. A capture carries the VIN, the AIF and the flash counter of a specific car, so rows
-- are now owned, and the API puts `owner = ?` on every statement (functions/_shared.ts).
--
-- The column is added nullable because SQLite cannot add a NOT NULL column without a default, and
-- a default owner would be a lie waiting to happen. The rows already here were all taken by the
-- operator, on the operator's own car, so they are given to the operator's account; after that
-- the trigger refuses any row that arrives without an owner.

ALTER TABLE runs ADD COLUMN owner TEXT;

UPDATE runs SET owner = 'ac5c6c31-5137-4fd7-9b5d-ceb17f98027c' WHERE owner IS NULL;

CREATE TRIGGER IF NOT EXISTS runs_owner_required
BEFORE INSERT ON runs
WHEN NEW.owner IS NULL
BEGIN
    SELECT RAISE(ABORT, 'runs.owner is required');
END;

-- The listing's only query: one owner's runs, newest first.
CREATE INDEX IF NOT EXISTS runs_owner_created_at ON runs (owner, created_at DESC);

-- A failure, recorded when it happens, whether or not a capture exists.
--
-- The failures most worth reading - a refused login, a cable that never opened, a pass that died
-- part way - happen before there is a capture to attach a log to. The app sends one of these by
-- itself for each, so the record exists even when nobody thought to save the log.
CREATE TABLE IF NOT EXISTS diagnostics (
    id           TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    -- When it happened, from the phone, and when it arrived here. A record queued in a garage with
    -- no signal can arrive a day later; both are kept because which one matters depends on the
    -- question.
    created_at   INTEGER NOT NULL,
    received_at  INTEGER NOT NULL,
    -- Which operation failed, named by the app (CONNECT, IDENT, BACKUP, VERIFY, RUN ...), and what
    -- the error said.
    stage        TEXT NOT NULL,
    error        TEXT NOT NULL,
    -- The tail of the event log at the moment of failure.
    log_excerpt  TEXT,
    app_build    TEXT,
    -- 1 when the failure was against the simulator. Practice failures mixed in unmarked with real
    -- ones would make the list worse than no list.
    practice     INTEGER,
    ident        TEXT,
    run_id       TEXT,
    user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS diagnostics_owner_created_at ON diagnostics (owner, created_at DESC);
