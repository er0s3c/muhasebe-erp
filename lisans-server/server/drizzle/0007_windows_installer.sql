ALTER TABLE releases ADD COLUMN installer_file jsonb;
ALTER TABLE releases ADD COLUMN installer_signature text;
