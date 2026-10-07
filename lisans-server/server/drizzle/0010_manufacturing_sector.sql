ALTER TABLE licenses DROP CONSTRAINT licenses_sectors_ck;
ALTER TABLE licenses ADD CONSTRAINT licenses_sectors_ck CHECK(cardinality(sectors)>=1 AND sectors <@ ARRAY['CONSTRUCTION','RETAIL_MARKET','COMMERCE','LEATHER_FASHION','MANUFACTURING_WHOLESALE']::text[]);
