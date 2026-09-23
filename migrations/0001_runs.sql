-- One real-car session: the capture, the log, and the facts that decide how to read them.
--
-- The scalars are not decoration. A 1 MiB blob on its own is evidence of nothing; whether the
-- login was granted, whether the two passes agreed, and whether the screen went to the background
-- are what say how much weight the bytes carry. They are columns rather than JSON so they can be
-- filtered and compared across sessions without inflating a row to read one of them.
CREATE TABLE IF NOT EXISTS runs (
    id                TEXT PRIMARY KEY,
    -- When the session happened, from the phone. `uploaded_at` is when it reached here; on a phone
    -- in a garage those can be minutes or a day apart, and which one is wanted differs by question.
    created_at        INTEGER NOT NULL,
    uploaded_at       INTEGER NOT NULL,
    label             TEXT NOT NULL,
    app_build         TEXT,

    ident             TEXT,
    master_flavour    TEXT,
    master_crc        TEXT,
    master_crc_valid  INTEGER,
    slave_flavour     TEXT,
    slave_crc         TEXT,
    slave_crc_valid   INTEGER,

    -- Whether cmd 0x90 was accepted. The linear 24-bit read segments are gated on an access bit it
    -- grants, so a capture taken without it should not exist - and if one does, that is the finding.
    logged_in         INTEGER,
    -- Whether the two passes agreed with each other, and by how much they did not.
    verified          INTEGER,
    differing_count   INTEGER,
    -- Whether 0x4000-0x4017 came back entirely 0xFF. The firmware substitutes 0xFF for reads of
    -- that range; seeing it in a real capture is independent confirmation of the disassembly.
    censored_blank    INTEGER,

    elapsed_seconds   REAL,
    -- Whether the page was backgrounded mid-transfer. It does not invalidate a capture, but it is
    -- the first thing to suspect when the two passes disagree.
    went_hidden       INTEGER,
    user_agent        TEXT,
    note              TEXT,

    image_gz          BLOB,
    log_gz            BLOB
);

-- The only ordering the listing uses.
CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at DESC);
