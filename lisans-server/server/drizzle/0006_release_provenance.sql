ALTER TABLE releases ADD COLUMN source_commit text;
ALTER TABLE releases ADD COLUMN ci_run text;
ALTER TABLE releases ADD COLUMN tests_passed boolean NOT NULL DEFAULT false;
ALTER TABLE releases ADD CONSTRAINT releases_source_commit_ck CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$');
