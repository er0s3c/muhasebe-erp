ALTER TABLE manufacturing_records DROP CONSTRAINT manufacturing_records_kind_check;
ALTER TABLE manufacturing_records ADD CONSTRAINT manufacturing_records_kind_check CHECK(kind IN ('resource','calendar','maintenance','schedule','transfer','bin','lot','lot_event','placement','shipment','connection','integration_event','demo_dataset','department','custom_field','attendance'));
