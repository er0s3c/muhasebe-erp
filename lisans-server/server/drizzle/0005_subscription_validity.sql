ALTER TABLE licenses ADD COLUMN validity_mode text NOT NULL DEFAULT 'lease';
ALTER TABLE licenses ADD CONSTRAINT licenses_validity_mode_ck CHECK (validity_mode IN ('lease', 'subscription'));
